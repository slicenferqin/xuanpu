import { act, renderHook } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineMessage } from '../../src/shared/lib/timeline-types'
import {
  useSessionUserMessageActions,
  type SessionRecordForUserMessageActions
} from '../../src/renderer/src/hooks/useSessionUserMessageActions'
import type { OptimisticTimelineMessagesController } from '../../src/renderer/src/hooks/useOptimisticTimelineMessages'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

const STORE_SESSION_ID = 'user-actions-store-session'
const RUNTIME_SESSION_ID = 'user-actions-runtime-session'
const WORKTREE_PATH = '/tmp/xuanpu-user-actions'

function makeUserMessage(id: string, content: string, timestamp = '2026-05-26T00:00:00.000Z') {
  return {
    id,
    role: 'user' as const,
    content,
    timestamp
  }
}

function makeAssistantMessage(
  id: string,
  content: string,
  timestamp = '2026-05-26T00:00:01.000Z'
): TimelineMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp
  }
}

function makeSessionRecord(
  overrides: Partial<SessionRecordForUserMessageActions> = {}
): SessionRecordForUserMessageActions {
  return {
    id: STORE_SESSION_ID,
    worktree_id: 'worktree-1',
    project_id: 'project-1',
    name: 'Source session',
    model_provider_id: 'openai',
    model_id: 'gpt-test',
    model_variant: 'fast',
    ...overrides
  }
}

function installAgentOps(overrides: Partial<Window['agentOps']> = {}): {
  prompt: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  fork: ReturnType<typeof vi.fn>
} {
  const prompt = vi.fn().mockResolvedValue({ success: true })
  const abort = vi.fn().mockResolvedValue({ success: true, aborted: true })
  const fork = vi.fn().mockResolvedValue({ success: true, sessionId: 'fork-runtime-session' })
  Object.defineProperty(window, 'agentOps', {
    writable: true,
    configurable: true,
    value: {
      prompt,
      abort,
      fork,
      ...overrides
    }
  })
  return { prompt, abort, fork }
}

function installDb(
  overrides: {
    sessionGet?: ReturnType<typeof vi.fn>
    sessionCreate?: ReturnType<typeof vi.fn>
  } = {}
): {
  sessionGet: ReturnType<typeof vi.fn>
  sessionCreate: ReturnType<typeof vi.fn>
} {
  const sessionGet = overrides.sessionGet ?? vi.fn().mockResolvedValue(null)
  const sessionCreate =
    overrides.sessionCreate ?? vi.fn().mockResolvedValue({ id: 'forked-session-id' })
  Object.defineProperty(window, 'db', {
    writable: true,
    configurable: true,
    value: {
      session: {
        get: sessionGet,
        create: sessionCreate
      }
    }
  })
  return { sessionGet, sessionCreate }
}

function makeOptimisticTimeline(): OptimisticTimelineMessagesController {
  return {
    appendOptimisticUserMessage: vi.fn(),
    removeOptimisticUserMessage: vi.fn(),
    trimOptimisticMessagesToTimeline: vi.fn()
  }
}

function useHarness(options: {
  timelineMessages: TimelineMessage[]
  latestUserMessageId?: string | null
  sessionRecord?: SessionRecordForUserMessageActions | null
  lifecycle?: 'idle' | 'busy' | 'retry' | 'error' | 'materializing'
  isStreaming?: boolean
  optimisticTimeline?: OptimisticTimelineMessagesController
}): ReturnType<typeof useSessionUserMessageActions> & {
  optimisticTimeline: OptimisticTimelineMessagesController
  resetLiveOverlay: ReturnType<typeof vi.fn>
} {
  const optimisticTimeline = React.useRef(
    options.optimisticTimeline ?? makeOptimisticTimeline()
  ).current
  const resetLiveOverlay = React.useRef(vi.fn()).current
  const controller = useSessionUserMessageActions({
    sessionId: STORE_SESSION_ID,
    worktreePath: WORKTREE_PATH,
    runtimeSessionId: RUNTIME_SESSION_ID,
    agentSdk: 'codex',
    sessionRecord: options.sessionRecord ?? makeSessionRecord(),
    worktreeId: 'worktree-1',
    timelineMessages: options.timelineMessages,
    latestUserMessageId:
      options.latestUserMessageId ??
      [...options.timelineMessages].reverse().find((message) => message.role === 'user')?.id ??
      null,
    isStreaming: options.isStreaming ?? false,
    lifecycle: options.lifecycle ?? 'idle',
    requestModel: { providerID: 'openai', modelID: 'gpt-test' },
    promptOptions: { goalMode: false, successCriteria: '' },
    optimisticTimeline,
    resetLiveOverlay,
    t: (key) => key
  })

  return {
    ...controller,
    optimisticTimeline,
    resetLiveOverlay
  }
}

