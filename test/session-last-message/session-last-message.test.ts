import { beforeEach, describe, expect, test, vi } from 'vitest'
import { refreshSessionLastMessageAt } from '@/lib/session-last-message'

const mocks = vi.hoisted(() => ({
  sessionsByWorktree: new Map<string, Array<{ id: string }>>(),
  sessionsByConnection: new Map<string, Array<{ id: string }>>(),
  connections: [] as Array<{
    id: string
    members: Array<{ worktree_id: string }>
  }>,
  setLastMessageTime: vi.fn(),
  dbSessionGet: vi.fn(),
  connectionGet: vi.fn()
}))

vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      sessionsByWorktree: mocks.sessionsByWorktree,
      sessionsByConnection: mocks.sessionsByConnection
    })
  }
}))

vi.mock('@/stores/useConnectionStore', () => ({
  useConnectionStore: {
    getState: () => ({
      connections: mocks.connections
    })
  }
}))

vi.mock('@/stores/useWorktreeStatusStore', () => ({
  useWorktreeStatusStore: {
    getState: () => ({
      setLastMessageTime: mocks.setLastMessageTime
    })
  }
}))

describe('refreshSessionLastMessageAt', () => {
  beforeEach(() => {
    mocks.sessionsByWorktree.clear()
    mocks.sessionsByConnection.clear()
    mocks.connections.length = 0
    mocks.setLastMessageTime.mockClear()
    mocks.dbSessionGet.mockReset()
    mocks.dbSessionGet.mockResolvedValue(null)
    mocks.connectionGet.mockReset()
    mocks.connectionGet.mockResolvedValue({ success: false })

    Object.defineProperty(window, 'db', {
      configurable: true,
      writable: true,
      value: {
        session: {
          get: mocks.dbSessionGet
        }
      }
    })

    Object.defineProperty(window, 'connectionOps', {
      configurable: true,
      writable: true,
      value: {
        get: mocks.connectionGet
      }
    })
  })

  test('updates a worktree-bound session worktree', async () => {
    mocks.sessionsByWorktree.set('wt-1', [{ id: 'session-1' }])

    await refreshSessionLastMessageAt('session-1', 1234)

    expect(mocks.setLastMessageTime).toHaveBeenCalledTimes(1)
    expect(mocks.setLastMessageTime).toHaveBeenCalledWith('wt-1', 1234)
    expect(mocks.dbSessionGet).not.toHaveBeenCalled()
  })

  test('fans out a connection-bound session to all connection members', async () => {
    mocks.sessionsByConnection.set('conn-1', [{ id: 'session-2' }])
    mocks.connections.push({
      id: 'conn-1',
      members: [{ worktree_id: 'wt-1' }, { worktree_id: 'wt-2' }]
    })

    await refreshSessionLastMessageAt('session-2', 5678)

    expect(mocks.setLastMessageTime).toHaveBeenCalledTimes(2)
    expect(mocks.setLastMessageTime).toHaveBeenNthCalledWith(1, 'wt-1', 5678)
    expect(mocks.setLastMessageTime).toHaveBeenNthCalledWith(2, 'wt-2', 5678)
    expect(mocks.dbSessionGet).not.toHaveBeenCalled()
  })

  test('falls back to the database for an unloaded worktree-bound session', async () => {
    mocks.dbSessionGet.mockResolvedValue({
      id: 'session-db',
      worktree_id: 'wt-db',
      connection_id: null
    })

    await refreshSessionLastMessageAt('session-db', 4321)

    expect(mocks.dbSessionGet).toHaveBeenCalledWith('session-db')
    expect(mocks.setLastMessageTime).toHaveBeenCalledTimes(1)
    expect(mocks.setLastMessageTime).toHaveBeenCalledWith('wt-db', 4321)
  })

  test('falls back to connectionOps for an unloaded connection-bound session', async () => {
    mocks.dbSessionGet.mockResolvedValue({
      id: 'session-db-conn',
      worktree_id: null,
      connection_id: 'conn-db'
    })
    mocks.connectionGet.mockResolvedValue({
      success: true,
      connection: {
        id: 'conn-db',
        members: [{ worktree_id: 'wt-a' }, { worktree_id: 'wt-b' }]
      }
    })

    await refreshSessionLastMessageAt('session-db-conn', 8765)

    expect(mocks.connectionGet).toHaveBeenCalledWith('conn-db')
    expect(mocks.setLastMessageTime).toHaveBeenCalledTimes(2)
    expect(mocks.setLastMessageTime).toHaveBeenNthCalledWith(1, 'wt-a', 8765)
    expect(mocks.setLastMessageTime).toHaveBeenNthCalledWith(2, 'wt-b', 8765)
  })

  test('no-ops when binding information is missing', async () => {
    mocks.sessionsByConnection.set('conn-missing', [{ id: 'session-3' }])

    await refreshSessionLastMessageAt('session-3', 9999)
    await refreshSessionLastMessageAt('unknown-session', 9999)

    expect(mocks.setLastMessageTime).not.toHaveBeenCalled()
  })
})
