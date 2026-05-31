import React from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineMessage } from '../../src/shared/lib/timeline-types'
import { lastSendMode, messageSendTimes } from '../../src/renderer/src/lib/message-send-times'
import { useOptimisticTimelineMessages } from '../../src/renderer/src/hooks/useOptimisticTimelineMessages'
import { usePendingInitialMessageSender } from '../../src/renderer/src/hooks/usePendingInitialMessageSender'
import {
  useSessionStore,
  type PendingPromptOptions
} from '../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStatusStore } from '../../src/renderer/src/stores/useWorktreeStatusStore'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

const SESSION_ID = 'pending-initial-session'
const RUNTIME_SESSION_ID = 'pending-initial-runtime'
const WORKTREE_PATH = '/tmp/pending-initial'
const REQUEST_MODEL = { providerID: 'openai', modelID: 'gpt-test' }

function installAgentOps(prompt = vi.fn().mockResolvedValue({ success: true })): {
  prompt: ReturnType<typeof vi.fn>
} {
  Object.defineProperty(window, 'agentOps', {
    writable: true,
    configurable: true,
    value: { prompt }
  })
  return { prompt }
}

function resetStores(): void {
  useSessionStore.setState({
    pendingMessages: new Map(),
    pendingMessageOptions: new Map(),
    modeBySession: new Map(),
    sessionsByWorktree: new Map(),
    sessionsByConnection: new Map()
  })
  useWorktreeStatusStore.setState({
    sessionStatuses: {},
    lastMessageTimeByWorktree: {}
  })
  messageSendTimes.clear()
  lastSendMode.clear()
}

function useHarness() {
  const [messages, setMessages] = React.useState<TimelineMessage[]>([])
  const optimisticRef = React.useRef<TimelineMessage[]>([])
  const timelineMessagesRef = React.useRef<TimelineMessage[]>([])
  const resetLiveOverlay = React.useRef(vi.fn()).current
  const requestTurnTopScroll = React.useRef(vi.fn()).current
  const syncOptimisticMessagesToMirror = React.useRef(vi.fn()).current
  const buildPendingPromptOptions = React.useCallback(
    (options?: PendingPromptOptions) => options,
    []
  )
  const appendOptimistic = React.useCallback(
    (message: TimelineMessage) => {
      optimisticRef.current = [...optimisticRef.current, message]
      setMessages((previous) => [...previous, message])
    },
    []
  )
  const optimisticTimeline = useOptimisticTimelineMessages({
    appendOptimistic,
    optimisticRef,
    timelineMessagesRef,
    setMessages,
    syncOptimisticMessagesToMirror,
    requestTurnTopScroll
  })

  usePendingInitialMessageSender({
    sessionId: SESSION_ID,
    worktreePath: WORKTREE_PATH,
    runtimeSessionId: RUNTIME_SESSION_ID,
    mode: 'build',
    requestModel: REQUEST_MODEL,
    buildPendingPromptOptions,
    optimisticTimeline,
    resetLiveOverlay
  })

  return {
    messages,
    optimisticRef,
    timelineMessagesRef,
    resetLiveOverlay,
    requestTurnTopScroll,
    syncOptimisticMessagesToMirror
  }
}

describe('usePendingInitialMessageSender', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStores()
  })

  it('sends a pending initial message with launch options and optimistic state', async () => {
    const { prompt } = installAgentOps()
    useSessionStore.getState().setPendingMessage(SESSION_ID, 'launch prompt', {
      mode: 'plan',
      goalMode: true,
      successCriteria: 'focused tests pass'
    })

    const { result } = renderHook(() => useHarness())

    await waitFor(() => expect(prompt).toHaveBeenCalledOnce())

    expect(prompt).toHaveBeenCalledWith(
      WORKTREE_PATH,
      RUNTIME_SESSION_ID,
      'launch prompt',
      REQUEST_MODEL,
      {
        mode: 'plan',
        goalMode: true,
        successCriteria: 'focused tests pass'
      }
    )
    expect(result.current.resetLiveOverlay).toHaveBeenCalledWith(true)
    expect(result.current.requestTurnTopScroll).toHaveBeenCalledWith(
      result.current.optimisticRef.current[0].id
    )
    expect(result.current.optimisticRef.current[0]).toMatchObject({
      role: 'user',
      content: 'launch prompt'
    })
    expect(useSessionStore.getState().dequeuePendingMessageWithOptions(SESSION_ID)).toBeNull()
    expect(useWorktreeStatusStore.getState().sessionStatuses[SESSION_ID]?.status).toBe('planning')
    expect(lastSendMode.get(SESSION_ID)).toBe('plan')
    expect(messageSendTimes.has(SESSION_ID)).toBe(true)
  })

  it('requeues and rolls back the optimistic message when send fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { prompt } = installAgentOps(
      vi.fn().mockResolvedValue({ success: false, error: 'provider rejected' })
    )
    useSessionStore.getState().setPendingMessage(SESSION_ID, 'launch prompt', {
      mode: 'build'
    })

    try {
      const { result } = renderHook(() => useHarness())

      await waitFor(() => expect(prompt).toHaveBeenCalledOnce())
      await waitFor(() => expect(result.current.optimisticRef.current).toEqual([]))

      expect(result.current.messages).toEqual([])
      expect(result.current.timelineMessagesRef.current).toEqual([])
      expect(result.current.resetLiveOverlay).toHaveBeenNthCalledWith(1, true)
      expect(result.current.resetLiveOverlay).toHaveBeenLastCalledWith(false)
      expect(useWorktreeStatusStore.getState().sessionStatuses[SESSION_ID]).toBeNull()
      expect(useSessionStore.getState().dequeuePendingMessageWithOptions(SESSION_ID)).toEqual({
        message: 'launch prompt',
        options: { mode: 'build' }
      })
    } finally {
      consoleError.mockRestore()
    }
  })
})
