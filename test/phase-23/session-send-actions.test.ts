import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module under test
// Vitest resolves @/ aliases via vitest.config.ts, so no mocking needed.
// ---------------------------------------------------------------------------

import {
  determineComposerActions,
  executeSendAction,
  drainNextPending,
  createPendingMessage,
  getActionLabel,
  _resetPendingIdCounter,
  type ComposerInput
} from '../../src/renderer/src/lib/session-send-actions'

import { useSessionRuntimeStore } from '../../src/renderer/src/stores/useSessionRuntimeStore'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<ComposerInput> = {}): ComposerInput {
  return {
    lifecycle: 'idle',
    hasInterrupt: false,
    hasPendingMessages: false,
    isConnected: true,
    ...overrides
  }
}

function makeSendContext(overrides: Partial<Parameters<typeof executeSendAction>[3]> = {}) {
  return {
    worktreePath: '/test/path',
    sessionId: 'sess-1',
    prompt: vi.fn().mockResolvedValue({ success: true }),
    steer: vi.fn().mockResolvedValue({ success: true }),
    abort: vi.fn().mockResolvedValue({ success: true }),
    queueMessage: vi.fn(),
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetPendingIdCounter()
  // Reset store state
  const state = useSessionRuntimeStore.getState()
  for (const sessionId of state.sessions.keys()) {
    state.clearSession(sessionId)
  }
  for (const sessionId of state.pendingMessages.keys()) {
    state.clearPendingMessages(sessionId)
  }
})

// ===========================================================================
// determineComposerActions — state machine
// ===========================================================================

describe('determineComposerActions', () => {
  describe('disconnected state', () => {
    it('returns disabled when not connected', () => {
      const result = determineComposerActions(makeInput({ isConnected: false }))
      expect(result.primary).toBeNull()
      expect(result.inputEnabled).toBe(false)
      expect(result.iconHint).toBe('disabled')
      expect(result.primaryLabel).toBe('Disconnected')
      expect(result.alternatives).toHaveLength(0)
    })

    it('disconnected takes priority over everything', () => {
      const result = determineComposerActions(
        makeInput({
          isConnected: false,
          lifecycle: 'busy',
          hasInterrupt: true
        })
      )
      expect(result.primary).toBeNull()
      expect(result.iconHint).toBe('disabled')
    })
  })

  describe('interrupt state', () => {
    it('returns reply_interrupt when interrupt is pending', () => {
      const result = determineComposerActions(
        makeInput({ hasInterrupt: true })
      )
      expect(result.primary).toBe('reply_interrupt')
      expect(result.inputEnabled).toBe(true)
      expect(result.iconHint).toBe('reply')
      expect(result.primaryLabel).toBe('Reply')
      expect(result.alternatives).toHaveLength(0)
    })

    it('interrupt takes priority over busy lifecycle', () => {
      const result = determineComposerActions(
        makeInput({ hasInterrupt: true, lifecycle: 'busy' })
      )
      expect(result.primary).toBe('reply_interrupt')
    })
  })

  describe('idle lifecycle', () => {
    it('returns send action', () => {
      const result = determineComposerActions(makeInput({ lifecycle: 'idle' }))
      expect(result.primary).toBe('send')
      expect(result.inputEnabled).toBe(true)
      expect(result.iconHint).toBe('send')
      expect(result.primaryLabel).toBe('Send')
      expect(result.alternatives).toHaveLength(0)
    })

    it('shows queued indicator when pending messages exist', () => {
      const result = determineComposerActions(
        makeInput({ lifecycle: 'idle', hasPendingMessages: true })
      )
      expect(result.primary).toBe('send')
      expect(result.primaryLabel).toBe('Send (queued)')
    })
  })

  describe('error lifecycle', () => {
    it('returns send action (same as idle)', () => {
      const result = determineComposerActions(makeInput({ lifecycle: 'error' }))
      expect(result.primary).toBe('send')
      expect(result.inputEnabled).toBe(true)
      expect(result.iconHint).toBe('send')
    })
  })

  describe('busy lifecycle', () => {
    it('returns stop_and_send with queue and steer alternatives', () => {
      const result = determineComposerActions(makeInput({ lifecycle: 'busy', supportsSteer: true }))
      expect(result.primary).toBe('stop_and_send')
      expect(result.inputEnabled).toBe(true)
      expect(result.iconHint).toBe('stop')
      expect(result.primaryLabel).toBe('Stop')
      expect(result.alternatives).toEqual(['queue', 'steer'])
    })

    it('omits steer when runtime does not support it', () => {
      const result = determineComposerActions(makeInput({ lifecycle: 'busy', supportsSteer: false }))
      expect(result.alternatives).toEqual(['queue'])
    })
  })

  describe('materializing lifecycle', () => {
    it('returns stop_and_send (same as busy)', () => {
      const result = determineComposerActions(
        makeInput({ lifecycle: 'materializing', supportsSteer: true })
      )
      expect(result.primary).toBe('stop_and_send')
      expect(result.alternatives).toEqual(['queue', 'steer'])
    })
  })

  describe('retry lifecycle', () => {
    it('returns queue as primary with stop_and_send alternative', () => {
      const result = determineComposerActions(makeInput({ lifecycle: 'retry' }))
      expect(result.primary).toBe('queue')
      expect(result.inputEnabled).toBe(true)
      expect(result.iconHint).toBe('queue')
      expect(result.primaryLabel).toBe('Queue')
      expect(result.alternatives).toEqual(['stop_and_send'])
    })
  })
})

