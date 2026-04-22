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
import { getEventBus, resetEventBus } from '../../../src/server/event-bus'
import {
  recordCommandEventId,
  clearTerminalOutputWindow,
  subscribeTerminalOutputBus,
  __resetAllWindowsForTest,
  __TERMINAL_OUTPUT_TUNABLES_FOR_TEST
} from '../../../src/main/field/terminal-output-window'
import { getRecentFieldEvents } from '../../../src/main/field/repository'

let tmpDir: string
let db: DatabaseService

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-terminal-output-'))
  db = new DatabaseService(join(tmpDir, 'test.db'))
  db.init()
  ;(globalThis as unknown as { __sinkTestDb: DatabaseService }).__sinkTestDb = db
  resetFieldEventSink()
  resetEventBus()
  __resetAllWindowsForTest()
  subscribeTerminalOutputBus()
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

async function drain(): Promise<void> {
  await getFieldEventSink().shutdown()
  resetFieldEventSink()
}

describe('terminal-output-window — Phase 21', () => {
  it('emits a terminal.output event on exit with the accumulated data', async () => {
    getEventBus().emit('terminal:data', 'w-1', 'hello\nworld\n')
    getEventBus().emit('terminal:exit', 'w-1', 0)
    await drain()

    const events = getRecentFieldEvents({ type: 'terminal.output' })
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.type).toBe('terminal.output')
    const p = e.payload as {
      head: string
      tail: string
      truncated: boolean
      totalBytes: number
      exitCode: number | null
      reason: string
      commandEventId: string | null
    }
    expect(p.head).toBe('hello\nworld\n')
    expect(p.tail).toBe('')
    expect(p.truncated).toBe(false)
    expect(p.exitCode).toBe(0)
    expect(p.reason).toBe('exit')
    expect(p.commandEventId).toBeNull()
  })

  it('correlates output to a prior command event via recordCommandEventId', async () => {
    recordCommandEventId('w-1', 'cmd-abc')
    getEventBus().emit('terminal:data', 'w-1', 'output of cmd\n')
    getEventBus().emit('terminal:exit', 'w-1', 0)
    await drain()

    const events = getRecentFieldEvents({ type: 'terminal.output' })
    expect(events).toHaveLength(1)
    const p = events[0].payload as { commandEventId: string | null }
    expect(p.commandEventId).toBe('cmd-abc')
    // Also stored as a top-level related_event_id for indexed lookup
    expect(events[0].relatedEventId).toBe('cmd-abc')
  })

  it('closes a window on next-command and emits reason=next-command', async () => {
    recordCommandEventId('w-1', 'cmd-1')
    getEventBus().emit('terminal:data', 'w-1', 'partial output')
    recordCommandEventId('w-1', 'cmd-2')
    await drain()

    const events = getRecentFieldEvents({ type: 'terminal.output', order: 'asc' })
    expect(events).toHaveLength(1)
    const p = events[0].payload as { reason: string; commandEventId: string | null }
    expect(p.reason).toBe('next-command')
    expect(p.commandEventId).toBe('cmd-1')
  })

  it('truncates output: keeps head + tail, elides middle', async () => {
    const { HEAD_LINES, TAIL_LINES } = __TERMINAL_OUTPUT_TUNABLES_FOR_TEST
    const total = HEAD_LINES + TAIL_LINES + 10
    const lines = Array.from({ length: total }, (_, i) => `line${i}`)
    getEventBus().emit('terminal:data', 'w-1', lines.join('\n'))
    getEventBus().emit('terminal:exit', 'w-1', 0)
    await drain()

    const events = getRecentFieldEvents({ type: 'terminal.output' })
    expect(events).toHaveLength(1)
    const p = events[0].payload as { head: string; tail: string; truncated: boolean }
    expect(p.truncated).toBe(true)
    expect(p.head.split('\n').length).toBe(HEAD_LINES)
    expect(p.tail.split('\n').length).toBe(TAIL_LINES)
    // head should start at line0, tail should end at last line
    expect(p.head.startsWith('line0\n')).toBe(true)
    expect(p.tail.endsWith(`line${total - 1}`)).toBe(true)
  })

  it('closes window on size cap and reports reason=size', async () => {
    const { MAX_WINDOW_BYTES } = __TERMINAL_OUTPUT_TUNABLES_FOR_TEST
    const big = 'a'.repeat(MAX_WINDOW_BYTES + 100)
    getEventBus().emit('terminal:data', 'w-1', big)
    await drain()

    const events = getRecentFieldEvents({ type: 'terminal.output' })
    expect(events).toHaveLength(1)
    const p = events[0].payload as { reason: string; totalBytes: number }
    expect(p.reason).toBe('size')
    expect(p.totalBytes).toBe(MAX_WINDOW_BYTES + 100)
  })

  it('does NOT emit on destroy (PTY cleanup should not pollute history)', async () => {
    getEventBus().emit('terminal:data', 'w-1', 'partial')
    clearTerminalOutputWindow('w-1')
    await drain()

    const events = getRecentFieldEvents({ type: 'terminal.output' })
    expect(events).toHaveLength(0)
  })

  it('isolates windows per worktree', async () => {
    recordCommandEventId('w-1', 'cmd-1')
    recordCommandEventId('w-2', 'cmd-2')
    getEventBus().emit('terminal:data', 'w-1', 'from w-1\n')
    getEventBus().emit('terminal:data', 'w-2', 'from w-2\n')
    getEventBus().emit('terminal:exit', 'w-1', 0)
    getEventBus().emit('terminal:exit', 'w-2', 1)
    await drain()

    const events = getRecentFieldEvents({ type: 'terminal.output' })
    expect(events).toHaveLength(2)
    const byWorktree = Object.fromEntries(events.map((e) => [e.worktreeId, e]))
    const w1 = byWorktree['w-1'].payload as { head: string; commandEventId: string | null }
    const w2 = byWorktree['w-2'].payload as { head: string; commandEventId: string | null }
    expect(w1.head).toContain('from w-1')
    expect(w1.commandEventId).toBe('cmd-1')
    expect(w2.head).toContain('from w-2')
    expect(w2.commandEventId).toBe('cmd-2')
  })

  it('emits terminal.output with no prior command as correlation=null', async () => {
    getEventBus().emit('terminal:data', 'w-1', 'no command preceded this\n')
    getEventBus().emit('terminal:exit', 'w-1', 0)
    await drain()

    const events = getRecentFieldEvents({ type: 'terminal.output' })
    expect(events).toHaveLength(1)
    const p = events[0].payload as { commandEventId: string | null }
    expect(p.commandEventId).toBeNull()
  })
})
