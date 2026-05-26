import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionRuntimeConnection } from '../../src/renderer/src/hooks/useSessionRuntimeConnection'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStore } from '../../src/renderer/src/stores/useWorktreeStore'

const SESSION_ID = 'runtime-connection-session'
const WORKTREE_ID = 'runtime-connection-worktree'
const PROJECT_ID = 'runtime-connection-project'
const CONNECTION_ID = 'runtime-connection-connection'
const WORKTREE_PATH = '/tmp/runtime-connection-worktree'
const CONNECTION_PATH = '/tmp/runtime-connection-connection'

function installWindowMocks(overrides: Partial<Window['agentOps']> = {}): {
  connect: ReturnType<typeof vi.fn>
  reconnect: ReturnType<typeof vi.fn>
  capabilities: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  getConnection: ReturnType<typeof vi.fn>
} {
  const connect = vi.fn().mockResolvedValue({ success: true, sessionId: 'runtime-connected' })
  const reconnect = vi.fn().mockResolvedValue({ success: true })
  const capabilities = vi.fn().mockResolvedValue({
    success: true,
    capabilities: { supportsSteer: true }
  })
  const update = vi.fn().mockResolvedValue({ success: true })
  const getConnection = vi.fn().mockResolvedValue({
    success: true,
    connection: { path: CONNECTION_PATH }
  })

  Object.defineProperty(window, 'agentOps', {
    writable: true,
    configurable: true,
    value: {
      connect,
      reconnect,
      capabilities,
      ...overrides
    }
  })
  Object.defineProperty(window, 'db', {
    writable: true,
    configurable: true,
    value: {
      ...(window.db ?? {}),
      session: {
        ...(window.db?.session ?? {}),
        update
      }
    }
  })
  Object.defineProperty(window, 'connectionOps', {
    writable: true,
    configurable: true,
    value: {
      ...(window.connectionOps ?? {}),
      get: getConnection
    }
  })

  return { connect, reconnect, capabilities, update, getConnection }
}

function resetStores(): void {
  useSessionStore.setState({
    sessionsByWorktree: new Map([
      [
        WORKTREE_ID,
        [
          {
            id: SESSION_ID,
            worktree_id: WORKTREE_ID,
            connection_id: null,
            opencode_session_id: null,
            agent_sdk: 'codex'
          } as never
        ]
      ]
    ]),
    sessionsByConnection: new Map(),
    pendingPlans: new Map()
  })
  useWorktreeStore.setState({
    worktreesByProject: new Map([
      [
        PROJECT_ID,
        [
          {
            id: WORKTREE_ID,
            project_id: PROJECT_ID,
            path: WORKTREE_PATH,
            name: 'Runtime Worktree',
            branch_name: 'main',
            status: 'active',
            is_default: true,
            branch_renamed: 0,
            last_message_at: null,
            session_titles: '[]',
            last_model_provider_id: null,
            last_model_id: null,
            last_model_variant: null,
            created_at: '2026-05-26T00:00:00.000Z',
            last_accessed_at: '2026-05-26T00:00:00.000Z',
            github_pr_number: null,
            github_pr_url: null
          } as never
        ]
      ]
    ])
  })
}

describe('useSessionRuntimeConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installWindowMocks()
    resetStores()
  })

  it('resolves a worktree path, connects a new runtime session, and persists the runtime id', async () => {
    const { connect, update } = installWindowMocks()

    const { result } = renderHook(() =>
      useSessionRuntimeConnection({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
        connectionId: null,
        opencodeSessionId: null,
        agentSdk: 'codex'
      })
    )

    expect(result.current.worktreePath).toBe(WORKTREE_PATH)

    await waitFor(() => {
      expect(connect).toHaveBeenCalledWith(WORKTREE_PATH, SESSION_ID)
      expect(result.current.runtimeSessionId).toBe('runtime-connected')
    })
    expect(update).toHaveBeenCalledWith(SESSION_ID, {
      opencode_session_id: 'runtime-connected'
    })
    expect(
      useSessionStore.getState().sessionsByWorktree.get(WORKTREE_ID)?.[0]?.opencode_session_id
    ).toBe('runtime-connected')
  })

  it('resolves a connection path and persists a remapped reconnect runtime id', async () => {
    useSessionStore.setState({
      sessionsByWorktree: new Map(),
      sessionsByConnection: new Map([
        [
          CONNECTION_ID,
          [
            {
              id: SESSION_ID,
              worktree_id: null,
              connection_id: CONNECTION_ID,
              opencode_session_id: 'runtime-old',
              agent_sdk: 'opencode'
            } as never
          ]
        ]
      ])
    })
    const reconnect = vi.fn().mockResolvedValue({ success: true, sessionId: 'runtime-new' })
    const { update, getConnection } = installWindowMocks({ reconnect })

    const { result } = renderHook(() =>
      useSessionRuntimeConnection({
        sessionId: SESSION_ID,
        worktreeId: null,
        connectionId: CONNECTION_ID,
        opencodeSessionId: 'runtime-old',
        agentSdk: 'opencode'
      })
    )

    await waitFor(() => {
      expect(getConnection).toHaveBeenCalledWith(CONNECTION_ID)
      expect(result.current.worktreePath).toBe(CONNECTION_PATH)
      expect(reconnect).toHaveBeenCalledWith(CONNECTION_PATH, 'runtime-old', SESSION_ID)
      expect(result.current.runtimeSessionId).toBe('runtime-new')
    })
    expect(update).toHaveBeenCalledWith(SESSION_ID, {
      opencode_session_id: 'runtime-new'
    })
    expect(
      useSessionStore.getState().sessionsByConnection.get(CONNECTION_ID)?.[0]?.opencode_session_id
    ).toBe('runtime-new')
  })

  it('hydrates steer support from runtime capabilities and falls back by SDK', async () => {
    const { result } = renderHook(() =>
      useSessionRuntimeConnection({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
        connectionId: null,
        opencodeSessionId: 'runtime-existing',
        agentSdk: 'opencode'
      })
    )

    expect(result.current.supportsSteer).toBe(false)

    await waitFor(() => {
      expect(result.current.supportsSteer).toBe(true)
    })
  })
})