// ===========================================================================
// getActionLabel
// ===========================================================================

describe('getActionLabel', () => {
  it('returns labels for all actions', () => {
    expect(getActionLabel('send')).toBe('Send')
    expect(getActionLabel('queue')).toBe('Queue for later')
    expect(getActionLabel('steer')).toBe('Steer (redirect agent)')
    expect(getActionLabel('stop_and_send')).toBe('Stop & Send')
    expect(getActionLabel('reply_interrupt')).toBe('Reply')
  })
})

// ===========================================================================
// createPendingMessage
// ===========================================================================

describe('createPendingMessage', () => {
  it('creates a pending message with incrementing id', () => {
    const msg1 = createPendingMessage('hello')
    const msg2 = createPendingMessage('world')
    expect(msg1.id).toBe('pending-1')
    expect(msg2.id).toBe('pending-2')
  })

  it('stores content and attachments', () => {
    const attachments = [{ kind: 'data', id: 'a1', name: 'file.txt', mime: 'text/plain' }]
    const msg = createPendingMessage('test', attachments as never[])
    expect(msg.content).toBe('test')
    expect(msg.attachments).toEqual(attachments)
    expect(msg.queuedAt).toBeGreaterThan(0)
  })

  it('defaults attachments to empty array', () => {
    const msg = createPendingMessage('test')
    expect(msg.attachments).toEqual([])
  })

  it('resets counter with _resetPendingIdCounter', () => {
    createPendingMessage('a')
    createPendingMessage('b')
    _resetPendingIdCounter()
    const msg = createPendingMessage('c')
    expect(msg.id).toBe('pending-1')
  })
})

// ===========================================================================
// executeSendAction
// ===========================================================================

describe('executeSendAction', () => {
  it('send: calls prompt and returns true', async () => {
    const ctx = makeSendContext()
    const result = await executeSendAction('send', 'hello', [], ctx)
    expect(result).toBe(true)
    expect(ctx.prompt).toHaveBeenCalledWith('/test/path', 'sess-1', 'hello')
    expect(ctx.abort).not.toHaveBeenCalled()
  })

  it('queue: creates pending message and calls queueMessage', async () => {
    const ctx = makeSendContext()
    const result = await executeSendAction('queue', 'later', [], ctx)
    expect(result).toBe(true)
    expect(ctx.queueMessage).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      content: 'later',
      id: expect.stringMatching(/^pending-/)
    }))
    expect(ctx.prompt).not.toHaveBeenCalled()
  })

  it('steer: calls steer IPC (sends while busy)', async () => {
    const ctx = makeSendContext()
    const result = await executeSendAction('steer', 'change direction', [], ctx)
    expect(result).toBe(true)
    expect(ctx.steer).toHaveBeenCalledWith('/test/path', 'sess-1', 'change direction')
  })

  it('steer: rejects attachments', async () => {
    const ctx = makeSendContext()
    await expect(
      executeSendAction(
        'steer',
        'change direction',
        [{ kind: 'data', id: 'a1', name: 'image.png', mime: 'image/png' }],
        ctx
      )
    ).rejects.toThrow('Steer only supports text messages')
  })

  it('stop_and_send: calls abort then prompt', async () => {
    const ctx = makeSendContext()
    const callOrder: string[] = []
    ctx.abort.mockImplementation(async () => {
      callOrder.push('abort')
      return { success: true }
    })
    ctx.prompt.mockImplementation(async () => {
      callOrder.push('prompt')
      return { success: true }
    })

    const result = await executeSendAction('stop_and_send', 'new task', [], ctx)
    expect(result).toBe(true)
    expect(callOrder).toEqual(['abort', 'prompt'])
    expect(ctx.abort).toHaveBeenCalledWith('/test/path', 'sess-1')
    expect(ctx.prompt).toHaveBeenCalledWith('/test/path', 'sess-1', 'new task')
  })

  it('reply_interrupt: calls prompt', async () => {
    const ctx = makeSendContext()
    const result = await executeSendAction('reply_interrupt', 'yes', [], ctx)
    expect(result).toBe(true)
    expect(ctx.prompt).toHaveBeenCalledWith('/test/path', 'sess-1', 'yes')
  })
})

