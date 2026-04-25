/**
 * FieldEventSink — Phase 21
 *
 * Async batched persistence for field events.
 * See docs/prd/phase-21-field-events.md §3.
 *
 * Design invariants:
 *   - One flush at a time, tracked via `currentFlushPromise` (not just a boolean).
 *   - Single `flushTimer`; always cleared before scheduling a new one.
 *   - Drain loop: after each flush completes, if queue is non-empty, schedule again.
 *   - Failed batches are retained for retry; never silently lost.
 *   - After 3 batch failures, quarantine: write rows one-by-one to isolate poison.
 *   - Serialization happens at enqueue time (in emitFieldEvent), so flush itself
 *     cannot fail due to bad payloads.
 *   - `shutdown()` awaits in-flight flush, drains queue, then resolves. Called
 *     from app `before-quit` with `preventDefault()`.
 */
import { app } from 'electron'
import type Database from 'better-sqlite3'
import { getDatabase } from '../db'
import { createLogger } from '../services/logger'
import type { FieldEvent } from '../../shared/types'

const log = createLogger({ component: 'FieldEventSink' })

// ---------------------------------------------------------------------------
// Tunables (kept as module-level consts for ease of test override)
// ---------------------------------------------------------------------------

const QUEUE_CAPACITY = 500
const FLUSH_BATCH_THRESHOLD = 100
const FLUSH_TIME_MS = 1000
const MAX_RETRY_ATTEMPTS = 3
const RETRY_BACKOFF_BASE_MS = 1000
const RETRY_BACKOFF_MAX_MS = 30_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueuedEvent {
  event: FieldEvent
  serialized: string
}

export interface SinkCounters {
  dropped_overflow: number
  dropped_invalid: number
  dropped_privacy: number
  flush_failures: number
  last_flush_at: number
  last_flush_size: number
  queueDepth: number
}

export type SinkCounterKey = Exclude<keyof SinkCounters, 'queueDepth'>

// ---------------------------------------------------------------------------
// Sink class
// ---------------------------------------------------------------------------

class FieldEventSink {
  private queue: QueuedEvent[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private currentFlushPromise: Promise<void> | null = null

  // Retry state — set when a flush fails; cleared on success or after quarantine.
  private retryBatch: QueuedEvent[] | null = null
  private retryAttempts = 0

  // Shutdown state
  private shutdownRequested = false
  private shutdownComplete = false

  private counters: Omit<SinkCounters, 'queueDepth'> = {
    dropped_overflow: 0,
    dropped_invalid: 0,
    dropped_privacy: 0,
    flush_failures: 0,
    last_flush_at: 0,
    last_flush_size: 0
  }

  // Cached prepared statement — initialized on first writeBatch.
  private insertStmt: Database.Statement | null = null

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  enqueue(event: FieldEvent, serialized: string): void {
    if (this.shutdownComplete) {
      // Accept-after-shutdown: drop and count. Indicates a logic error upstream.
      this.counters.dropped_overflow++
      return
    }

    if (this.queue.length >= QUEUE_CAPACITY) {
      this.queue.shift() // drop oldest
      this.counters.dropped_overflow++
    }
    this.queue.push({ event, serialized })

    // Schedule flush: immediately if batch full, else timer-based.
    if (this.queue.length >= FLUSH_BATCH_THRESHOLD) {
      this.scheduleFlush(0)
    } else if (!this.flushTimer && !this.currentFlushPromise) {
      this.scheduleFlush(FLUSH_TIME_MS)
    }
    // If flush already in progress, the post-flush drain loop will pick up new events.
  }

  incrementCounter(key: SinkCounterKey): void {
    this.counters[key]++
  }

  getCounters(): SinkCounters {
    return { ...this.counters, queueDepth: this.queue.length }
  }

  isShutdownComplete(): boolean {
    return this.shutdownComplete
  }

  /**
   * Drain all currently queued events, waiting for any in-flight flush first.
   * Unlike shutdown(), this does NOT mark the sink as shut down — more events
   * can be enqueued after this resolves.
   *
   * Use case: callers that need to read-after-write (e.g. the Phase 22A
   * context builder that queries field_events right after terminal output
   * was emitted — without this, the latest output might still be in the
   * in-memory queue, not in the DB).
   */
  async flushNow(): Promise<void> {
    if (this.shutdownComplete) return // nothing to do
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    while (this.currentFlushPromise || this.queue.length > 0 || this.retryBatch) {
      if (this.currentFlushPromise) {
        try {
          await this.currentFlushPromise
        } catch {
          /* flush() never rejects; this is defensive */
        }
      } else {
        await this.flush()
      }
    }
  }

  /**
   * Drain everything and stop accepting. Called from app `before-quit`.
   * Returns when all queued + retry events are persisted (or quarantined).
   */
  async shutdown(): Promise<void> {
    if (this.shutdownComplete) return
    this.shutdownRequested = true

    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }

    // Drain loop: keep flushing until nothing remains.
    while (this.currentFlushPromise || this.queue.length > 0 || this.retryBatch) {
      if (this.currentFlushPromise) {
        try {
          await this.currentFlushPromise
        } catch {
          // flush() never rejects; this is just defensive
        }
      } else {
        await this.flush()
      }
    }

    this.shutdownComplete = true
    log.info('shutdown complete', this.counters)
  }

  // -------------------------------------------------------------------------
  // Internal — scheduling
  // -------------------------------------------------------------------------

