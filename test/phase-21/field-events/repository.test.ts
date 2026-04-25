import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('electron', () => ({
  app: undefined
}))

vi.mock('@shared/app-identity', () => ({
  getActiveAppDatabasePath: (home: string) => join(home, '.xuanpu', 'test.db'),
  APP_BUNDLE_ID: 'test',
  APP_CLI_NAME: 'test',
  APP_PRODUCT_NAME: 'test'
}))

vi.mock('../../../src/main/db', async () => {
  const actual = await vi.importActual<typeof import('../../../src/main/db')>(
    '../../../src/main/db'
  )
  return {
    ...actual,
    getDatabase: () => {
      const g = globalThis as unknown as {
        __sinkTestDb?: import('../../../src/main/db/database').DatabaseService
      }
      if (!g.__sinkTestDb) throw new Error('test DB not initialized')
      return g.__sinkTestDb
    }
  }
})

import { DatabaseService } from '../../../src/main/db/database'
import {
  getFieldEventSink,
  resetFieldEventSink
} from '../../../src/main/field/sink'
import {
  getRecentFieldEvents,
  getFieldEventCounters
} from '../../../src/main/field/repository'
import type { FieldEvent } from '../../../src/shared/types/field-event'

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
    payload: { fromWorktreeId: null, toWorktreeId: 'w-1', trigger: 'user-click' },
    ...overrides
  } as FieldEvent
}

async function persist(events: FieldEvent[]): Promise<void> {
  const sink = getFieldEventSink()
  for (const e of events) sink.enqueue(e, JSON.stringify(e.payload))
  await sink.shutdown()
  resetFieldEventSink()
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-repo-test-'))
  db = new DatabaseService(join(tmpDir, 'test.db'))
  db.init()
  ;(globalThis as unknown as { __sinkTestDb: DatabaseService }).__sinkTestDb = db
  resetFieldEventSink()
})

afterEach(async () => {
  try {
    await getFieldEventSink().shutdown()
  } catch {
    /* noop */
  }
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
  delete (globalThis as unknown as { __sinkTestDb?: DatabaseService }).__sinkTestDb
})