// ===========================================================================
// drainNextPending
// ===========================================================================

describe('drainNextPending', () => {
  it('returns false when queue is empty', async () => {
    const dequeue = vi.fn().mockReturnValue(null)
    const prompt = vi.fn().mockResolvedValue({ success: true })
    const result = await drainNextPending('sess-1', 'agent-sess-1', dequeue, prompt, '/path')
    expect(result).toBe(false)
    expect(prompt).not.toHaveBeenCalled()
  })

  it('dequeues and sends when queue has messages', async () => {
    const pending = createPendingMessage('queued message')
    const dequeue = vi.fn().mockReturnValue(pending)
    const prompt = vi.fn().mockResolvedValue({ success: true })

    const result = await drainNextPending('sess-1', 'agent-sess-1', dequeue, prompt, '/path')
    expect(result).toBe(true)
    expect(dequeue).toHaveBeenCalledWith('sess-1')
    expect(prompt).toHaveBeenCalledWith('/path', 'agent-sess-1', 'queued message')
  })
})

// ===========================================================================
// Store integration — pendingMessages
// ===========================================================================

describe('useSessionRuntimeStore pending messages', () => {
  it('syncs queued-state true when queueing a message', () => {
    const syncSpy = vi.spyOn(window.systemOps, 'setSessionQueuedState')
    const store = useSessionRuntimeStore.getState()
    store.queueMessage('sess-1', createPendingMessage('test'))
    expect(syncSpy).toHaveBeenCalledWith('sess-1', true)
  })

  it('queues and retrieves pending messages', () => {
    const store = useSessionRuntimeStore.getState()
    const msg = createPendingMessage('test')
    store.queueMessage('sess-1', msg)

    expect(store.getPendingMessages('sess-1')).toHaveLength(1)
    expect(store.getPendingCount('sess-1')).toBe(1)
    expect(store.getPendingMessages('sess-1')[0].content).toBe('test')
  })

  it('dequeues in FIFO order', () => {
    const store = useSessionRuntimeStore.getState()
    store.queueMessage('sess-1', createPendingMessage('first'))
    store.queueMessage('sess-1', createPendingMessage('second'))
    store.queueMessage('sess-1', createPendingMessage('third'))

    const first = store.dequeueMessage('sess-1')
    expect(first?.content).toBe('first')
    expect(useSessionRuntimeStore.getState().getPendingCount('sess-1')).toBe(2)

    const second = useSessionRuntimeStore.getState().dequeueMessage('sess-1')
    expect(second?.content).toBe('second')
    expect(useSessionRuntimeStore.getState().getPendingCount('sess-1')).toBe(1)
  })

  it('dequeueMessage returns null for empty queue', () => {
    const result = useSessionRuntimeStore.getState().dequeueMessage('nonexistent')
    expect(result).toBeNull()
  })

  it('dequeueMessage cleans up Map entry when queue is emptied', () => {
    const syncSpy = vi.spyOn(window.systemOps, 'setSessionQueuedState')
    const store = useSessionRuntimeStore.getState()
    store.queueMessage('sess-1', createPendingMessage('only'))
    store.dequeueMessage('sess-1')
    expect(useSessionRuntimeStore.getState().pendingMessages.has('sess-1')).toBe(false)
    expect(syncSpy).toHaveBeenLastCalledWith('sess-1', false)
  })

  it('clearPendingMessages removes all pending for session', () => {
    const syncSpy = vi.spyOn(window.systemOps, 'setSessionQueuedState')
    const store = useSessionRuntimeStore.getState()
    store.queueMessage('sess-1', createPendingMessage('a'))
    store.queueMessage('sess-1', createPendingMessage('b'))
    store.clearPendingMessages('sess-1')
    expect(useSessionRuntimeStore.getState().getPendingCount('sess-1')).toBe(0)
    expect(syncSpy).toHaveBeenLastCalledWith('sess-1', false)
  })

  it('clearPendingMessages is no-op for unknown session', () => {
    const before = useSessionRuntimeStore.getState()
    before.clearPendingMessages('nonexistent')
    // Should not change state reference when session doesn't exist
    expect(useSessionRuntimeStore.getState().pendingMessages.has('nonexistent')).toBe(false)
  })

  it('getPendingMessages returns empty array for unknown session', () => {
    expect(useSessionRuntimeStore.getState().getPendingMessages('none')).toEqual([])
  })

  it('getPendingCount returns 0 for unknown session', () => {
    expect(useSessionRuntimeStore.getState().getPendingCount('none')).toBe(0)
  })

  it('clearSession also clears pending messages', () => {
    const syncSpy = vi.spyOn(window.systemOps, 'setSessionQueuedState')
    const store = useSessionRuntimeStore.getState()
    store.queueMessage('sess-1', createPendingMessage('test'))
    store.setLifecycle('sess-1', 'busy')
    store.clearSession('sess-1')
    expect(useSessionRuntimeStore.getState().getPendingCount('sess-1')).toBe(0)
    expect(useSessionRuntimeStore.getState().pendingMessages.has('sess-1')).toBe(false)
    expect(syncSpy).toHaveBeenLastCalledWith('sess-1', false)
  })

  it('maintains separate queues per session', () => {
    const store = useSessionRuntimeStore.getState()
    store.queueMessage('sess-A', createPendingMessage('alpha'))
    store.queueMessage('sess-B', createPendingMessage('beta'))
    store.queueMessage('sess-B', createPendingMessage('gamma'))

    expect(useSessionRuntimeStore.getState().getPendingCount('sess-A')).toBe(1)
    expect(useSessionRuntimeStore.getState().getPendingCount('sess-B')).toBe(2)
  })
})

