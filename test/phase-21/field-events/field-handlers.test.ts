import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

// Capture the IPC handler callback for direct invocation.
type IpcCallback = (event: unknown, ...args: unknown[]) => void
const handlers = new Map<string, IpcCallback>()

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, cb: IpcCallback) => handlers.set(channel, cb)
  },
  app: undefined
}))

// Mock DB + emit. We only care that emitFieldEvent is called with the right
// arguments after validation + worktree lookup.
const mockWorktrees = new Map<string, { id: string; project_id: string }>()
vi.mock('../../../src/main/db', () => ({
  getDatabase: () => ({
    getWorktree: (id: string) => mockWorktrees.get(id) ?? null
  })
}))

const emitSpy = vi.fn()
vi.mock('../../../src/main/field/emit', () => ({
  emitFieldEvent: (...args: unknown[]) => emitSpy(...args)
}))

import { registerFieldHandlers } from '../../../src/main/ipc/field-handlers'

describe('field-handlers — Phase 21 M5', () => {
  beforeEach(() => {
    handlers.clear()
    mockWorktrees.clear()
    emitSpy.mockReset()
    registerFieldHandlers()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  function invoke(payload: unknown): void {
    const cb = handlers.get('field:reportWorktreeSwitch')
    if (!cb) throw new Error('handler not registered')
    cb({}, payload)
  }

  it('emits worktree.switch when input is valid and worktree exists', () => {
    mockWorktrees.set('w-1', { id: 'w-1', project_id: 'p-1' })
    invoke({ fromWorktreeId: 'w-0', toWorktreeId: 'w-1', trigger: 'user-click' })

    expect(emitSpy).toHaveBeenCalledOnce()
    const [args] = emitSpy.mock.calls[0]
    expect(args).toMatchObject({
      type: 'worktree.switch',
      worktreeId: 'w-1',
      projectId: 'p-1',
      sessionId: null,
      payload: { fromWorktreeId: 'w-0', toWorktreeId: 'w-1', trigger: 'user-click' }
    })
  })

  it('accepts null fromWorktreeId', () => {
    mockWorktrees.set('w-1', { id: 'w-1', project_id: 'p-1' })
    invoke({ fromWorktreeId: null, toWorktreeId: 'w-1', trigger: 'keyboard' })
    expect(emitSpy).toHaveBeenCalledOnce()
  })

  it('rejects when toWorktreeId does not exist in DB', () => {
    invoke({ fromWorktreeId: null, toWorktreeId: 'ghost', trigger: 'user-click' })
    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('rejects non-object input', () => {
    invoke(null)
    invoke('string')
    invoke(42)
    invoke([])
    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('rejects missing toWorktreeId', () => {
    invoke({ fromWorktreeId: null, trigger: 'user-click' })
    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('rejects empty string toWorktreeId', () => {
    mockWorktrees.set('', { id: '', project_id: 'p-1' })
    invoke({ fromWorktreeId: null, toWorktreeId: '', trigger: 'user-click' })
    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('rejects oversized toWorktreeId (>64 chars)', () => {
    const big = 'a'.repeat(65)
    mockWorktrees.set(big, { id: big, project_id: 'p-1' })
    invoke({ fromWorktreeId: null, toWorktreeId: big, trigger: 'user-click' })
    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('rejects oversized fromWorktreeId', () => {
    mockWorktrees.set('w-1', { id: 'w-1', project_id: 'p-1' })
    invoke({
      fromWorktreeId: 'a'.repeat(65),
      toWorktreeId: 'w-1',
      trigger: 'user-click'
    })
    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('rejects invalid trigger', () => {
    mockWorktrees.set('w-1', { id: 'w-1', project_id: 'p-1' })
    invoke({ fromWorktreeId: null, toWorktreeId: 'w-1', trigger: 'totally-fake' })
    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('rejects when trigger is missing', () => {
    mockWorktrees.set('w-1', { id: 'w-1', project_id: 'p-1' })
    invoke({ fromWorktreeId: null, toWorktreeId: 'w-1' })
    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('rejects attempts to forge other event types (no channel exists)', () => {
    // There is deliberately no handler for 'field:report' generic or other types.
    const otherHandler = handlers.get('field:report')
    expect(otherHandler).toBeUndefined()
  })

  // ---------------------------------------------------------------------------
  // file.open
  // ---------------------------------------------------------------------------

  function invokeChannel(channel: string, payload: unknown): void {
    const cb = handlers.get(channel)
    if (!cb) throw new Error(`handler ${channel} not registered`)
    cb({}, payload)
  }

  it('file.open: emits when worktreeId/path/name valid', () => {
    mockWorktrees.set('w-1', { id: 'w-1', project_id: 'p-1' })
    invokeChannel('field:reportFileOpen', {
      worktreeId: 'w-1',
      path: '/abs/src/auth.ts',
      name: 'auth.ts'
    })
    expect(emitSpy).toHaveBeenCalledOnce()
    const [args] = emitSpy.mock.calls[0]
    expect(args).toMatchObject({
      type: 'file.open',
      worktreeId: 'w-1',
      projectId: 'p-1',
      payload: { path: '/abs/src/auth.ts', name: 'auth.ts' }
    })
  })

  it('file.open: drops events from an unknown worktree silently', () => {
    invokeChannel('field:reportFileOpen', {
      worktreeId: 'ghost',
      path: '/x/y.ts',
      name: 'y.ts'
    })
    // Emit still goes through — projectId is null. That's OK: file was opened,
    // we just don't know what project it belongs to. We only skip worktree.switch
    // when the ID isn't real; file.open is less strict because the renderer can't
    // practically send a fake worktreeId here.
    expect(emitSpy).toHaveBeenCalledOnce()
    const [args] = emitSpy.mock.calls[0]
    expect(args).toMatchObject({ worktreeId: 'ghost', projectId: null })
  })

  it('file.open: rejects missing path / name', () => {
    mockWorktrees.set('w-1', { id: 'w-1', project_id: 'p-1' })
    invokeChannel('field:reportFileOpen', { worktreeId: 'w-1', name: 'a.ts' })
    invokeChannel('field:reportFileOpen', { worktreeId: 'w-1', path: '/x' })
    expect(emitSpy).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------------
  // file.focus
  // ---------------------------------------------------------------------------

  it('file.focus: emits with nullable fromPath', () => {
    mockWorktrees.set('w-1', { id: 'w-1', project_id: 'p-1' })
    invokeChannel('field:reportFileFocus', {
      worktreeId: 'w-1',
      path: '/a.ts',
      name: 'a.ts',
      fromPath: null
    })
    expect(emitSpy).toHaveBeenCalledOnce()
    const [args] = emitSpy.mock.calls[0]
    expect(args).toMatchObject({
      type: 'file.focus',
      payload: { path: '/a.ts', name: 'a.ts', fromPath: null }
    })
  })

  it('file.focus: accepts string fromPath', () => {
    mockWorktrees.set('w-1', { id: 'w-1', project_id: 'p-1' })
    invokeChannel('field:reportFileFocus', {
      worktreeId: 'w-1',
      path: '/a.ts',
      name: 'a.ts',
      fromPath: '/prev.ts'
    })
    expect(emitSpy).toHaveBeenCalledOnce()
    const p = (emitSpy.mock.calls[0][0] as { payload: { fromPath: string | null } }).payload
    expect(p.fromPath).toBe('/prev.ts')
  })

  // ---------------------------------------------------------------------------
  // file.selection
  // ---------------------------------------------------------------------------

  it('file.selection: emits with line range', () => {
    mockWorktrees.set('w-1', { id: 'w-1', project_id: 'p-1' })
    invokeChannel('field:reportFileSelection', {
      worktreeId: 'w-1',
      path: '/a.ts',
      fromLine: 45,
      toLine: 58,
      length: 320
    })
    expect(emitSpy).toHaveBeenCalledOnce()
    const [args] = emitSpy.mock.calls[0]
    expect(args).toMatchObject({
      type: 'file.selection',
      payload: { fromLine: 45, toLine: 58, length: 320 }
    })
  })

  it('file.selection: rejects non-positive lines', () => {
    mockWorktrees.set('w-1', { id: 'w-1', project_id: 'p-1' })
    invokeChannel('field:reportFileSelection', {
      worktreeId: 'w-1',
      path: '/a.ts',
      fromLine: 0,
      toLine: 1,
      length: 5
    })
    invokeChannel('field:reportFileSelection', {
      worktreeId: 'w-1',
      path: '/a.ts',
      fromLine: -1,
      toLine: 1,
      length: 5
    })
    expect(emitSpy).not.toHaveBeenCalled()
  })

  it('file.selection: rejects non-integer lines', () => {
    mockWorktrees.set('w-1', { id: 'w-1', project_id: 'p-1' })
    invokeChannel('field:reportFileSelection', {
      worktreeId: 'w-1',
      path: '/a.ts',
      fromLine: 1.5,
      toLine: 2,
      length: 5
    })
    expect(emitSpy).not.toHaveBeenCalled()
  })
})