describe('field repository — Phase 21 M9', () => {
  it('returns empty array when DB has no events', () => {
    expect(getRecentFieldEvents()).toEqual([])
  })

  it('returns events ordered by (timestamp DESC, seq DESC) by default', async () => {
    const t = 1_700_000_000_000
    await persist([
      makeEvent({ id: 'a', timestamp: t }),
      makeEvent({ id: 'b', timestamp: t }), // same ms
      makeEvent({ id: 'c', timestamp: t + 100 })
    ])
    const events = getRecentFieldEvents()
    // c is newest by timestamp; a and b share ms but b inserted later (higher seq)
    expect(events.map((e) => e.id)).toEqual(['c', 'b', 'a'])
  })

  it('order: asc reverses the result', async () => {
    const t = 1_700_000_000_000
    await persist([
      makeEvent({ id: 'a', timestamp: t }),
      makeEvent({ id: 'b', timestamp: t + 100 })
    ])
    const events = getRecentFieldEvents({ order: 'asc' })
    expect(events.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('parses payload_json into the typed payload', async () => {
    await persist([makeEvent({ id: 'a' })])
    const [event] = getRecentFieldEvents()
    expect(event.payload).toEqual({
      fromWorktreeId: null,
      toWorktreeId: 'w-1',
      trigger: 'user-click'
    })
  })

  it('filters by worktreeId (string)', async () => {
    await persist([
      makeEvent({ id: 'a', worktreeId: 'w-1' }),
      makeEvent({ id: 'b', worktreeId: 'w-2' })
    ])
    const events = getRecentFieldEvents({ worktreeId: 'w-1' })
    expect(events.map((e) => e.id)).toEqual(['a'])
  })

  it('filters by worktreeId === null', async () => {
    await persist([
      makeEvent({ id: 'a', worktreeId: null }),
      makeEvent({ id: 'b', worktreeId: 'w-1' })
    ])
    const events = getRecentFieldEvents({ worktreeId: null })
    expect(events.map((e) => e.id)).toEqual(['a'])
  })

  it('filters by projectId and sessionId', async () => {
    await persist([
      makeEvent({ id: 'a', projectId: 'p-1', sessionId: 's-1' }),
      makeEvent({ id: 'b', projectId: 'p-1', sessionId: 's-2' }),
      makeEvent({ id: 'c', projectId: 'p-2', sessionId: 's-1' })
    ])
    expect(getRecentFieldEvents({ projectId: 'p-1' }).map((e) => e.id).sort()).toEqual(['a', 'b'])
    expect(getRecentFieldEvents({ sessionId: 's-1' }).map((e) => e.id).sort()).toEqual(['a', 'c'])
  })

  it('filters by type (single)', async () => {
    await persist([
      makeEvent({ id: 'a', type: 'worktree.switch' as const }),
      makeEvent({
        id: 'b',
        type: 'terminal.command' as const,
        payload: { command: 'ls' }
      } as Partial<FieldEvent>)
    ])
    expect(getRecentFieldEvents({ type: 'terminal.command' }).map((e) => e.id)).toEqual(['b'])
  })

  it('filters by type (array)', async () => {
    await persist([
      makeEvent({ id: 'a', type: 'worktree.switch' as const }),
      makeEvent({
        id: 'b',
        type: 'terminal.command' as const,
        payload: { command: 'ls' }
      } as Partial<FieldEvent>),
      makeEvent({
        id: 'c',
        type: 'session.message' as const,
        payload: {
          agentSdk: 'codex',
          agentSessionId: 'a-1',
          text: 'hi',
          attachmentCount: 0
        }
      } as Partial<FieldEvent>)
    ])
    const events = getRecentFieldEvents({
      type: ['terminal.command', 'session.message']
    })
    expect(events.map((e) => e.id).sort()).toEqual(['b', 'c'])
  })

  it('returns [] when type=[]', async () => {
    await persist([makeEvent({ id: 'a' })])
    expect(getRecentFieldEvents({ type: [] })).toEqual([])
  })

  it('respects since (inclusive lower bound)', async () => {
    const t = 1_700_000_000_000
    await persist([
      makeEvent({ id: 'old', timestamp: t - 1000 }),
      makeEvent({ id: 'edge', timestamp: t }),
      makeEvent({ id: 'new', timestamp: t + 1000 })
    ])
    const events = getRecentFieldEvents({ since: t, order: 'asc' })
    expect(events.map((e) => e.id)).toEqual(['edge', 'new'])
  })

  it('respects until (exclusive upper bound)', async () => {
    const t = 1_700_000_000_000
    await persist([
      makeEvent({ id: 'old', timestamp: t - 1000 }),
      makeEvent({ id: 'edge', timestamp: t }),
      makeEvent({ id: 'new', timestamp: t + 1000 })
    ])
    const events = getRecentFieldEvents({ until: t, order: 'asc' })
    expect(events.map((e) => e.id)).toEqual(['old'])
  })

  it('respects since + until window', async () => {
    const t = 1_700_000_000_000
    await persist([
      makeEvent({ id: 'a', timestamp: t }),
      makeEvent({ id: 'b', timestamp: t + 50 }),
      makeEvent({ id: 'c', timestamp: t + 100 }),
      makeEvent({ id: 'd', timestamp: t + 150 })
    ])
    const events = getRecentFieldEvents({ since: t + 50, until: t + 150, order: 'asc' })
    expect(events.map((e) => e.id)).toEqual(['b', 'c'])
  })

  it('limit defaults to 100, clamps above 1000', async () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({ id: `e-${i}`, timestamp: i })
    )
    await persist(events)
    expect(getRecentFieldEvents().length).toBe(5)
    // request way above max — clamp shouldn't throw and should return everything we have
    expect(getRecentFieldEvents({ limit: 99999 }).length).toBe(5)
  })

  it('limit honors small explicit value', async () => {
    const events = Array.from({ length: 10 }, (_, i) => makeEvent({ id: `e-${i}`, timestamp: i }))
    await persist(events)
    expect(getRecentFieldEvents({ limit: 3 }).length).toBe(3)
  })

  it('getFieldEventCounters forwards sink counters', () => {
    const c = getFieldEventCounters()
    expect(c).toHaveProperty('dropped_overflow')
    expect(c).toHaveProperty('dropped_invalid')
    expect(c).toHaveProperty('dropped_privacy')
    expect(c).toHaveProperty('flush_failures')
    expect(c).toHaveProperty('queueDepth')
  })
})
