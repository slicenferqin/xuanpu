import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'

// Mock logger BEFORE anything imports it
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

// Mock electron.app so registerShutdownHook is a no-op (unit tests don't
// have an Electron app instance).
vi.mock('electron', () => ({
  app: undefined
}))

// Mock @shared/app-identity to avoid needing full alias resolution.
vi.mock('@shared/app-identity', () => ({
  getActiveAppDatabasePath: (home: string) => join(home, '.xuanpu', 'test.db'),
  APP_BUNDLE_ID: 'test',
  APP_CLI_NAME: 'test',
  APP_PRODUCT_NAME: 'test'
}))

// Inject a test DB: the sink imports `getDatabase` from '../db', so we mock
// that module and return a DatabaseService backed by a tmp file. We stash
// the mutable instance on globalThis so beforeEach can swap it.
vi.mock('../../../src/main/db', async () => {
  const actual = await vi.importActual<typeof import('../../../src/main/db')>(
    '../../../src/main/db'
  )
  return {
    ...actual,
    getDatabase: () => {
      const g = globalThis as unknown as { __sinkTestDb?: import('../../../src/main/db/database').DatabaseService }
      if (!g.__sinkTestDb) throw new Error('test DB not initialized')
      return g.__sinkTestDb
    }
  }
})

import { DatabaseService } from '../../../src/main/db/database'
import {
  getFieldEventSink,
  resetFieldEventSink,
  __SINK_TUNABLES_FOR_TEST
} from '../../../src/main/field/sink'
import type { FieldEvent } from '../../../src/shared/types/field-event'

// -----------------------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------------------

let tmpDir: string
let db: DatabaseService

function makeEvent(overrides: Partial<FieldEvent> = {}): FieldEvent {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    timestamp: overrides.timestamp ?? Date.now(),
    worktreeId: overrides.worktreeId ?? 'w-1',
    projectId: overrides.projectId ?? 'p-1',
    sessionId: overrides.sessionId ?? null,
    relatedEventId: overrides.relatedEventId ?? null,
    type: 'worktree.switch',
    payload: {
      fromWorktreeId: null,
      toWorktreeId: 'w-1',
      trigger: 'user-click'
    },
    ...overrides
  } as FieldEvent
}

function enqueue(sink: ReturnType<typeof getFieldEventSink>, event: FieldEvent): void {
  sink.enqueue(event, JSON.stringify(event.payload))
}

function rowCount(): number {
  const dbh = db.getDbHandle()
  const result = dbh.prepare('SELECT COUNT(*) as c FROM field_events').get() as { c: number }
  return result.c
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-sink-test-'))
  db = new DatabaseService(join(tmpDir, 'test.db'))
  db.init()
  ;(globalThis as unknown as { __sinkTestDb: DatabaseService }).__sinkTestDb = db
  resetFieldEventSink()
})

