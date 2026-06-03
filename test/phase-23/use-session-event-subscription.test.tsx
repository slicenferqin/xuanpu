import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanonicalAgentEvent } from '../../src/shared/types/agent-protocol'
import type { TimelineMessage } from '../../src/shared/lib/timeline-types'
import { messageSendTimes } from '../../src/renderer/src/lib/message-send-times'
import { useSessionEventSubscription } from '../../src/renderer/src/hooks/useSessionEventSubscription'
import { useContextStore } from '../../src/renderer/src/stores/useContextStore'
import { useSessionRuntimeStore } from '../../src/renderer/src/stores/useSessionRuntimeStore'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStatusStore } from '../../src/renderer/src/stores/useWorktreeStatusStore'

const SESSION_ID = 'event-subscription-session'
const WORKTREE_ID = 'event-subscription-worktree'

function resetRuntimeStore(): void {
  const state = useSessionRuntimeStore.getState()
  for (const sessionId of state.sessions.keys()) {
    state.clearSession(sessionId)
  }
  state.clearSessionTasks(SESSION_ID)
}

function resetStores(): void {
  resetRuntimeStore()
  messageSendTimes.clear()
  useContextStore.setState({
    tokensBySession: {},
    modelBySession: {},
    contextSnapshotsBySession: {},
    costBySession: {},
    costEventKeysBySession: {},
    modelLimits: {}
  })
  useSessionStore.setState({
    sessionsByWorktree: new Map([
      [
        WORKTREE_ID,
        [
          {
            id: SESSION_ID,
            name: 'Old title',
            worktree_id: WORKTREE_ID,
            connection_id: null
          } as never
        ]
      ]
    ]),
    sessionsByConnection: new Map(),
    pendingPlans: new Map()
  })
  useWorktreeStatusStore.setState({
    sessionStatuses: {},
    lastMessageTimeByWorktree: {}
  })
  Object.defineProperty(window, 'db', {
    writable: true,
    configurable: true,
    value: {
      ...(window.db ?? {}),
      session: {
        ...(window.db?.session ?? {}),
        update: vi.fn().mockResolvedValue({ id: SESSION_ID, name: 'New title' })
      }
    }
  })
}

function dispatch(event: CanonicalAgentEvent): void {
  useSessionRuntimeStore.getState().dispatchToSession(SESSION_ID, event)
}

function useHarness(
  overrides: Partial<Parameters<typeof useSessionEventSubscription>[0]> = {}
): Parameters<typeof useSessionEventSubscription>[0] {
  const options = {
    sessionId: SESSION_ID,
    currentProviderId: 'codex',
    refresh: vi.fn().mockResolvedValue([] as TimelineMessage[]),
    refreshUsageSummary: vi.fn().mockResolvedValue(undefined),
    drainQueuedMessage: vi.fn().mockResolvedValue(false),
    clearOptimisticMessages: vi.fn(),
    setRuntimeSessionId: vi.fn(),
    notifyCommandsAvailable: vi.fn(),
    applyMissionTaskToolEvent: vi.fn(),
    syncMissionTasksFromMessages: vi.fn(),
    ...overrides
  }
  useSessionEventSubscription(options)
  return options
}