describe('useSessionUserMessageActions', () => {
  const originalLoadSessions = useSessionStore.getState().loadSessions
  const originalSetActiveSession = useSessionStore.getState().setActiveSession
  const originalUpdateSetting = useSettingsStore.getState().updateSetting
  const originalSkipForkConfirm = useSettingsStore.getState().skipForkFromMessageConfirm

  beforeEach(() => {
    vi.clearAllMocks()
    useSessionStore.setState({
      loadSessions: vi.fn().mockResolvedValue(undefined),
      setActiveSession: vi.fn()
    })
    useSettingsStore.setState({
      skipForkFromMessageConfirm: false,
      updateSetting: vi.fn()
    })
    installAgentOps()
    installDb()
  })

  afterEach(() => {
    useSessionStore.setState({
      loadSessions: originalLoadSessions,
      setActiveSession: originalSetActiveSession
    })
    useSettingsStore.setState({
      skipForkFromMessageConfirm: originalSkipForkConfirm,
      updateSetting: originalUpdateSetting
    })
  })

  it('edits the latest user message by trimming the timeline and resending the restored content', async () => {
    const userMessage = makeUserMessage('user-1', 'original content')
    const { prompt } = installAgentOps()
    const { result } = renderHook(() => useHarness({ timelineMessages: [userMessage] }))

    act(() => {
      result.current.handleEditUserMessage(userMessage)
    })
    expect(result.current.editingMessageId).toBe('user-1')
    expect(result.current.editingContent).toBe('original content')

    act(() => {
      result.current.setEditingContent(' edited content ')
    })

    await act(async () => {
      await result.current.handleSaveUserMessageEdit('user-1')
    })

    expect(result.current.optimisticTimeline.trimOptimisticMessagesToTimeline).toHaveBeenCalledWith(
      []
    )
    expect(result.current.optimisticTimeline.appendOptimisticUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        content: 'edited content'
      }),
      { baseMessages: [] }
    )
    expect(result.current.resetLiveOverlay).toHaveBeenCalledWith(true)
    expect(prompt).toHaveBeenCalledWith(
      WORKTREE_PATH,
      RUNTIME_SESSION_ID,
      'edited content',
      { providerID: 'openai', modelID: 'gpt-test' },
      { goalMode: false, successCriteria: '' }
    )
    expect(result.current.editingMessageId).toBeNull()
    expect(result.current.editingContent).toBe('')
  })

  it('opens confirmation for fork and then creates a forked session from the selected cutoff', async () => {
    const selectedUser = makeUserMessage('user-1', 'first')
    const cutoffAssistant = makeAssistantMessage('assistant-1', 'reply')
    const laterUser = makeUserMessage('user-2', 'second', '2026-05-26T00:00:02.000Z')
    const { fork } = installAgentOps()
    const { sessionCreate } = installDb()
    const { result } = renderHook(() =>
      useHarness({ timelineMessages: [selectedUser, cutoffAssistant, laterUser] })
    )

    await act(async () => {
      await result.current.handleForkUserMessage(selectedUser)
    })

    expect(result.current.forkConfirmOpen).toBe(true)
    expect(fork).not.toHaveBeenCalled()

    act(() => {
      result.current.setForkConfirmDismissChecked(true)
    })

    await act(async () => {
      await result.current.handleConfirmForkFromMessage()
    })

    expect(useSettingsStore.getState().updateSetting).toHaveBeenCalledWith(
      'skipForkFromMessageConfirm',
      true
    )
    expect(fork).toHaveBeenCalledWith(WORKTREE_PATH, RUNTIME_SESSION_ID, 'assistant-1')
    expect(sessionCreate).toHaveBeenCalledWith({
      worktree_id: 'worktree-1',
      project_id: 'project-1',
      name: 'Source session (fork)',
      opencode_session_id: 'fork-runtime-session',
      model_provider_id: 'openai',
      model_id: 'gpt-test',
      model_variant: 'fast'
    })
    expect(useSessionStore.getState().loadSessions).toHaveBeenCalledWith('worktree-1', 'project-1')
    expect(useSessionStore.getState().setActiveSession).toHaveBeenCalledWith('forked-session-id')
    expect(result.current.forkConfirmOpen).toBe(false)
  })
})
