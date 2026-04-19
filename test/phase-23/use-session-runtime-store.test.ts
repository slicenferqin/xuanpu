import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getStreamingBufferSnapshot,
  subscribeToStreamingBuffer,
  syncStreamingBufferGuardState,
  updateStreamingBuffer,
  useSessionRuntimeStore
} from '../../src/renderer/src/stores/useSessionRuntimeStore'
import type { CanonicalAgentEvent } from '../../src/shared/types/agent-protocol'

// Reset store state between tests
beforeEach(() => {
  const state = useSessionRuntimeStore.getState()
  // Clear all sessions
  for (const sessionId of state.sessions.keys()) {
    state.clearSession(sessionId)
  }
  // Clear any remaining interrupt queues
  for (const sessionId of state.interruptQueues.keys()) {
    state.clearSession(sessionId)
  }
})

describe('useSessionRuntimeStore', () => {
  describe('session lifecycle', () => {
    it('returns default state for unknown session', () => {
      const state = useSessionRuntimeStore.getState().getSession('unknown')
      expect(state.lifecycle).toBe('idle')
      expect(state.inProgress).toBe(false)
      expect(state.unreadCount).toBe(0)
      expect(state.commandsAvailable).toBe(false)
      expect(state.retryInfo).toBeNull()
    })

    it('sets lifecycle to busy and marks inProgress', () => {
      useSessionRuntimeStore.getState().setLifecycle('sess-1', 'busy')
      const state = useSessionRuntimeStore.getState().getSession('sess-1')
      expect(state.lifecycle).toBe('busy')
      expect(state.inProgress).toBe(true)
      expect(state.lastActivityAt).toBeGreaterThan(0)
    })

    it('sets lifecycle to idle and clears inProgress', () => {
      useSessionRuntimeStore.getState().setLifecycle('sess-1', 'busy')
      useSessionRuntimeStore.getState().setLifecycle('sess-1', 'idle')
      const state = useSessionRuntimeStore.getState().getSession('sess-1')
      expect(state.lifecycle).toBe('idle')
      expect(state.inProgress).toBe(false)
    })

    it('sets lifecycle to retry and marks inProgress', () => {
      useSessionRuntimeStore.getState().setLifecycle('sess-1', 'retry')
      const state = useSessionRuntimeStore.getState().getSession('sess-1')
      expect(state.lifecycle).toBe('retry')
      expect(state.inProgress).toBe(true)
    })

    it('sets retry info', () => {
      useSessionRuntimeStore.getState().setRetryInfo('sess-1', {
        attempt: 3,
        message: 'Rate limited',
        next: 5000
      })
      const state = useSessionRuntimeStore.getState().getSession('sess-1')
      expect(state.retryInfo).toEqual({
        attempt: 3,
        message: 'Rate limited',
        next: 5000
      })
    })

    it('clears retry info', () => {
      useSessionRuntimeStore.getState().setRetryInfo('sess-1', { attempt: 1 })
      useSessionRuntimeStore.getState().setRetryInfo('sess-1', null)
      const state = useSessionRuntimeStore.getState().getSession('sess-1')
      expect(state.retryInfo).toBeNull()
    })

    it('tracks per-session lifecycle independently', () => {
      useSessionRuntimeStore.getState().setLifecycle('sess-A', 'busy')
      useSessionRuntimeStore.getState().setLifecycle('sess-B', 'idle')
      expect(useSessionRuntimeStore.getState().getSession('sess-A').lifecycle).toBe('busy')
      expect(useSessionRuntimeStore.getState().getSession('sess-B').lifecycle).toBe('idle')
    })

    it('sets commandsAvailable', () => {
      useSessionRuntimeStore.getState().setCommandsAvailable('sess-1', true)
      expect(useSessionRuntimeStore.getState().getSession('sess-1').commandsAvailable).toBe(true)
    })

    it('touches activity timestamp', () => {
      const before = Date.now()
      useSessionRuntimeStore.getState().touchActivity('sess-1')
      const state = useSessionRuntimeStore.getState().getSession('sess-1')
      expect(state.lastActivityAt).toBeGreaterThanOrEqual(before)
    })
  })

  describe('unread count', () => {
    it('increments unread', () => {
      useSessionRuntimeStore.getState().incrementUnread('sess-1')
      useSessionRuntimeStore.getState().incrementUnread('sess-1')
      expect(useSessionRuntimeStore.getState().getSession('sess-1').unreadCount).toBe(2)
    })

    it('clears unread', () => {
      useSessionRuntimeStore.getState().incrementUnread('sess-1')
      useSessionRuntimeStore.getState().incrementUnread('sess-1')
      useSessionRuntimeStore.getState().clearUnread('sess-1')
      expect(useSessionRuntimeStore.getState().getSession('sess-1').unreadCount).toBe(0)
    })

    it('clearUnread is no-op when already zero', () => {
      const stateBefore = useSessionRuntimeStore.getState()
      stateBefore.clearUnread('nonexistent')
      // Should not create a session entry
      expect(useSessionRuntimeStore.getState().sessions.has('nonexistent')).toBe(false)
    })
  })

  describe('interrupt queue', () => {
    it('pushes and retrieves interrupts', () => {
      useSessionRuntimeStore.getState().pushInterrupt('sess-1', {
        type: 'question',
        id: 'q-1',
        sessionId: 'sess-1',
        data: { questions: [{ question: 'Pick one', options: [] }] }
      })
      const queue = useSessionRuntimeStore.getState().getInterruptQueue('sess-1')
      expect(queue).toHaveLength(1)
      expect(queue[0].type).toBe('question')
      expect(queue[0].id).toBe('q-1')
      expect(queue[0].timestamp).toBeGreaterThan(0)
    })

    it('deduplicates by id', () => {
      const store = useSessionRuntimeStore.getState()
      store.pushInterrupt('sess-1', {
        type: 'question',
        id: 'q-1',
        sessionId: 'sess-1',
        data: {}
      })
      store.pushInterrupt('sess-1', {
        type: 'question',
        id: 'q-1',
        sessionId: 'sess-1',
        data: {}
      })
      expect(useSessionRuntimeStore.getState().getInterruptQueue('sess-1')).toHaveLength(1)
    })

    it('removes interrupt by id', () => {
      const store = useSessionRuntimeStore.getState()
      store.pushInterrupt('sess-1', {
        type: 'question',
        id: 'q-1',
        sessionId: 'sess-1',
        data: {}
      })
      store.pushInterrupt('sess-1', {
        type: 'permission',
        id: 'p-1',
        sessionId: 'sess-1',
        data: {}
      })
      store.removeInterrupt('sess-1', 'q-1')
      const queue = useSessionRuntimeStore.getState().getInterruptQueue('sess-1')
      expect(queue).toHaveLength(1)
      expect(queue[0].id).toBe('p-1')
    })

    it('returns null for empty getFirstInterrupt', () => {
      expect(useSessionRuntimeStore.getState().getFirstInterrupt('nonexistent')).toBeNull()
    })

    it('returns first interrupt (FIFO)', () => {
      const store = useSessionRuntimeStore.getState()
      store.pushInterrupt('sess-1', {
        type: 'question',
        id: 'q-1',
        sessionId: 'sess-1',
        data: { order: 1 }
      })
      store.pushInterrupt('sess-1', {
        type: 'permission',
        id: 'p-1',
        sessionId: 'sess-1',
        data: { order: 2 }
      })
      const first = useSessionRuntimeStore.getState().getFirstInterrupt('sess-1')
      expect(first?.id).toBe('q-1')
    })

    it('filters by interrupt type', () => {
      const store = useSessionRuntimeStore.getState()
      store.pushInterrupt('sess-1', {
        type: 'question',
        id: 'q-1',
        sessionId: 'sess-1',
        data: {}
      })
      store.pushInterrupt('sess-1', {
        type: 'permission',
        id: 'p-1',
        sessionId: 'sess-1',
        data: {}
      })
      store.pushInterrupt('sess-1', {
        type: 'question',
        id: 'q-2',
        sessionId: 'sess-1',
        data: {}
      })
      const questions = useSessionRuntimeStore
        .getState()
        .getInterruptsByType('sess-1', 'question')
      expect(questions).toHaveLength(2)
      expect(questions.map((q) => q.id)).toEqual(['q-1', 'q-2'])
    })

    it('clears all interrupts for a session', () => {
      const store = useSessionRuntimeStore.getState()
      store.pushInterrupt('sess-1', {
        type: 'question',
        id: 'q-1',
        sessionId: 'sess-1',
        data: {}
      })
      store.pushInterrupt('sess-1', {
        type: 'permission',
        id: 'p-1',
        sessionId: 'sess-1',
        data: {}
      })
      store.clearSessionInterrupts('sess-1')
      expect(useSessionRuntimeStore.getState().getInterruptQueue('sess-1')).toHaveLength(0)
    })

    it('maintains separate queues per session', () => {
      const store = useSessionRuntimeStore.getState()
      store.pushInterrupt('sess-A', {
        type: 'question',
        id: 'q-A',
        sessionId: 'sess-A',
        data: {}
      })
      store.pushInterrupt('sess-B', {
        type: 'permission',
        id: 'p-B',
        sessionId: 'sess-B',
        data: {}
      })
      expect(useSessionRuntimeStore.getState().getInterruptQueue('sess-A')).toHaveLength(1)
      expect(useSessionRuntimeStore.getState().getInterruptQueue('sess-B')).toHaveLength(1)
      expect(
        useSessionRuntimeStore.getState().getInterruptQueue('sess-A')[0].type
      ).toBe('question')
      expect(
        useSessionRuntimeStore.getState().getInterruptQueue('sess-B')[0].type
      ).toBe('permission')
    })

    it('removeInterrupt cleans up empty queue', () => {
      const store = useSessionRuntimeStore.getState()
      store.pushInterrupt('sess-1', {
        type: 'question',
        id: 'q-1',
        sessionId: 'sess-1',
        data: {}
      })
      store.removeInterrupt('sess-1', 'q-1')
      // The internal map entry should be deleted when queue is empty
      expect(useSessionRuntimeStore.getState().interruptQueues.has('sess-1')).toBe(false)
    })
  })

  describe('streaming mirror registry', () => {
    it('stores live overlay outside Zustand state and notifies immediate subscribers', () => {
      let callbackCount = 0
      const unsubscribe = subscribeToStreamingBuffer('sess-1', () => {
        callbackCount += 1
      })

      updateStreamingBuffer(
        'sess-1',
        (current) => ({
          ...current,
          streamingContent: 'hello',
          parts: [{ type: 'text', text: 'hello' }],
          isStreaming: true
        }),
        { notify: 'immediate' }
      )

      const snapshot = getStreamingBufferSnapshot('sess-1')
      expect(snapshot.streamingContent).toBe('hello')
      expect(snapshot.parts).toEqual([{ type: 'text', text: 'hello' }])
      expect(snapshot.isStreaming).toBe(true)
      expect(snapshot.mirrorVersion).toBe(1)
      expect(callbackCount).toBe(1)

      unsubscribe()
    })

    it('coalesces multiple frame writes into a single mirrorVersion tick', () => {
      vi.useFakeTimers()
      const originalRaf = globalThis.requestAnimationFrame
      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        setTimeout(() => cb(Date.now()), 0)) as typeof requestAnimationFrame

      let callbackCount = 0
      const unsubscribe = subscribeToStreamingBuffer('sess-2', () => {
        callbackCount += 1
      })

      updateStreamingBuffer(
        'sess-2',
        (current) => ({
          ...current,
          streamingContent: 'a'
        }),
        { notify: 'frame' }
      )
      updateStreamingBuffer(
        'sess-2',
        (current) => ({
          ...current,
          streamingContent: `${current.streamingContent}b`
        }),
        { notify: 'frame' }
      )

      expect(callbackCount).toBe(0)
      vi.runAllTimers()

      const snapshot = getStreamingBufferSnapshot('sess-2')
      expect(snapshot.streamingContent).toBe('ab')
      expect(snapshot.mirrorVersion).toBe(1)
      expect(callbackCount).toBe(1)

      unsubscribe()
      globalThis.requestAnimationFrame = originalRaf
      vi.useRealTimers()
    })

    it('resets only the live overlay when a newer run is accepted', () => {
      updateStreamingBuffer(
        'sess-3',
        (current) => ({
          ...current,
          streamingContent: 'old run text',
          parts: [{ type: 'text', text: 'old run text' }],
          isStreaming: true,
          optimisticMessages: [
            {
              id: 'optimistic-1',
              role: 'user',
              content: 'please continue',
              timestamp: '2026-04-19T00:00:00.000Z'
            }
          ]
        }),
        { notify: 'none' }
      )

      syncStreamingBufferGuardState(
        'sess-3',
        { activeRunEpoch: 2, lastAppliedSequence: 8 },
        { resetOverlay: true, notify: 'immediate' }
      )

      const snapshot = getStreamingBufferSnapshot('sess-3')
      expect(snapshot.activeRunEpoch).toBe(2)
      expect(snapshot.lastAppliedSequence).toBe(8)
      expect(snapshot.streamingContent).toBe('')
      expect(snapshot.parts).toEqual([])
      expect(snapshot.isStreaming).toBe(false)
      expect(snapshot.optimisticMessages).toEqual([
        {
          id: 'optimistic-1',
          role: 'user',
          content: 'please continue',
          timestamp: '2026-04-19T00:00:00.000Z'
        }
      ])
    })
  })

  describe('per-session event callbacks', () => {
    it('dispatches events to subscribed callbacks', () => {
      const events: CanonicalAgentEvent[] = []
      const unsubscribe = useSessionRuntimeStore
        .getState()
        .subscribeToSessionEvents('sess-1', (e) => events.push(e))

      const event = {
        type: 'session.updated',
        sessionId: 'sess-1',
        eventId: 'e-1',
        sessionSequence: 1,
        data: { title: 'hello' }
      } as CanonicalAgentEvent

      useSessionRuntimeStore.getState().dispatchToSession('sess-1', event)
      expect(events).toHaveLength(1)
      expect(events[0]).toBe(event)

      unsubscribe()
    })

    it('does not dispatch to wrong session', () => {
      const events: CanonicalAgentEvent[] = []
      const unsubscribe = useSessionRuntimeStore
        .getState()
        .subscribeToSessionEvents('sess-1', (e) => events.push(e))

      const event = {
        type: 'session.updated',
        sessionId: 'sess-2',
        eventId: 'e-1',
        sessionSequence: 1,
        data: { title: 'hello' }
      } as CanonicalAgentEvent

      useSessionRuntimeStore.getState().dispatchToSession('sess-2', event)
      expect(events).toHaveLength(0)

      unsubscribe()
    })

    it('unsubscribe stops callbacks', () => {
      const events: CanonicalAgentEvent[] = []
      const unsubscribe = useSessionRuntimeStore
        .getState()
        .subscribeToSessionEvents('sess-1', (e) => events.push(e))

      unsubscribe()

      const event = {
        type: 'session.updated',
        sessionId: 'sess-1',
        eventId: 'e-1',
        sessionSequence: 1,
        data: { title: 'hello' }
      } as CanonicalAgentEvent

      useSessionRuntimeStore.getState().dispatchToSession('sess-1', event)
      expect(events).toHaveLength(0)
    })

    it('supports multiple callbacks for same session', () => {
      let count1 = 0
      let count2 = 0
      const unsub1 = useSessionRuntimeStore
        .getState()
        .subscribeToSessionEvents('sess-1', () => count1++)
      const unsub2 = useSessionRuntimeStore
        .getState()
        .subscribeToSessionEvents('sess-1', () => count2++)

      const event = {
        type: 'session.updated',
        sessionId: 'sess-1',
        eventId: 'e-1',
        sessionSequence: 1,
        data: { title: 'hello' }
      } as CanonicalAgentEvent

      useSessionRuntimeStore.getState().dispatchToSession('sess-1', event)
      expect(count1).toBe(1)
      expect(count2).toBe(1)

      unsub1()
      unsub2()
    })

    it('handles callback errors gracefully', () => {
      const events: CanonicalAgentEvent[] = []
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const unsub1 = useSessionRuntimeStore.getState().subscribeToSessionEvents('sess-1', () => {
        throw new Error('oops')
      })
      const unsub2 = useSessionRuntimeStore
        .getState()
        .subscribeToSessionEvents('sess-1', (e) => events.push(e))

      const event = {
        type: 'session.updated',
        sessionId: 'sess-1',
        eventId: 'e-1',
        sessionSequence: 1,
        data: { title: 'hello' }
      } as CanonicalAgentEvent

      useSessionRuntimeStore.getState().dispatchToSession('sess-1', event)

      // Second callback still runs despite first throwing
      expect(events).toHaveLength(1)
      expect(consoleSpy).toHaveBeenCalled()

      consoleSpy.mockRestore()
      unsub1()
      unsub2()
    })
  })

  describe('clearSession', () => {
    it('clears all state for a session', () => {
      const store = useSessionRuntimeStore.getState()
      store.setLifecycle('sess-1', 'busy')
      store.incrementUnread('sess-1')
      store.pushInterrupt('sess-1', {
        type: 'question',
        id: 'q-1',
        sessionId: 'sess-1',
        data: {}
      })

      store.clearSession('sess-1')

      expect(useSessionRuntimeStore.getState().sessions.has('sess-1')).toBe(false)
      expect(useSessionRuntimeStore.getState().interruptQueues.has('sess-1')).toBe(false)
      // getSession returns default
      expect(useSessionRuntimeStore.getState().getSession('sess-1').lifecycle).toBe('idle')
    })
  })
})