describe('useSessionEventSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStores()
  })

  it('coordinates idle completion without clearing readable streaming overlays', async () => {
    const refresh = vi.fn().mockResolvedValue([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'done',
        timestamp: '2026-05-26T00:00:00.000Z'
      }
    ] satisfies TimelineMessage[])
    const { result } = renderHook(() => useHarness({ refresh }))
    messageSendTimes.set(SESSION_ID, Date.now() - 1200)
    useSessionRuntimeStore.getState().setLifecycle(SESSION_ID, 'busy')

    act(() => {
      dispatch({
        type: 'session.status',
        sessionId: SESSION_ID,
        data: { status: { type: 'idle' } }
      } as CanonicalAgentEvent)
    })

    await waitFor(() => {
      expect(result.current.refreshUsageSummary).toHaveBeenCalled()
      expect(refresh).toHaveBeenCalled()
      expect(result.current.syncMissionTasksFromMessages).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'assistant-1' })
      ])
      expect(result.current.clearOptimisticMessages).toHaveBeenCalled()
      expect(result.current.drainQueuedMessage).toHaveBeenCalled()
    })
    expect(useSessionRuntimeStore.getState().getSession(SESSION_ID).lifecycle).toBe('idle')
    expect(useWorktreeStatusStore.getState().sessionStatuses[SESSION_ID]?.status).toBe('completed')
  })

  it('settles active session lifecycle on session.error', async () => {
    const { result } = renderHook(() => useHarness())
    useSessionRuntimeStore.getState().setLifecycle(SESSION_ID, 'busy')

    act(() => {
      dispatch({
        type: 'session.error',
        sessionId: SESSION_ID,
        data: { error: 'provider failed' }
      } as CanonicalAgentEvent)
    })

    await waitFor(() => {
      expect(result.current.refresh).toHaveBeenCalled()
      expect(result.current.clearOptimisticMessages).toHaveBeenCalled()
    })
    expect(useSessionRuntimeStore.getState().getSession(SESSION_ID).lifecycle).toBe('idle')
  })

  it('routes streamed task tool parts through the mission task callback', () => {
    const { result } = renderHook(() => useHarness())
    const input = {
      todos: [
        {
          id: 'task-1',
          content: 'Ship refactor',
          status: 'pending'
        }
      ]
    }

    act(() => {
      dispatch({
        type: 'message.part.updated',
        sessionId: SESSION_ID,
        data: {
          part: {
            type: 'tool',
            tool: 'TodoWrite',
            callID: 'tool-call-1',
            state: { input }
          }
        }
      } as CanonicalAgentEvent)
    })

    expect(result.current.applyMissionTaskToolEvent).toHaveBeenCalledWith(
      'TodoWrite',
      input,
      'tool-call-1'
    )
  })

  it('applies active-session usage, materialization, commands, and title events', async () => {
    const { result } = renderHook(() => useHarness())

    act(() => {
      dispatch({
        type: 'message.updated',
        sessionId: SESSION_ID,
        data: {
          id: 'message-1',
          info: { time: { completed: 123 } },
          usage: { input: 6, output: 4 },
          cost: 0.31,
          model: 'codex/gpt-5'
        }
      } as CanonicalAgentEvent)
      dispatch({
        type: 'session.context_usage',
        sessionId: SESSION_ID,
        data: {
          tokens: { input: 8, output: 2 },
          model: { providerID: 'codex', modelID: 'gpt-5' },
          contextWindow: 1000
        }
      } as CanonicalAgentEvent)
      dispatch({
        type: 'session.materialized',
        sessionId: SESSION_ID,
        data: { newSessionId: 'runtime-materialized' }
      } as CanonicalAgentEvent)
      dispatch({
        type: 'session.commands_available',
        sessionId: SESSION_ID,
        data: {}
      } as CanonicalAgentEvent)
      dispatch({
        type: 'session.updated',
        sessionId: SESSION_ID,
        data: { title: 'New title' }
      } as CanonicalAgentEvent)
    })

    await waitFor(() => {
      expect(result.current.setRuntimeSessionId).toHaveBeenCalledWith('runtime-materialized')
      expect(result.current.refreshUsageSummary).toHaveBeenCalled()
      expect(result.current.notifyCommandsAvailable).toHaveBeenCalled()
      const session = useSessionStore.getState().sessionsByWorktree.get(WORKTREE_ID)?.[0]
      expect(session?.name).toBe('New title')
    })
    expect(useContextStore.getState().tokensBySession[SESSION_ID]).toEqual({
      input: 8,
      output: 2,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0
    })
    expect(useContextStore.getState().costBySession[SESSION_ID]).toBe(0.31)
  })
})
