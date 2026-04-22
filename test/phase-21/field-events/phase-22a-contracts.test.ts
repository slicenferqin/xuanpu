/**
 * Phase 21 contract tests consumed by Phase 22A.
 *
 * These tests lock down the exact behavioral contracts that Phase 22A's
 * context builder and injection pipeline depend on. If any of them regresses,
 * Phase 22A's "moment 1" demo silently stops working. We want loud failures
 * here, not mysterious empty Field Contexts.
 *
 * See docs/prd/phase-22a-working-memory.md "Phase 21 契约断言测试" for the
 * 9 categories this file covers.
 */
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
import { getRecentFieldEvents } from '../../../src/main/field/repository'
import {
  setFieldCollectionEnabledCache,
  invalidatePrivacyCache
} from '../../../src/main/field/privacy'
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
  await sink.flushNow()
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-contract-test-'))
  db = new DatabaseService(join(tmpDir, 'test.db'))
  db.init()
  ;(globalThis as unknown as { __sinkTestDb: DatabaseService }).__sinkTestDb = db
  resetFieldEventSink()
  invalidatePrivacyCache()
  setFieldCollectionEnabledCache(true)
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

// -----------------------------------------------------------------------------

describe('Phase 21 contracts for Phase 22A — category 1: repository ordering', () => {
  it('asc order returns events by (timestamp, seq) ascending', async () => {
    const t = 1_700_000_000_000
    await persist([
      makeEvent({ id: 'c', timestamp: t + 200 }),
      makeEvent({ id: 'a', timestamp: t }),
      makeEvent({ id: 'b', timestamp: t + 100 })
    ])
    const events = getRecentFieldEvents({ order: 'asc' })
    expect(events.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('same-millisecond events are ordered by seq, stable across calls', async () => {
    const t = 1_700_000_000_000
    await persist([
      makeEvent({ id: 'x', timestamp: t }),
      makeEvent({ id: 'y', timestamp: t }),
      makeEvent({ id: 'z', timestamp: t })
    ])
    const a = getRecentFieldEvents({ order: 'asc' }).map((e) => e.id)
    const b = getRecentFieldEvents({ order: 'asc' }).map((e) => e.id)
    expect(a).toEqual(b)
    expect(a).toEqual(['x', 'y', 'z']) // insert order preserved via seq
  })
})

describe('Phase 21 contracts for Phase 22A — category 2: worktree isolation', () => {
  it('filters events strictly by worktreeId', async () => {
    await persist([
      makeEvent({ id: 'w1-a', worktreeId: 'w-1' }),
      makeEvent({ id: 'w2-a', worktreeId: 'w-2' }),
      makeEvent({ id: 'w1-b', worktreeId: 'w-1' })
    ])
    const only1 = getRecentFieldEvents({ worktreeId: 'w-1' }).map((e) => e.id).sort()
    expect(only1).toEqual(['w1-a', 'w1-b'])
  })

  it('worktreeId=null filters for global events only, never mixing with scoped', async () => {
    await persist([
      makeEvent({ id: 'global', worktreeId: null }),
      makeEvent({ id: 'scoped', worktreeId: 'w-1' })
    ])
    const globalOnly = getRecentFieldEvents({ worktreeId: null }).map((e) => e.id)
    expect(globalOnly).toEqual(['global'])
  })
})

describe('Phase 21 contracts for Phase 22A — category 3: focus derivation raw data', () => {
  // The builder (Phase 22A M1) will do the picking. These contracts make sure
  // the raw events carry enough info for that logic to work.

  it('file.open and file.focus both land with path and name', async () => {
    await persist([
      {
        id: 'e1',
        timestamp: Date.now(),
        worktreeId: 'w-1',
        projectId: 'p-1',
        sessionId: null,
        relatedEventId: null,
        type: 'file.open',
        payload: { path: '/abs/a.ts', name: 'a.ts' }
      } as FieldEvent,
      {
        id: 'e2',
        timestamp: Date.now() + 10,
        worktreeId: 'w-1',
        projectId: 'p-1',
        sessionId: null,
        relatedEventId: null,
        type: 'file.focus',
        payload: { path: '/abs/b.ts', name: 'b.ts', fromPath: '/abs/a.ts' }
      } as FieldEvent
    ])
    const events = getRecentFieldEvents({
      type: ['file.open', 'file.focus'],
      order: 'asc'
    })
    expect(events).toHaveLength(2)
    expect((events[0].payload as { path: string }).path).toBe('/abs/a.ts')
    expect((events[1].payload as { path: string }).path).toBe('/abs/b.ts')
  })

  it('file.selection records fromLine/toLine/length/path', async () => {
    await persist([
      {
        id: 'sel',
        timestamp: Date.now(),
        worktreeId: 'w-1',
        projectId: 'p-1',
        sessionId: null,
        relatedEventId: null,
        type: 'file.selection',
        payload: { path: '/abs/a.ts', fromLine: 45, toLine: 58, length: 320 }
      } as FieldEvent
    ])
    const events = getRecentFieldEvents({ type: 'file.selection' })
    const p = events[0].payload as {
      path: string
      fromLine: number
      toLine: number
      length: number
    }
    expect(p).toEqual({ path: '/abs/a.ts', fromLine: 45, toLine: 58, length: 320 })
  })
})

describe('Phase 21 contracts for Phase 22A — category 4: terminal correlation', () => {
  it('terminal.output carries relatedEventId pointing at its terminal.command', async () => {
    const commandId = 'cmd-abc'
    await persist([
      {
        id: commandId,
        timestamp: Date.now(),
        worktreeId: 'w-1',
        projectId: 'p-1',
        sessionId: null,
        relatedEventId: null,
        type: 'terminal.command',
        payload: { command: 'pnpm test' }
      } as FieldEvent,
      {
        id: 'out',
        timestamp: Date.now() + 100,
        worktreeId: 'w-1',
        projectId: 'p-1',
        sessionId: null,
        relatedEventId: commandId,
        type: 'terminal.output',
        payload: {
          commandEventId: commandId,
          head: 'FAIL',
          tail: '',
          truncated: false,
          totalBytes: 4,
          exitCode: 1,
          reason: 'exit'
        }
      } as FieldEvent
    ])
    const output = getRecentFieldEvents({ type: 'terminal.output' })[0]
    expect(output.relatedEventId).toBe(commandId)
    const p = output.payload as { commandEventId: string | null; exitCode: number | null }
    expect(p.commandEventId).toBe(commandId)
    expect(p.exitCode).toBe(1)
  })

  it('output without a prior command has relatedEventId=null (no accidental pairing)', async () => {
    await persist([
      {
        id: 'out-only',
        timestamp: Date.now(),
        worktreeId: 'w-1',
        projectId: 'p-1',
        sessionId: null,
        relatedEventId: null,
        type: 'terminal.output',
        payload: {
          commandEventId: null,
          head: 'random',
          tail: '',
          truncated: false,
          totalBytes: 6,
          exitCode: null,
          reason: 'destroy'
        }
      } as FieldEvent
    ])
    const output = getRecentFieldEvents({ type: 'terminal.output' })[0]
    expect(output.relatedEventId).toBeNull()
  })
})

describe('Phase 21 contracts for Phase 22A — category 5: sink flush visibility', () => {
  it('flushNow guarantees read-after-write: enqueue then query sees the row', async () => {
    const sink = getFieldEventSink()
    const evt = makeEvent({ id: 'visible' })
    sink.enqueue(evt, JSON.stringify(evt.payload))
    // Without flushNow, the event might still be in the in-memory queue.
    // This contract is what lets Phase 22A's builder see fresh data.
    await sink.flushNow()
    const events = getRecentFieldEvents()
    expect(events.map((e) => e.id)).toContain('visible')
  })

  it('rapid emit sequence (command then output then query) all become visible', async () => {
    const sink = getFieldEventSink()
    const cmd = makeEvent({
      id: 'cmd',
      type: 'terminal.command' as const,
      payload: { command: 'pnpm test' }
    } as Partial<FieldEvent>)
    const out = makeEvent({
      id: 'out',
      type: 'terminal.output' as const,
      relatedEventId: 'cmd',
      payload: {
        commandEventId: 'cmd',
        head: 'FAIL',
        tail: '',
        truncated: false,
        totalBytes: 4,
        exitCode: 1,
        reason: 'exit'
      }
    } as Partial<FieldEvent>)
    sink.enqueue(cmd, JSON.stringify(cmd.payload))
    sink.enqueue(out, JSON.stringify(out.payload))
    await sink.flushNow()

    const events = getRecentFieldEvents({ order: 'asc' })
    const cmdRow = events.find((e) => e.id === 'cmd')
    const outRow = events.find((e) => e.id === 'out')
    expect(cmdRow).toBeDefined()
    expect(outRow).toBeDefined()
    expect(outRow!.relatedEventId).toBe('cmd')
  })
})

describe('Phase 21 contracts for Phase 22A — category 6: privacy short-circuit', () => {
  it('disabling field collection drops sensitive events at emit site', async () => {
    const { emitFieldEvent } = await import('../../../src/main/field/emit')
    setFieldCollectionEnabledCache(false)

    const result = emitFieldEvent({
      type: 'worktree.switch',
      worktreeId: 'w-1',
      projectId: 'p-1',
      sessionId: null,
      relatedEventId: null,
      payload: { fromWorktreeId: null, toWorktreeId: 'w-1', trigger: 'user-click' }
    })
    await getFieldEventSink().flushNow()

    expect(result).toBeNull()
    expect(getRecentFieldEvents()).toHaveLength(0)
    expect(getFieldEventSink().getCounters().dropped_privacy).toBe(1)
  })

  it('re-enabling restores capture without leaking previously-dropped events', async () => {
    const { emitFieldEvent } = await import('../../../src/main/field/emit')

    setFieldCollectionEnabledCache(false)
    emitFieldEvent({
      type: 'worktree.switch',
      worktreeId: 'w-1',
      projectId: 'p-1',
      sessionId: null,
      relatedEventId: null,
      payload: { fromWorktreeId: null, toWorktreeId: 'w-1', trigger: 'user-click' }
    })

    setFieldCollectionEnabledCache(true)
    const okId = emitFieldEvent({
      type: 'worktree.switch',
      worktreeId: 'w-1',
      projectId: 'p-1',
      sessionId: null,
      relatedEventId: null,
      payload: { fromWorktreeId: null, toWorktreeId: 'w-1', trigger: 'keyboard' }
    })
    await getFieldEventSink().flushNow()

    expect(okId).not.toBeNull()
    const events = getRecentFieldEvents()
    expect(events).toHaveLength(1)
    expect((events[0].payload as { trigger: string }).trigger).toBe('keyboard')
  })
})

// Categories 7 (prompt transformation), 8 (slash skip), and 9 (truncation) are
// Phase 22A *functional* behaviors that don't yet exist in the codebase.
// They will be tested by context-builder / context-formatter / agent-handlers
// tests in M1/M2/M4. The Phase 21 contracts they *depend* on (sink flush,
// repository order, correlation) are covered above.

describe('Phase 21 contracts for Phase 22A — category 7-9: deferred to feature tests', () => {
  it('(placeholder) category 7 prompt transformation → tested in M4 agent-handlers tests', () => {
    expect(true).toBe(true)
  })
  it('(placeholder) category 8 slash skip → tested in M4 agent-handlers tests', () => {
    expect(true).toBe(true)
  })
  it('(placeholder) category 9 truncation → tested in M2 context-formatter tests', () => {
    expect(true).toBe(true)
  })
})