  private scheduleFlush(delayMs: number): void {
    if (this.currentFlushPromise) return // flush already running; drain loop handles next round
    if (this.flushTimer) {
      // If we already have a slow timer pending and now want an immediate flush
      // (batch full), upgrade to immediate. Otherwise keep the existing timer.
      if (delayMs === 0) {
        clearTimeout(this.flushTimer)
        this.flushTimer = null
      } else {
        return
      }
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, delayMs)
  }

  /**
   * One flush attempt. Resolves when this attempt's batch is either persisted,
   * quarantined, or scheduled for retry. Never rejects.
   */
  private flush(): Promise<void> {
    if (this.currentFlushPromise) return this.currentFlushPromise

    const promise = this.runFlush().finally(() => {
      this.currentFlushPromise = null
    })
    this.currentFlushPromise = promise
    return promise
  }

  private async runFlush(): Promise<void> {
    // Snapshot: prefer retry batch if present.
    let batch: QueuedEvent[]
    if (this.retryBatch) {
      batch = this.retryBatch
    } else if (this.queue.length > 0) {
      batch = this.queue
      this.queue = []
    } else {
      return // nothing to do
    }

    try {
      this.writeBatch(batch)
      this.counters.last_flush_at = Date.now()
      this.counters.last_flush_size = batch.length
      this.retryBatch = null
      this.retryAttempts = 0
    } catch (err) {
      this.counters.flush_failures++
      log.warn(`flush failed (attempt ${this.retryAttempts + 1}/${MAX_RETRY_ATTEMPTS})`, {
        error: err instanceof Error ? err.message : String(err),
        batchSize: batch.length
      })

      if (this.retryAttempts >= MAX_RETRY_ATTEMPTS - 1) {
        // Quarantine: try one row at a time so a single poison event doesn't
        // hold up the rest of the batch.
        this.quarantineBatch(batch)
        this.retryBatch = null
        this.retryAttempts = 0
      } else {
        this.retryBatch = batch
        this.retryAttempts++
        if (!this.shutdownRequested) {
          // Schedule a retry with backoff (skipped during shutdown — drain loop
          // will keep calling flush() back-to-back instead).
          const delay = Math.min(
            RETRY_BACKOFF_BASE_MS * 2 ** this.retryAttempts,
            RETRY_BACKOFF_MAX_MS
          )
          this.scheduleFlush(delay)
        }
        return // don't trigger drain loop while a retry is pending
      }
    }

    // Drain loop: if new events arrived during this flush, schedule the next round.
    if (this.queue.length > 0 && !this.shutdownRequested) {
      this.scheduleFlush(this.queue.length >= FLUSH_BATCH_THRESHOLD ? 0 : FLUSH_TIME_MS)
    }
  }

  // -------------------------------------------------------------------------
  // Internal — persistence
  // -------------------------------------------------------------------------

  private writeBatch(batch: QueuedEvent[]): void {
    const db = getDatabase().getDbHandle()
    if (!this.insertStmt) {
      this.insertStmt = db.prepare(
        `INSERT INTO field_events
          (id, timestamp, worktree_id, project_id, session_id, type, related_event_id, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
    }
    const stmt = this.insertStmt
    const tx = db.transaction((items: QueuedEvent[]) => {
      for (const { event, serialized } of items) {
        stmt.run(
          event.id,
          event.timestamp,
          event.worktreeId,
          event.projectId,
          event.sessionId,
          event.type,
          event.relatedEventId ?? null,
          serialized
        )
      }
    })
    tx(batch)
  }

  private quarantineBatch(batch: QueuedEvent[]): void {
    let written = 0
    let dropped = 0
    for (const item of batch) {
      try {
        this.writeBatch([item])
        written++
      } catch (err) {
        dropped++
        this.counters.dropped_invalid++
        log.warn('quarantined poison event', {
          id: item.event.id,
          type: item.event.type,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    log.warn('quarantine complete', { batchSize: batch.length, written, dropped })
  }
}

// ---------------------------------------------------------------------------
// Singleton + bootstrap
// ---------------------------------------------------------------------------

let instance: FieldEventSink | null = null
let beforeQuitRegistered = false

/**
 * Get the singleton sink. The first call lazily constructs the sink AND
 * registers the `before-quit` shutdown hook (eager wrt the singleton, lazy
 * wrt module load). Call this once during app bootstrap so the hook is
 * always present before the user can quit.
 */
export function getFieldEventSink(): FieldEventSink {
  if (!instance) {
    instance = new FieldEventSink()
    registerShutdownHook(instance)
  }
  return instance
}

function registerShutdownHook(sink: FieldEventSink): void {
  if (beforeQuitRegistered) return
  // `app` is undefined in non-Electron test contexts; guard so unit tests don't blow up.
  if (typeof app === 'undefined' || !app || typeof app.on !== 'function') return

  beforeQuitRegistered = true
  app.on('before-quit', (event) => {
    if (sink.isShutdownComplete()) return
    event.preventDefault()
    sink.shutdown().finally(() => {
      // Re-trigger quit; the hook will see isShutdownComplete() === true and pass through.
      app.quit()
    })
  })
}

/** Test helper: reset singleton between tests. Does not clear the before-quit hook. */
export function resetFieldEventSink(): void {
  instance = null
}

// Re-export tunables for tests that want to verify thresholds.
export const __SINK_TUNABLES_FOR_TEST = {
  QUEUE_CAPACITY,
  FLUSH_BATCH_THRESHOLD,
  FLUSH_TIME_MS,
  MAX_RETRY_ATTEMPTS
}