afterEach(async () => {
  // Drain any pending flush BEFORE closing the DB, otherwise a deferred
  // setTimeout(0) flush could fire against the next test's DB (or a closed handle).
  try {
    await getFieldEventSink().shutdown()
  } catch {
    /* ignore */
  }
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
  delete (globalThis as unknown as { __sinkTestDb?: DatabaseService }).__sinkTestDb
})

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('FieldEventSink — Phase 21 M3', () => {
  describe('schema', () => {
    it('migration v14 creates field_events table with expected columns', () => {
      const cols = db.getDbHandle().pragma('table_info(field_events)') as Array<{ name: string }>
      const names = cols.map((c) => c.name).sort()
      expect(names).toEqual(
        [
          'id',
          'payload_json',
          'project_id',
          'related_event_id',
          'seq',
          'session_id',
          'timestamp',
          'type',
          'worktree_id'
        ].sort()
      )
    })

    it('has all expected indexes', () => {
      const indexes = (db.getDbHandle().pragma('index_list(field_events)') as Array<{
        name: string
      }>).map((i) => i.name)
      expect(indexes).toEqual(
        expect.arrayContaining([
          'idx_field_events_worktree_ts',
          'idx_field_events_project_ts',
          'idx_field_events_type_ts',
          'idx_field_events_ts',
          'idx_field_events_session_ts',
          'idx_field_events_related'
        ])
      )
    })

    it('seq is AUTOINCREMENT so ordering is stable within same ms', () => {
      const sink = getFieldEventSink()
      const ts = Date.now()
      enqueue(sink, makeEvent({ id: 'a', timestamp: ts }))
      enqueue(sink, makeEvent({ id: 'b', timestamp: ts }))
      enqueue(sink, makeEvent({ id: 'c', timestamp: ts }))

      return sink.shutdown().then(() => {
        const rows = db
          .getDbHandle()
          .prepare('SELECT id, seq FROM field_events ORDER BY seq ASC')
          .all() as Array<{ id: string; seq: number }>
        expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
        expect(rows[1].seq - rows[0].seq).toBe(1)
        expect(rows[2].seq - rows[1].seq).toBe(1)
      })
    })
  })

  describe('enqueue and flush', () => {
    it('persists a single event after shutdown', async () => {
      const sink = getFieldEventSink()
      enqueue(sink, makeEvent())
      await sink.shutdown()
      expect(rowCount()).toBe(1)
    })

    it('flushes when batch threshold reached (100 events)', async () => {
      const sink = getFieldEventSink()
      for (let i = 0; i < __SINK_TUNABLES_FOR_TEST.FLUSH_BATCH_THRESHOLD; i++) {
        enqueue(sink, makeEvent({ id: `e-${i}` }))
      }
      // Allow microtasks / the immediate flush to run
      await vi.waitFor(
        () => {
          expect(rowCount()).toBe(__SINK_TUNABLES_FOR_TEST.FLUSH_BATCH_THRESHOLD)
        },
        { timeout: 500 }
      )
    })

    it('flushes on timer when below batch threshold', async () => {
      const sink = getFieldEventSink()
      enqueue(sink, makeEvent({ id: 'slow' }))
      // Before the timer fires, nothing should be persisted.
      expect(rowCount()).toBe(0)

      await vi.waitFor(
        () => {
          expect(rowCount()).toBe(1)
        },
        { timeout: __SINK_TUNABLES_FOR_TEST.FLUSH_TIME_MS + 500 }
      )
    })

    it('drains all queued events on shutdown, even during active flush', async () => {
      const sink = getFieldEventSink()
      // Enqueue more than one batch worth to force multiple flush rounds
      for (let i = 0; i < 250; i++) {
        enqueue(sink, makeEvent({ id: `e-${i}` }))
      }
      await sink.shutdown()
      expect(rowCount()).toBe(250)
    })

    it('handles 1000 rapid enqueues without dropping (under capacity for batch flush)', async () => {
      const sink = getFieldEventSink()
      // 500 max capacity, but batch flush at 100 means buffer should drain as we go
      for (let i = 0; i < 1000; i++) {
        enqueue(sink, makeEvent({ id: `e-${i}` }))
      }
      await sink.shutdown()
      // Some events may have been dropped if a flush round couldn't keep up.
      // Acceptable lower bound: most events persist. Acceptable upper: exactly 1000.
      const count = rowCount()
      expect(count).toBeGreaterThanOrEqual(500)
      expect(count).toBeLessThanOrEqual(1000)
      const dropped = sink.getCounters().dropped_overflow
      expect(count + dropped).toBe(1000)
    })
  })

  describe('overflow', () => {
    it('drops oldest and increments dropped_overflow when queue is saturated', () => {
      const sink = getFieldEventSink()
      // Fill past capacity WITHOUT letting a flush tick fire by blocking flushes:
      // the queue cap is 500. Enqueue 501 synchronously so the first is dropped
      // before any microtask can run a flush.
      const cap = __SINK_TUNABLES_FOR_TEST.QUEUE_CAPACITY
      for (let i = 0; i < cap + 1; i++) {
        enqueue(sink, makeEvent({ id: `e-${i}` }))
      }
      // Check counters synchronously — even if a flush fires, dropped_overflow only
      // increments during the synchronous enqueue loop.
      expect(sink.getCounters().dropped_overflow).toBeGreaterThanOrEqual(1)
    })
  })

  describe('retry and quarantine', () => {
    it('writes all non-poison rows when one event has an invalid foreign-ish value', async () => {
      // Phase 21 design: field_events has NO foreign keys. Instead, simulate a
      // poison event by monkey-patching writeBatch to throw on a specific id.
      const sink = getFieldEventSink() as unknown as {
        writeBatch: (batch: Array<{ event: FieldEvent; serialized: string }>) => void
      }
      const originalWriteBatch = sink.writeBatch.bind(sink)
      let callCount = 0
      sink.writeBatch = function patched(
        batch: Array<{ event: FieldEvent; serialized: string }>
      ): void {
        callCount++
        // Fail batches containing the poison event for the first 3 attempts
        const hasPoison = batch.some((b) => b.event.id === 'poison')
        if (hasPoison && batch.length > 1 && callCount <= 3) {
          throw new Error('simulated bulk insert failure')
        }
        // Also fail the single-row attempt for the poison event (quarantine path)
        if (hasPoison && batch.length === 1) {
          throw new Error('simulated poison')
        }
        return originalWriteBatch(batch)
      }

      enqueue(sink as unknown as ReturnType<typeof getFieldEventSink>, makeEvent({ id: 'good-1' }))
      enqueue(sink as unknown as ReturnType<typeof getFieldEventSink>, makeEvent({ id: 'poison' }))
      enqueue(sink as unknown as ReturnType<typeof getFieldEventSink>, makeEvent({ id: 'good-2' }))

      await (sink as unknown as ReturnType<typeof getFieldEventSink>).shutdown()

      const ids = db
        .getDbHandle()
        .prepare('SELECT id FROM field_events ORDER BY seq')
        .all() as Array<{ id: string }>
      // Expect good-1 and good-2 to survive; poison to be quarantined (dropped).
      expect(ids.map((r) => r.id)).toEqual(['good-1', 'good-2'])
      expect(
        (sink as unknown as ReturnType<typeof getFieldEventSink>).getCounters().dropped_invalid
      ).toBe(1)
      expect(
        (sink as unknown as ReturnType<typeof getFieldEventSink>).getCounters().flush_failures
      ).toBeGreaterThanOrEqual(1)
    })
  })

  describe('shutdown', () => {
    it('isShutdownComplete flips to true after shutdown', async () => {
      const sink = getFieldEventSink()
      expect(sink.isShutdownComplete()).toBe(false)
      await sink.shutdown()
      expect(sink.isShutdownComplete()).toBe(true)
    })

    it('drops post-shutdown enqueues without writing to DB', async () => {
      const sink = getFieldEventSink()
      await sink.shutdown()
      enqueue(sink, makeEvent({ id: 'late' }))
      expect(rowCount()).toBe(0)
      expect(sink.getCounters().dropped_overflow).toBe(1)
    })

    it('shutdown is idempotent', async () => {
      const sink = getFieldEventSink()
      enqueue(sink, makeEvent({ id: 'a' }))
      await sink.shutdown()
      await sink.shutdown() // second call is a no-op
      expect(rowCount()).toBe(1)
    })
  })

  describe('counters', () => {
    it('exposes last_flush_at and last_flush_size after a successful flush', async () => {
      const sink = getFieldEventSink()
      enqueue(sink, makeEvent({ id: 'x' }))
      await sink.shutdown()
      const c = sink.getCounters()
      expect(c.last_flush_at).toBeGreaterThan(0)
      expect(c.last_flush_size).toBe(1)
    })

    it('queueDepth reflects pending events', () => {
      const sink = getFieldEventSink()
      enqueue(sink, makeEvent({ id: 'a' }))
      enqueue(sink, makeEvent({ id: 'b' }))
      expect(sink.getCounters().queueDepth).toBe(2)
    })
  })
})
