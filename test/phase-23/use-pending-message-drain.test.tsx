import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPendingMessage,
  _resetPendingIdCounter
} from '../../src/renderer/src/lib/session-send-actions'
import { usePendingMessageDrain } from '../../src/renderer/src/hooks/usePendingMessageDrain'
import { useSessionRuntimeStore } from '../../src/renderer/src/stores/useSessionRuntimeStore'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStatusStore } from '../../src/renderer/src/stores/useWorktreeStatusStore'
import type { Attachment } from '../../src/renderer/src/components/sessions/AttachmentPreview'

const SESSION_ID = 'pending-drain-session'
const RUNTIME_SESSION_ID = 'pending-drain-runtime'
const WORKTREE_PATH = '/tmp/pending-drain'
const WORKTREE_ID = 'pending-drain-worktree'

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

function resetRuntimeStore(): void {
  const state = useSessionRuntimeStore.getState()
  for (const sessionId of state.sessions.keys()) {
    state.clearSession(sessionId)
  }
  for (const sessionId of state.pendingMessages.keys()) {
    state.clearPendingMessages(sessionId)
  }
}

function resetStores(): void {
  resetRuntimeStore()
  useSessionStore.setState({
    sessionsByWorktree: new Map([[WORKTREE_ID, [{ id: SESSION_ID } as never]]])
  })
  useWorktreeStatusStore.setState({
    sessionStatuses: {},
    lastMessageTimeByWorktree: {}
  })
  _resetPendingIdCounter()
}

function useHarness(options: {
  lifecycle?: 'idle' | 'busy'
  pendingCount?: number
} = {}) {
  return usePendingMessageDrain({
    sessionId: SESSION_ID,
    worktreePath: WORKTREE_PATH,
    runtimeSessionId: RUNTIME_SESSION_ID,
    lifecycle: options.lifecycle ?? 'idle',
    pendingCount: options.pendingCount ?? 0,
    requestModel: { providerID: 'fallback-provider', modelID: 'fallback-model' },
    promptOptions: { goalMode: false, successCriteria: '' }
  })
}

describe('usePendingMessageDrain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(window.systemOps.setSessionQueuedState).mockResolvedValue({ success: true })
    resetStores()
  })

  it('auto-drains queued messages while idle and rebuilds attachment message parts', async () => {
    const { prompt } = installAgentOps()
    const attachment: Attachment = {
      kind: 'data',
      id: 'attachment-1',
      name: 'screen.png',
      mime: 'image/png',
      dataUrl: 'data:image/png;base64,abc'
    }
    const queued = createPendingMessage('queued follow-up', [attachment], {
      model: { providerID: 'openai', modelID: 'gpt-test' },
      promptOptions: { goalMode: true, successCriteria: 'green tests' }
    })
    useSessionRuntimeStore.getState().queueMessage(SESSION_ID, queued)

    renderHook(() => useHarness({ lifecycle: 'idle', pendingCount: 1 }))

    await waitFor(() => expect(prompt).toHaveBeenCalledOnce())

    expect(prompt).toHaveBeenCalledWith(
      WORKTREE_PATH,
      RUNTIME_SESSION_ID,
      [
        {
          type: 'file',
          mime: 'image/png',
          url: 'data:image/png;base64,abc',
          filename: 'screen.png'
        },
        { type: 'text', text: 'queued follow-up' }
      ],
      { providerID: 'openai', modelID: 'gpt-test' },
      { goalMode: true, successCriteria: 'green tests' }
    )
    expect(useSessionRuntimeStore.getState().getPendingCount(SESSION_ID)).toBe(0)
    await waitFor(() =>
      expect(useWorktreeStatusStore.getState().lastMessageTimeByWorktree[WORKTREE_ID]).toBeTruthy()
    )
  })

  it('restores a claimed queued message when provider send fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    installAgentOps(vi.fn().mockResolvedValue({ success: false, error: 'provider busy' }))
    useSessionRuntimeStore
      .getState()
      .queueMessage(SESSION_ID, createPendingMessage('retry follow-up'))
    const { result } = renderHook(() => useHarness({ lifecycle: 'busy', pendingCount: 1 }))

    try {
      let drained = true
      await act(async () => {
        drained = await result.current.drainQueuedMessage()
      })

      expect(drained).toBe(false)
      expect(useSessionRuntimeStore.getState().getPendingMessages(SESSION_ID)[0]).toMatchObject({
        content: 'retry follow-up',
        status: 'pending'
      })
    } finally {
      consoleError.mockRestore()
    }
  })
})
