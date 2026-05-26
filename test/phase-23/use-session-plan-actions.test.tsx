import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lastSendMode } from '../../src/renderer/src/lib/message-send-times'
import {
  useSessionPlanActions
} from '../../src/renderer/src/hooks/useSessionPlanActions'
import type {
  OptimisticTimelineMessagesController
} from '../../src/renderer/src/hooks/useOptimisticTimelineMessages'
import { useSessionRuntimeStore } from '../../src/renderer/src/stores/useSessionRuntimeStore'
import { useSessionStore, type PendingPlan } from '../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStatusStore } from '../../src/renderer/src/stores/useWorktreeStatusStore'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

const SESSION_ID = 'plan-actions-session'
const RUNTIME_SESSION_ID = 'plan-actions-runtime'
const WORKTREE_PATH = '/tmp/plan-actions'
const WORKTREE_ID = 'plan-actions-worktree'
const PROJECT_ID = 'plan-actions-project'
const PENDING_PLAN: PendingPlan = {
  requestId: 'plan-request-1',
  toolUseID: 'tool-use-1',
  planContent: 'Ship the implementation.'
}

function installWindowMocks(overrides: Partial<Window['agentOps']> = {}): {
  prompt: ReturnType<typeof vi.fn>
  planApprove: ReturnType<typeof vi.fn>
  planReject: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
} {
  const prompt = vi.fn().mockResolvedValue({ success: true })
  const planApprove = vi.fn().mockResolvedValue({ success: true })
  const planReject = vi.fn().mockResolvedValue({ success: true })
  const abort = vi.fn().mockResolvedValue({ success: true, aborted: true })
  Object.defineProperty(window, 'agentOps', {
    writable: true,
    configurable: true,
    value: {
      prompt,
      planApprove,
      planReject,
      abort,
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
        update: vi.fn().mockResolvedValue({ success: true })
      }
    }
  })
  return { prompt, planApprove, planReject, abort }
}

function resetRuntimeStore(): void {
  const state = useSessionRuntimeStore.getState()
  for (const sessionId of state.sessions.keys()) {
    state.clearSession(sessionId)
  }
  for (const sessionId of state.pendingMessages.keys()) {
    state.clearPendingMessages(sessionId)
  }
}

function resetStores(agentSdk: 'codex' | 'claude-code' = 'codex'): void {
  resetRuntimeStore()
  useSessionStore.setState({
    sessionsByWorktree: new Map([
      [
        WORKTREE_ID,
        [
          {
            id: SESSION_ID,
            project_id: PROJECT_ID,
            worktree_id: WORKTREE_ID,
            connection_id: null,
            agent_sdk: agentSdk
          } as never
        ]
      ]
    ]),
    sessionsByConnection: new Map(),
    pendingPlans: new Map([[SESSION_ID, PENDING_PLAN]]),
    modeBySession: new Map()
  })
  useWorktreeStatusStore.setState({
    sessionStatuses: {
      [SESSION_ID]: { status: 'plan_ready', timestamp: Date.now() }
    },
    lastMessageTimeByWorktree: {}
  })
  lastSendMode.clear()
}

function createOptimisticTimeline(): OptimisticTimelineMessagesController {
  return {
    appendOptimisticUserMessage: vi.fn(),
    removeOptimisticUserMessage: vi.fn(),
    trimOptimisticMessagesToTimeline: vi.fn()
  }
}

function useHarness(options: {
  agentSdk?: 'codex' | 'claude-code'
  optimisticTimeline?: OptimisticTimelineMessagesController
  transitionToolStatus?: ReturnType<typeof vi.fn>
  resetLiveOverlay?: ReturnType<typeof vi.fn>
} = {}) {
  const agentSdk = options.agentSdk ?? 'codex'
  const optimisticTimeline = options.optimisticTimeline ?? createOptimisticTimeline()
  const transitionToolStatus = options.transitionToolStatus ?? vi.fn()
  const resetLiveOverlay = options.resetLiveOverlay ?? vi.fn()

  const controller = useSessionPlanActions({
    sessionId: SESSION_ID,
    worktreePath: WORKTREE_PATH,
    runtimeSessionId: RUNTIME_SESSION_ID,
    agentSdk,
    pendingPlan: PENDING_PLAN,
    connectionId: null,
    worktreeId: WORKTREE_ID,
    projectId: PROJECT_ID,
    goalMode: false,
    successCriteria: '',
    requestModel: { providerID: 'openai', modelID: 'gpt-test' },
    promptOptions: { goalMode: false, successCriteria: '' },
    optimisticTimeline,
    resetLiveOverlay,
    transitionToolStatus,
    refresh: vi.fn().mockResolvedValue([]),
    t: (key) => key
  })

  return {
    ...controller,
    optimisticTimeline,
    transitionToolStatus,
    resetLiveOverlay
  }
}

describe('useSessionPlanActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installWindowMocks()
    resetStores()
  })

  it('approves Claude Code plans without inserting a fake implementation prompt', async () => {
    resetStores('claude-code')
    const { prompt, planApprove } = installWindowMocks()
    const { result } = renderHook(() => useHarness({ agentSdk: 'claude-code' }))

    await act(async () => {
      await result.current.handlePlanImplement()
    })

    expect(planApprove).toHaveBeenCalledWith(WORKTREE_PATH, SESSION_ID, PENDING_PLAN.requestId)
    expect(prompt).not.toHaveBeenCalled()
    expect(result.current.optimisticTimeline.appendOptimisticUserMessage).not.toHaveBeenCalled()
    expect(result.current.resetLiveOverlay).not.toHaveBeenCalledWith(true)
    expect(result.current.transitionToolStatus).toHaveBeenCalledWith(
      PENDING_PLAN.toolUseID,
      'success'
    )
    expect(useWorktreeStatusStore.getState().sessionStatuses[SESSION_ID]?.status).toBe('working')
    expect(lastSendMode.get(SESSION_ID)).toBe('build')
  })

  it('sends Codex plan implementation with an optimistic user message', async () => {
    const { prompt, planApprove } = installWindowMocks()
    const { result } = renderHook(() => useHarness({ agentSdk: 'codex' }))

    await act(async () => {
      await result.current.handlePlanImplement()
    })

    expect(planApprove).not.toHaveBeenCalled()
    expect(result.current.resetLiveOverlay).toHaveBeenCalledWith(true)
    expect(result.current.optimisticTimeline.appendOptimisticUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        content: 'Implement the plan.'
      })
    )
    expect(prompt).toHaveBeenCalledWith(
      WORKTREE_PATH,
      RUNTIME_SESSION_ID,
      'Implement the plan.',
      { providerID: 'openai', modelID: 'gpt-test' },
      { goalMode: false, successCriteria: '' }
    )
    expect(lastSendMode.get(SESSION_ID)).toBe('build')
  })
})
