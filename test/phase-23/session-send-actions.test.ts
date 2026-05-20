import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module under test
// Vitest resolves @/ aliases via vitest.config.ts, so no mocking needed.
// ---------------------------------------------------------------------------

import {
  createPendingDrainController,
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
    hasDraftContent: false,
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
      const result = determineComposerActions(makeInput({ hasInterrupt: true }))
      expect(result.primary).toBe('reply_interrupt')
      expect(result.inputEnabled).toBe(true)
      expect(result.iconHint).toBe('reply')
      expect(result.primaryLabel).toBe('Reply')
      expect(result.alternatives).toHaveLength(0)
    })

    it('interrupt takes priority over busy lifecycle', () => {
      const result = determineComposerActions(makeInput({ hasInterrupt: true, lifecycle: 'busy' }))
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
    it('returns stop_and_send with queue and steer alternatives when no draft exists', () => {
      const result = determineComposerActions(makeInput({ lifecycle: 'busy', supportsSteer: true }))
      expect(result.primary).toBe('stop_and_send')
      expect(result.inputEnabled).toBe(true)
      expect(result.iconHint).toBe('stop')
      expect(result.primaryLabel).toBe('Stop')
      expect(result.alternatives).toEqual(['queue', 'steer'])
    })

    it('omits steer when runtime does not support it', () => {
      const result = determineComposerActions(
        makeInput({ lifecycle: 'busy', supportsSteer: false })
      )
      expect(result.alternatives).toEqual(['queue'])
    })

    it('returns queue with steer and stop alternatives when draft content exists', () => {
      const result = determineComposerActions(
        makeInput({ lifecycle: 'busy', hasDraftContent: true, supportsSteer: true })
      )
      expect(result.primary).toBe('queue')
      expect(result.inputEnabled).toBe(true)
      expect(result.iconHint).toBe('queue')
      expect(result.primaryLabel).toBe('Queue')
      expect(result.alternatives).toEqual(['steer', 'stop_and_send'])
    })

    it('returns steer as primary when a runtime prefers steering active busy turns', () => {
      const result = determineComposerActions(
        makeInput({
          lifecycle: 'busy',
          hasDraftContent: true,
          supportsSteer: true,
          preferSteerWhenBusy: true
        })
      )
      expect(result.primary).toBe('steer')
      expect(result.inputEnabled).toBe(true)
      expect(result.iconHint).toBe('steer')
      expect(result.primaryLabel).toBe('Steer')
      expect(result.alternatives).toEqual(['queue', 'stop_and_send'])
    })

    it('keeps queue as primary for attachments because steer only supports text', () => {
      const result = determineComposerActions(
        makeInput({
          lifecycle: 'busy',
          hasDraftContent: true,
          hasAttachments: true,
          supportsSteer: true,
          preferSteerWhenBusy: true
        })
      )
      expect(result.primary).toBe('queue')
      expect(result.iconHint).toBe('queue')
      expect(result.alternatives).toEqual(['steer', 'stop_and_send'])
    })

    it('omits steer from draft alternatives when runtime does not support it', () => {
      const result = determineComposerActions(
        makeInput({ lifecycle: 'busy', hasDraftContent: true, supportsSteer: false })
      )
      expect(result.alternatives).toEqual(['stop_and_send'])
    })
  })

  describe('materializing lifecycle', () => {
    it('returns stop_and_send (same as busy) when input is empty', () => {
      const result = determineComposerActions(
        makeInput({ lifecycle: 'materializing', supportsSteer: true })
      )
      expect(result.primary).toBe('stop_and_send')
      expect(result.alternatives).toEqual(['queue', 'steer'])
    })

    it('returns queue when materializing with draft content', () => {
      const result = determineComposerActions(
        makeInput({ lifecycle: 'materializing', hasDraftContent: true, supportsSteer: true })
      )
      expect(result.primary).toBe('queue')
      expect(result.alternatives).toEqual(['steer', 'stop_and_send'])
    })

    it('returns steer when materializing with draft content and steer-preferred runtime', () => {
      const result = determineComposerActions(
        makeInput({
          lifecycle: 'materializing',
          hasDraftContent: true,
          supportsSteer: true,
          preferSteerWhenBusy: true
        })
      )
      expect(result.primary).toBe('steer')
      expect(result.alternatives).toEqual(['queue', 'stop_and_send'])
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
    expect(msg.status).toBe('pending')
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
    expect(ctx.queueMessage).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({
        content: 'later',
        id: expect.stringMatching(/^pending-/)
      })
    )
    expect(ctx.prompt).not.toHaveBeenCalled()
  })

  it('queue: uses queueSessionId for runtime store bookkeeping when provided', async () => {
    const ctx = makeSendContext({ queueSessionId: 'db-sess-1' })
    const result = await executeSendAction('queue', 'later', [], ctx)

    expect(result).toBe(true)
    expect(ctx.queueMessage).toHaveBeenCalledWith(
      'db-sess-1',
      expect.objectContaining({
        content: 'later'
      })
    )
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
    ctx.waitForAbortReady = vi.fn(async () => {
      callOrder.push('wait')
    })

    const result = await executeSendAction('stop_and_send', 'new task', [], ctx)
    expect(result).toBe(true)
    expect(callOrder).toEqual(['abort', 'wait', 'prompt'])
    expect(ctx.abort).toHaveBeenCalledWith('/test/path', 'sess-1')
    expect(ctx.waitForAbortReady).toHaveBeenCalledTimes(1)
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
    const complete = vi.fn()

    const result = await drainNextPending(
      'sess-1',
      'agent-sess-1',
      dequeue,
      prompt,
      '/path',
      undefined,
      complete
    )
    expect(result).toBe(true)
    expect(dequeue).toHaveBeenCalledWith('sess-1')
    expect(prompt).toHaveBeenCalledWith('/path', 'agent-sess-1', pending)
    expect(complete).toHaveBeenCalledWith('sess-1', pending)
  })

  it('requeues the message at the front when drain fails', async () => {
    const pending = createPendingMessage('queued message')
    const dequeue = vi.fn().mockReturnValue(pending)
    const prompt = vi.fn().mockRejectedValue(new Error('send failed'))
    const requeueFront = vi.fn()

    await expect(
      drainNextPending('sess-1', 'agent-sess-1', dequeue, prompt, '/path', requeueFront)
    ).rejects.toThrow('send failed')

    expect(requeueFront).toHaveBeenCalledWith('sess-1', pending)
  })

  it('serializes concurrent drains for the same session', async () => {
    const controller = createPendingDrainController()
    const pending = createPendingMessage('queued message')
    const dequeue = vi.fn().mockReturnValueOnce(pending).mockReturnValueOnce(null)
    let resolvePrompt!: (value: { success: boolean }) => void
    const prompt = vi.fn(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          resolvePrompt = resolve
        })
    )

    const firstDrain = controller.drainNextPending(
      'sess-1',
      'agent-sess-1',
      dequeue,
      prompt,
      '/path'
    )
    const blockedDrain = await controller.drainNextPending(
      'sess-1',
      'agent-sess-1',
      dequeue,
      prompt,
      '/path'
    )

    expect(blockedDrain).toBe(false)
    expect(dequeue).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledTimes(1)

    resolvePrompt({ success: true })
    await expect(firstDrain).resolves.toBe(true)

    const afterReleaseDrain = await controller.drainNextPending(
      'sess-1',
      'agent-sess-1',
      dequeue,
      prompt,
      '/path'
    )
    expect(afterReleaseDrain).toBe(false)
    expect(dequeue).toHaveBeenCalledTimes(2)
  })

  it('keeps a queued item visible as sending until the provider accepts it', async () => {
    const store = useSessionRuntimeStore.getState()
    store.queueMessage('sess-1', createPendingMessage('queued message'))
    let resolvePrompt!: (value: { success: boolean }) => void
    const prompt = vi.fn(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          resolvePrompt = resolve
        })
    )

    const drain = drainNextPending(
      'sess-1',
      'agent-sess-1',
      (sid) => useSessionRuntimeStore.getState().claimNextPendingMessage(sid),
      prompt,
      '/path',
      (sid, message) => useSessionRuntimeStore.getState().restorePendingMessage(sid, message.id),
      (sid, message) => useSessionRuntimeStore.getState().completePendingMessage(sid, message.id)
    )

    await Promise.resolve()
    expect(useSessionRuntimeStore.getState().getPendingMessages('sess-1')[0]).toMatchObject({
      content: 'queued message',
      status: 'sending'
    })

    resolvePrompt({ success: true })
    await expect(drain).resolves.toBe(true)
    expect(useSessionRuntimeStore.getState().getPendingCount('sess-1')).toBe(0)
  })

  it('restores a claimed queue item to pending when provider send fails', async () => {
    const store = useSessionRuntimeStore.getState()
    store.queueMessage('sess-1', createPendingMessage('retry message'))
    const prompt = vi.fn().mockResolvedValue({ success: false, error: 'provider busy' })

    await expect(
      drainNextPending(
        'sess-1',
        'agent-sess-1',
        (sid) => useSessionRuntimeStore.getState().claimNextPendingMessage(sid),
        prompt,
        '/path',
        (sid, message) => useSessionRuntimeStore.getState().restorePendingMessage(sid, message.id),
        (sid, message) => useSessionRuntimeStore.getState().completePendingMessage(sid, message.id)
      )
    ).rejects.toThrow('provider busy')

    expect(useSessionRuntimeStore.getState().getPendingMessages('sess-1')[0]).toMatchObject({
      content: 'retry message',
      status: 'pending'
    })
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

  it('requeueMessageFront prepends a failed pending message', () => {
    const store = useSessionRuntimeStore.getState()
    store.queueMessage('sess-1', createPendingMessage('second'))
    const failed = createPendingMessage('first-again')
    store.requeueMessageFront('sess-1', failed)

    expect(
      useSessionRuntimeStore
        .getState()
        .getPendingMessages('sess-1')
        .map((m) => m.content)
    ).toEqual(['first-again', 'second'])
  })

  it('requeueMessageFront re-syncs queued-state true after a failed drain', () => {
    const syncSpy = vi.spyOn(window.systemOps, 'setSessionQueuedState')
    syncSpy.mockClear()

    const store = useSessionRuntimeStore.getState()
    store.queueMessage('sess-1', createPendingMessage('will-fail'))
    const failed = store.dequeueMessage('sess-1')

    expect(failed).not.toBeNull()
    expect(syncSpy).toHaveBeenLastCalledWith('sess-1', false)

    syncSpy.mockClear()
    store.requeueMessageFront('sess-1', failed!)

    expect(useSessionRuntimeStore.getState().getPendingMessages('sess-1')[0]).toMatchObject({
      id: failed!.id,
      content: failed!.content,
      status: 'pending'
    })
    expect(syncSpy).toHaveBeenCalledWith('sess-1', true)
  })

  it('claimNextPendingMessage marks the first pending item as sending without removing it', () => {
    const syncSpy = vi.spyOn(window.systemOps, 'setSessionQueuedState')
    const store = useSessionRuntimeStore.getState()
    store.queueMessage('sess-1', createPendingMessage('will-send'))
    syncSpy.mockClear()

    const claimed = store.claimNextPendingMessage('sess-1')

    expect(claimed?.content).toBe('will-send')
    expect(claimed?.status).toBe('sending')
    expect(useSessionRuntimeStore.getState().getPendingCount('sess-1')).toBe(1)
    expect(useSessionRuntimeStore.getState().getPendingMessages('sess-1')[0].status).toBe('sending')
    expect(useSessionRuntimeStore.getState().claimNextPendingMessage('sess-1')).toBeNull()
    expect(syncSpy).toHaveBeenCalledWith('sess-1', true)
  })

  it('completePendingMessage removes a sending item only after provider acceptance', () => {
    const syncSpy = vi.spyOn(window.systemOps, 'setSessionQueuedState')
    const store = useSessionRuntimeStore.getState()
    store.queueMessage('sess-1', createPendingMessage('will-send'))
    const claimed = store.claimNextPendingMessage('sess-1')
    syncSpy.mockClear()

    store.completePendingMessage('sess-1', claimed!.id)

    expect(useSessionRuntimeStore.getState().getPendingCount('sess-1')).toBe(0)
    expect(useSessionRuntimeStore.getState().pendingMessages.has('sess-1')).toBe(false)
    expect(syncSpy).toHaveBeenCalledWith('sess-1', false)
  })

  it('restorePendingMessage puts a failed sending item back into pending state', () => {
    const syncSpy = vi.spyOn(window.systemOps, 'setSessionQueuedState')
    const store = useSessionRuntimeStore.getState()
    store.queueMessage('sess-1', createPendingMessage('retry-me'))
    const claimed = store.claimNextPendingMessage('sess-1')
    syncSpy.mockClear()

    store.restorePendingMessage('sess-1', claimed!.id, 'send failed')
    const restored = useSessionRuntimeStore.getState().getPendingMessages('sess-1')[0]

    expect(restored.status).toBe('pending')
    expect(restored.sendingAt).toBeUndefined()
    expect(restored.lastError).toBe('send failed')
    expect(syncSpy).toHaveBeenCalledWith('sess-1', true)
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
    const actions = determineComposerActions(
      makeInput({ lifecycle: 'busy', hasDraftContent: true })
    )
    expect(actions.primary).toBe('queue')

    const ctx = makeSendContext()
    const consumed = await executeSendAction(actions.primary!, 'for later', [], ctx)
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
    const actions = determineComposerActions(makeInput({ hasInterrupt: true }))
    expect(actions.primary).toBe('reply_interrupt')

    const ctx = makeSendContext()
    const consumed = await executeSendAction(actions.primary!, 'yes', [], ctx)
    expect(consumed).toBe(true)
    expect(ctx.prompt).toHaveBeenCalledTimes(1)
  })
})
