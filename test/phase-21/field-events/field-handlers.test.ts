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
})