// ===========================================================================
// End-to-end: state machine → action execution
// ===========================================================================

describe('end-to-end: state machine → execute', () => {
  it('idle session: determine send → execute send', async () => {
    const actions = determineComposerActions(makeInput({ lifecycle: 'idle' }))
    expect(actions.primary).toBe('send')

    const ctx = makeSendContext()
    const consumed = await executeSendAction(actions.primary!, 'hello', [], ctx)
    expect(consumed).toBe(true)
    expect(ctx.prompt).toHaveBeenCalledTimes(1)
  })

  it('busy session: determine stop → execute stop_and_send', async () => {
    const actions = determineComposerActions(makeInput({ lifecycle: 'busy' }))
    expect(actions.primary).toBe('stop_and_send')

    const ctx = makeSendContext()
    const consumed = await executeSendAction(actions.primary!, 'urgent', [], ctx)
    expect(consumed).toBe(true)
    expect(ctx.abort).toHaveBeenCalledTimes(1)
    expect(ctx.prompt).toHaveBeenCalledTimes(1)
  })

  it('busy session: choose queue alternative → message is queued', async () => {
    const actions = determineComposerActions(makeInput({ lifecycle: 'busy' }))
    expect(actions.alternatives).toContain('queue')

    const ctx = makeSendContext()
    const consumed = await executeSendAction('queue', 'for later', [], ctx)
    expect(consumed).toBe(true)
    expect(ctx.queueMessage).toHaveBeenCalledTimes(1)
    expect(ctx.prompt).not.toHaveBeenCalled()
  })

  it('retry session: determine queue → execute queue', async () => {
    const actions = determineComposerActions(makeInput({ lifecycle: 'retry' }))
    expect(actions.primary).toBe('queue')

    const ctx = makeSendContext()
    const consumed = await executeSendAction(actions.primary!, 'pending', [], ctx)
    expect(consumed).toBe(true)
    expect(ctx.queueMessage).toHaveBeenCalledTimes(1)
  })

  it('interrupt: determine reply → execute reply_interrupt', async () => {
    const actions = determineComposerActions(
      makeInput({ hasInterrupt: true })
    )
    expect(actions.primary).toBe('reply_interrupt')

    const ctx = makeSendContext()
    const consumed = await executeSendAction(actions.primary!, 'yes', [], ctx)
    expect(consumed).toBe(true)
    expect(ctx.prompt).toHaveBeenCalledTimes(1)
  })
})
