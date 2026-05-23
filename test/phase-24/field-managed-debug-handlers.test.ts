import { beforeEach, describe, expect, it, vi } from 'vitest'

type IpcCallback = (event: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, IpcCallback>()
const invokeHandlers = new Map<string, IpcCallback>()
const repoMocks = vi.hoisted(() => ({
  listFieldContextPackages: vi.fn(() => []),
  listFieldEpisodeBlocks: vi.fn(() => [])
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, cb: IpcCallback) => handlers.set(channel, cb),
    handle: (channel: string, cb: IpcCallback) => invokeHandlers.set(channel, cb)
  },
  app: undefined
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('../../src/main/db', () => ({
  getDatabase: () => ({
    getWorktree: vi.fn(() => null),
    getEpisodicMemory: vi.fn(() => null),
    deleteEpisodicMemory: vi.fn(() => false)
  })
}))

vi.mock('../../src/main/field/emit', () => ({
  emitFieldEvent: vi.fn()
}))

vi.mock('../../src/main/field/last-injection-cache', () => ({
  getLastInjection: vi.fn(() => null)
}))

vi.mock('../../src/main/field/semantic-memory-loader', () => ({
  getSemanticMemory: vi.fn(() => null)
}))

vi.mock('../../src/main/field/pinned-facts-repository', () => ({
  getPinnedFacts: vi.fn(() => null),
  upsertPinnedFacts: vi.fn(),
  PINNED_FACTS_MAX_CHARS: 2000
}))

vi.mock('../../src/main/field/context-package-repository', () => ({
  listFieldContextPackages: repoMocks.listFieldContextPackages
}))

vi.mock('../../src/main/field/episode-block-repository', () => ({
  listFieldEpisodeBlocks: repoMocks.listFieldEpisodeBlocks
}))

import { registerFieldHandlers } from '../../src/main/ipc/field-handlers'

describe('field managed context debug handlers', () => {
  beforeEach(() => {
    handlers.clear()
    invokeHandlers.clear()
    vi.clearAllMocks()
    repoMocks.listFieldContextPackages.mockReturnValue([])
    repoMocks.listFieldEpisodeBlocks.mockReturnValue([])
    registerFieldHandlers()
  })

  it('registers managed context debug channels', () => {
    expect(invokeHandlers.has('field:listContextPackages')).toBe(true)
    expect(invokeHandlers.has('field:listEpisodeBlocks')).toBe(true)
  })

  it('lists context packages with scoped, normalized query options', async () => {
    repoMocks.listFieldContextPackages.mockReturnValue([{ id: 'pkg-1' }])
    const cb = invokeHandlers.get('field:listContextPackages')!

    const result = await cb(
      {},
      {
        sessionId: 'session-1',
        worktreeId: 'worktree-1',
        runtimeId: 'xuanpu-agent',
        includeRenderedMarkdown: true,
        limit: 500
      }
    )

    expect(result).toEqual([{ id: 'pkg-1' }])
    expect(repoMocks.listFieldContextPackages).toHaveBeenCalledWith({
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      runtimeId: 'xuanpu-agent',
      includeRenderedMarkdown: true,
      limit: 50
    })
  })

  it('rejects unscoped or invalid context package debug queries', async () => {
    const cb = invokeHandlers.get('field:listContextPackages')!

    expect(await cb({}, {})).toEqual([])
    expect(await cb({}, { worktreeId: 'worktree-1', runtimeId: 'fake-runtime' })).toEqual([])
    expect(repoMocks.listFieldContextPackages).not.toHaveBeenCalled()
  })

  it('lists episode blocks only when worktree-scoped', async () => {
    repoMocks.listFieldEpisodeBlocks.mockReturnValue([{ id: 'episode-1' }])
    const cb = invokeHandlers.get('field:listEpisodeBlocks')!

    const result = await cb(
      {},
      {
        worktreeId: 'worktree-1',
        sessionId: 'session-1',
        kind: 'turns',
        limit: 2
      }
    )

    expect(result).toEqual([{ id: 'episode-1' }])
    expect(repoMocks.listFieldEpisodeBlocks).toHaveBeenCalledWith({
      worktreeId: 'worktree-1',
      sessionId: 'session-1',
      kind: 'turns',
      limit: 2
    })
  })

  it('rejects unscoped or invalid episode block debug queries', async () => {
    const cb = invokeHandlers.get('field:listEpisodeBlocks')!

    expect(await cb({}, {})).toEqual([])
    expect(await cb({}, { worktreeId: 'worktree-1', kind: 'fake-kind' })).toEqual([])
    expect(repoMocks.listFieldEpisodeBlocks).not.toHaveBeenCalled()
  })
})
