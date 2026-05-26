import React from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineMessage } from '../../src/shared/lib/timeline-types'
import type { Attachment } from '../../src/renderer/src/components/sessions/AttachmentPreview'
import { useSessionComposerActions } from '../../src/renderer/src/hooks/useSessionComposerActions'
import { useOptimisticTimelineMessages } from '../../src/renderer/src/hooks/useOptimisticTimelineMessages'
import { useDiffCommentStore } from '../../src/renderer/src/stores/useDiffCommentStore'
import { useSessionRuntimeStore } from '../../src/renderer/src/stores/useSessionRuntimeStore'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

const STORE_SESSION_ID = 'composer-store-session'
const RUNTIME_SESSION_ID = 'composer-runtime-session'
const WORKTREE_PATH = '/tmp/xuanpu-composer-test'

function resetRuntimeStore(): void {
  const state = useSessionRuntimeStore.getState()
  for (const sessionId of state.sessions.keys()) {
    state.clearSession(sessionId)
  }
  for (const sessionId of state.pendingMessages.keys()) {
    state.clearPendingMessages(sessionId)
  }
}

function resetDiffCommentStore(): void {
  useDiffCommentStore.setState({
    commentsByFile: new Map(),
    worktreeComments: new Map(),
    loadingKeys: new Set(),
    errorByKey: new Map(),
    attachedComments: []
  })
}

function installAgentOps(overrides: Partial<Window['agentOps']> = {}): {
  prompt: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
} {
  const prompt = vi.fn().mockResolvedValue({ success: true })
  const steer = vi.fn().mockResolvedValue({ success: true })
  const abort = vi.fn().mockResolvedValue({ success: true, aborted: true })
  Object.defineProperty(window, 'agentOps', {
    writable: true,
    configurable: true,
    value: {
      prompt,
      steer,
      abort,
      ...overrides
    }
  })
  return { prompt, steer, abort }
}

function useHarness(options: {
  goalMode?: boolean
  successCriteria?: string
} = {}) {
  const optimisticRef = React.useRef<TimelineMessage[]>([])
  const timelineMessagesRef = React.useRef<TimelineMessage[]>([])
  const [messages, setMessages] = React.useState<TimelineMessage[]>([])
  const [goalMode, setGoalMode] = React.useState(options.goalMode ?? false)
  const [successCriteria, setSuccessCriteria] = React.useState(options.successCriteria ?? '')
  const resetLiveOverlay = React.useRef(vi.fn()).current
  const requestTurnTopScroll = React.useRef(vi.fn()).current
  const syncOptimisticMessagesToMirror = React.useRef(vi.fn()).current
  const waitForAbortReady = React.useRef(vi.fn().mockResolvedValue(undefined)).current
  const optimisticTimeline = useOptimisticTimelineMessages({
    appendOptimistic: (message) => {
      optimisticRef.current = [...optimisticRef.current, message]
      setMessages((previous) => [...previous, message])
    },
    optimisticRef,
    timelineMessagesRef,
    setMessages,
    syncOptimisticMessagesToMirror,
    requestTurnTopScroll
  })

  const controller = useSessionComposerActions({
    sessionId: STORE_SESSION_ID,
    worktreePath: WORKTREE_PATH,
    runtimeSessionId: RUNTIME_SESSION_ID,
    agentSdk: 'codex',
    requestModel: { providerID: 'openai', modelID: 'gpt-test' },
    promptOptions: { goalMode, successCriteria },
    supportsSessionGoalMode: true,
    goalMode,
    successCriteria,
    setGoalMode,
    setSuccessCriteria,
    optimisticTimeline,
    resetLiveOverlay,
    waitForAbortReady
  })

  return {
    ...controller,
    messages,
    optimisticRef,
    timelineMessagesRef,
    goalMode,
    successCriteria,
    resetLiveOverlay,
    requestTurnTopScroll,
    syncOptimisticMessagesToMirror,
    waitForAbortReady
  }
}

