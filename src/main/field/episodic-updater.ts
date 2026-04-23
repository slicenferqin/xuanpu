/**
 * Episodic Memory Updater — Phase 22B.1
 *
 * Orchestrates the compaction of per-worktree rolling summaries. Listens to
 * the field event bus and triggers a compaction when meaningful thresholds
 * are crossed, with a debounce to coalesce burst activity (e.g. drag-select).
 *
 * Key design decisions (per oracle review):
 *   - Real debounce via per-worktree state machine (NOT just a Promise map)
 *   - file.selection events are EXCLUDED from the event counter (drag storm)
 *   - "Don't downgrade" policy: never overwrite a higher-priority compactor
 *     output with a lower-priority one
 *   - Pre-write validation: summaries that look malformed don't replace old ones
 *   - Explicit shutdown: clear timers, stop responding to events, don't block quit
 *   - Privacy gate: respects `isFieldCollectionEnabled()` at every entry point
 *   - Logging: metadata at info, body only behind XUANPU_FIELD_DEBUG_BODIES
 *     with simple secret redaction
 */
import { getDatabase } from '../db'
import { getEventBus } from '../../server/event-bus'
import { createLogger } from '../services/logger'
import { isFieldCollectionEnabled } from './privacy'
import { getFieldEventSink } from './sink'
import { getRecentFieldEvents } from './repository'
import {
  RuleBasedCompactor,
  InsufficientEventsError,
  type EpisodicCompactor,
  type CompactionOutput
} from './episodic-compactor'
import type { FieldEvent } from '../../shared/types'

const log = createLogger({ component: 'EpisodicMemoryUpdater' })

// ---------------------------------------------------------------------------
// Tunables (module-level consts for test override access)
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 8_000
const PERIODIC_SWEEP_MS = 30 * 60_000
const STALE_THRESHOLD_MS = 2 * 60 * 60_000 // summary > 2h old counts as stale
const COMPACTION_WINDOW_MS = 6 * 60 * 60_000 // include last 6h of events
const MIN_EVENTS_BEFORE_TRIGGER = 20
const MIN_AGE_BEFORE_TRIGGER_MS = 10 * 60_000 // 10 min since last compaction

const COMPACTOR_PRIORITY: Record<string, number> = {
  'claude-haiku': 2,
  'rule-based': 1
}

// ---------------------------------------------------------------------------
// Per-worktree state
// ---------------------------------------------------------------------------

interface WorktreeState {
  dirty: boolean
  scheduled: ReturnType<typeof setTimeout> | null
  inFlight: Promise<void> | null
  eventsSinceCompaction: number
}