describe('useSessionComposerActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRuntimeStore()
    resetDiffCommentStore()
    vi.mocked(window.systemOps.setSessionQueuedState).mockResolvedValue({ success: true })
  })

  afterEach(() => {
    resetRuntimeStore()
    resetDiffCommentStore()
  })

  it('queues with a queued optimistic bubble without clearing the live overlay', async () => {
    installAgentOps()
    const { result } = renderHook(() => useHarness())

    let consumed = false
    await act(async () => {
      consumed = await result.current.handleComposerAction('queue', 'follow up later', [])
    })

    expect(consumed).toBe(true)
    expect(result.current.optimisticRef.current).toHaveLength(1)
    expect(result.current.optimisticRef.current[0]).toMatchObject({
      role: 'user',
      content: 'follow up later',
      deliveryStatus: 'queued'
    })
    expect(result.current.requestTurnTopScroll).toHaveBeenCalledWith(
      result.current.optimisticRef.current[0].id
    )
    expect(result.current.resetLiveOverlay).not.toHaveBeenCalledWith(true)
    expect(useSessionRuntimeStore.getState().getPendingMessages(STORE_SESSION_ID)[0]).toMatchObject(
      {
        content: 'follow up later',
        agentSessionId: RUNTIME_SESSION_ID,
        runtimeId: 'codex'
      }
    )
  })

  it('keeps a pure stop request out of optimistic state and overlay reset', async () => {
    const { abort, prompt } = installAgentOps()
    const { result } = renderHook(() => useHarness())

    let consumed = true
    await act(async () => {
      consumed = await result.current.handleComposerAction('stop_and_send', '   ', [])
    })

    expect(consumed).toBe(false)
    expect(abort).toHaveBeenCalledWith(WORKTREE_PATH, RUNTIME_SESSION_ID)
    expect(prompt).not.toHaveBeenCalled()
    expect(result.current.optimisticRef.current).toEqual([])
    expect(result.current.resetLiveOverlay).not.toHaveBeenCalled()
  })

  it('restores goal composer state and removes optimistic state when send fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    installAgentOps({
      prompt: vi.fn().mockResolvedValue({ success: false, error: 'provider rejected' })
    })
    const { result } = renderHook(() =>
      useHarness({ goalMode: true, successCriteria: 'focused tests pass' })
    )

    try {
      let consumed = true
      await act(async () => {
        consumed = await result.current.handleComposerAction('send', 'run the tests', [])
      })

      expect(consumed).toBe(false)
      expect(result.current.resetLiveOverlay).toHaveBeenNthCalledWith(1, true)
      expect(result.current.resetLiveOverlay).toHaveBeenLastCalledWith(false)
      expect(result.current.goalMode).toBe(true)
      expect(result.current.successCriteria).toBe('focused tests pass')
      expect(result.current.optimisticRef.current).toEqual([])
      expect(result.current.timelineMessagesRef.current).toEqual([])
      expect(result.current.messages).toEqual([])
    } finally {
      consoleError.mockRestore()
    }
  })

  it('sends diff comment context with attachment message parts and clears consumed comments', async () => {
    const { prompt } = installAgentOps()
    useDiffCommentStore.setState({
      attachedComments: [
        {
          id: 'comment-1',
          worktreeId: 'wt-1',
          filePath: 'src/App.tsx',
          side: 'modified',
          lineNumber: 42,
          compareBranch: 'main',
          staged: false,
          body: 'Please fix this branch.',
          resolved: false,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const attachment: Attachment = {
      kind: 'data',
      id: 'attachment-1',
      name: 'screen.png',
      mime: 'image/png',
      dataUrl: 'data:image/png;base64,abc'
    }
    const { result } = renderHook(() => useHarness())

    let consumed = false
    await act(async () => {
      consumed = await result.current.handleComposerAction('send', 'inspect this', [attachment])
    })

    expect(consumed).toBe(true)
    const sentPayload = prompt.mock.calls[0][2]
    expect(Array.isArray(sentPayload)).toBe(true)
    expect(sentPayload).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'file', filename: 'screen.png' }),
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('<diff-comment file="src/App.tsx"')
        })
      ])
    )
    expect(useDiffCommentStore.getState().attachedComments).toEqual([])
  })
})