function initState(): WorktreeState {
  return {
    dirty: false,
    scheduled: null,
    inFlight: null,
    eventsSinceCompaction: 0
  }
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

export interface EpisodicUpdaterCounters {
  compactions_attempted: number
  compactions_written: number
  compactions_skipped_insufficient: number
  compactions_skipped_downgrade: number
  compactions_skipped_invalid: number
  compactions_failed: number
  compactions_skipped_privacy: number
  last_compaction_at: number
}

// ---------------------------------------------------------------------------
// Updater
// ---------------------------------------------------------------------------

class EpisodicMemoryUpdater {
  private states = new Map<string, WorktreeState>()
  private periodicTimer: ReturnType<typeof setInterval> | null = null
  private unsubscribeEmit: (() => void) | null = null
  private isShuttingDown = false
  private compactor: EpisodicCompactor

  private counters: EpisodicUpdaterCounters = {
    compactions_attempted: 0,
    compactions_written: 0,
    compactions_skipped_insufficient: 0,
    compactions_skipped_downgrade: 0,
    compactions_skipped_invalid: 0,
    compactions_failed: 0,
    compactions_skipped_privacy: 0,
    last_compaction_at: 0
  }

  constructor(
    compactor: EpisodicCompactor = new RuleBasedCompactor(),
    private readonly debounceMs = DEBOUNCE_MS
  ) {
    this.compactor = compactor
    this.start()
  }

  /** Start listening to the event bus and register the periodic sweep. */
  start(): void {
    const bus = getEventBus()
    const listener = (event: FieldEvent): void => {
      try {
        this.onEmit(event)
      } catch (err) {
        log.warn('onEmit failed', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    bus.on('field:event', listener)
    this.unsubscribeEmit = () => bus.off('field:event', listener)

    this.periodicTimer = setInterval(() => {
      if (this.isShuttingDown) return
      this.onPeriodicSweep().catch((err) => {
        log.warn('periodic sweep failed', {
          error: err instanceof Error ? err.message : String(err)
        })
      })
    }, PERIODIC_SWEEP_MS)
  }

  /**
   * Explicitly shutdown. Clears timers, stops the emit listener, and refuses
   * to start new compactions. In-flight compactions are NOT awaited — letting
   * the process teardown handle them is acceptable (episodic memory is not
   * critical data; losing one update is fine).
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true

    for (const state of this.states.values()) {
      if (state.scheduled) {
        clearTimeout(state.scheduled)
        state.scheduled = null
      }
    }

    if (this.periodicTimer) {
      clearInterval(this.periodicTimer)
      this.periodicTimer = null
    }

    if (this.unsubscribeEmit) {
      this.unsubscribeEmit()
      this.unsubscribeEmit = null
    }
  }

  getCounters(): EpisodicUpdaterCounters {
    return { ...this.counters }
  }

  /**
   * Force a compaction for testing / dump tooling. Bypasses the debounce
   * but still respects the privacy gate and the "don't downgrade" rule.
   */
  async forceCompact(worktreeId: string): Promise<CompactionOutput | null> {
    if (this.isShuttingDown) return null
    if (!isFieldCollectionEnabled()) {
      this.counters.compactions_skipped_privacy++
      return null
    }
    return this.runCompact(worktreeId)
  }

  // -------------------------------------------------------------------------
  // Event handling
  // -------------------------------------------------------------------------

  private onEmit(event: FieldEvent): void {
    if (this.isShuttingDown) return
    if (!isFieldCollectionEnabled()) return
    if (!event.worktreeId) return

    // Drag-select storm protection: file.selection does NOT count toward the
    // threshold. A long selection drag would otherwise trigger compaction
    // dozens of times in seconds.
    if (event.type === 'file.selection') return

    const state = this.getOrInit(event.worktreeId)
    state.eventsSinceCompaction++

    if (state.eventsSinceCompaction < MIN_EVENTS_BEFORE_TRIGGER) return

    const existing = getDatabase().getEpisodicMemory(event.worktreeId)
    const tooSoon =
      existing && Date.now() - existing.compactedAt < MIN_AGE_BEFORE_TRIGGER_MS
    if (tooSoon) return

    this.schedule(event.worktreeId)
  }

  private async onPeriodicSweep(): Promise<void> {
    if (!isFieldCollectionEnabled()) return

    // Get all worktrees with recent events and check if their summary is stale.
    // Use the field_events index on worktree_id + timestamp.
    const dbHandle = getDatabase().getDbHandle()
    const since = Date.now() - 24 * 60 * 60_000
    const rows = dbHandle
      .prepare(
        `SELECT DISTINCT worktree_id FROM field_events
         WHERE worktree_id IS NOT NULL AND timestamp >= ?`
      )
      .all(since) as Array<{ worktree_id: string }>

    for (const { worktree_id } of rows) {
      if (this.isShuttingDown) break
      const existing = getDatabase().getEpisodicMemory(worktree_id)
      const isStale =
        !existing || Date.now() - existing.compactedAt > STALE_THRESHOLD_MS
      if (isStale) this.schedule(worktree_id)
    }
  }

  private schedule(worktreeId: string): void {
    if (this.isShuttingDown) return
    const state = this.getOrInit(worktreeId)
    state.dirty = true

    if (state.inFlight || state.scheduled) return

    state.scheduled = setTimeout(() => {
      state.scheduled = null
      if (this.isShuttingDown) return
      state.inFlight = this.runCompact(worktreeId)
        .catch((err) => {
          log.warn('compaction promise rejected', {
            worktreeId,
            error: err instanceof Error ? err.message : String(err)
          })
          return null
        })
        .then(() => {
          state.inFlight = null
          if (state.dirty && !this.isShuttingDown) {
            this.schedule(worktreeId)
          }
        })
    }, this.debounceMs)
  }

  // -------------------------------------------------------------------------
  // Compaction
  // -------------------------------------------------------------------------

  private async runCompact(worktreeId: string): Promise<CompactionOutput | null> {
    const state = this.getOrInit(worktreeId)
    // Reset dirty BEFORE starting; if new events come in during compaction,
    // schedule() will set dirty back to true and trigger another round.
    state.dirty = false
    state.eventsSinceCompaction = 0

    this.counters.compactions_attempted++

    const db = getDatabase()
    const worktree = db.getWorktree(worktreeId)
    if (!worktree) return null // silently skip unknown worktrees

    // "Don't downgrade" check
    const existing = db.getEpisodicMemory(worktreeId)
    const currentPriority = COMPACTOR_PRIORITY[this.compactor.id] ?? 0
    if (existing) {
      const existingPriority = COMPACTOR_PRIORITY[existing.compactorId] ?? 0
      if (existingPriority > currentPriority) {
        log.debug('skip: existing summary has higher priority', {
          worktreeId,
          existing: existing.compactorId,
          current: this.compactor.id
        })
        this.counters.compactions_skipped_downgrade++
        return null
      }
    }

    // Ensure the latest events are persisted before we read them.
    try {
      await getFieldEventSink().flushNow()
    } catch (err) {
      log.warn('flushNow failed before compaction; continuing with possibly stale data', {
        worktreeId,
        error: err instanceof Error ? err.message : String(err)
      })
    }

    const until = Date.now()
    const since = until - COMPACTION_WINDOW_MS
    const events = getRecentFieldEvents({
      worktreeId,
      since,
      limit: 1000,
      order: 'asc'
    })

    const startedAt = Date.now()
    let output: CompactionOutput
    try {
      output = await this.compactor.compact({
        worktreeId,
        worktreeName: worktree.name,
        branchName: worktree.branch_name ?? null,
        events,
        since,
        until
      })
    } catch (err) {
      if (err instanceof InsufficientEventsError) {
        this.counters.compactions_skipped_insufficient++
        return null
      }
      this.counters.compactions_failed++
      log.warn('compactor threw', {
        worktreeId,
        compactor: this.compactor.id,
        error: err instanceof Error ? err.message : String(err)
      })
      return null
    }

    if (!this.isValidOutput(output)) {
      this.counters.compactions_skipped_invalid++
      log.warn('compactor produced invalid output; keeping existing summary', {
        worktreeId,
        compactor: this.compactor.id
      })
      return null
    }

    const durationMs = Date.now() - startedAt

    db.upsertEpisodicMemory({
      worktreeId,
      summaryMarkdown: output.markdown,
      compactorId: output.compactorId,
      version: output.version,
      compactedAt: Date.now(),
      sourceEventCount: events.length,
      sourceSince: since,
      sourceUntil: until
    })

    this.counters.compactions_written++
    this.counters.last_compaction_at = Date.now()

    log.info('Episodic compaction written', {
      worktreeId,
      eventCount: events.length,
      durationMs,
      compactorId: output.compactorId,
      version: output.version,
      chars: output.markdown.length
    })

    if (process.env.XUANPU_FIELD_DEBUG_BODIES === 'true') {
      log.debug('Episodic compaction body', { body: redactSecrets(output.markdown) })
    }

    return output
  }

  private isValidOutput(output: CompactionOutput): boolean {
    if (!output || typeof output.markdown !== 'string') return false
    if (output.markdown.trim().length < 20) return false
    if (output.markdown.length > 10_000) return false
    if (typeof output.compactorId !== 'string' || output.compactorId.length === 0) return false
    if (typeof output.version !== 'number' || !Number.isInteger(output.version)) return false
    return true
  }

  private getOrInit(worktreeId: string): WorktreeState {
    let state = this.states.get(worktreeId)
    if (!state) {
      state = initState()
      this.states.set(worktreeId, state)
    }
    return state
  }
}

// ---------------------------------------------------------------------------
// Secret redaction (conservative line-level replacement)
// ---------------------------------------------------------------------------

const SECRET_LINE_REGEX = /(api[_-]?key|password|token|secret|authorization|bearer)/i

function redactSecrets(s: string): string {
  return s
    .split('\n')
    .map((line) => (SECRET_LINE_REGEX.test(line) ? '[REDACTED LINE]' : line))
    .join('\n')
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: EpisodicMemoryUpdater | null = null

export function getEpisodicMemoryUpdater(): EpisodicMemoryUpdater {
  if (!instance) {
    instance = new EpisodicMemoryUpdater()
  }
  return instance
}

/** Test helper: replace the singleton with a fresh instance (optionally with a mock compactor). */
export function resetEpisodicMemoryUpdaterForTest(compactor?: EpisodicCompactor): EpisodicMemoryUpdater {
  if (instance) {
    void instance.shutdown()
  }
  instance = new EpisodicMemoryUpdater(compactor)
  return instance
}

// Re-export tunables for tests
export const __UPDATER_TUNABLES_FOR_TEST = {
  DEBOUNCE_MS,
  PERIODIC_SWEEP_MS,
  STALE_THRESHOLD_MS,
  COMPACTION_WINDOW_MS,
  MIN_EVENTS_BEFORE_TRIGGER,
  MIN_AGE_BEFORE_TRIGGER_MS,
  COMPACTOR_PRIORITY,
  redactSecrets
}

export { EpisodicMemoryUpdater }
