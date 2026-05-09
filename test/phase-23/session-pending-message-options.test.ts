import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'

describe('session pending initial message options', () => {
  beforeEach(() => {
    useSessionStore.setState({
      pendingMessages: new Map(),
      pendingMessageOptions: new Map()
    })
  })

  it('dequeues a pending initial message together with goal launch options', () => {
    useSessionStore.getState().setPendingMessage('sess-1', 'Implement the following plan', {
      goalMode: true,
      successCriteria: 'Focused tests pass'
    })

    expect(useSessionStore.getState().dequeuePendingMessageWithOptions('sess-1')).toEqual({
      message: 'Implement the following plan',
      options: {
        goalMode: true,
        successCriteria: 'Focused tests pass'
      }
    })
    expect(useSessionStore.getState().dequeuePendingMessageWithOptions('sess-1')).toBeNull()
    expect(useSessionStore.getState().pendingMessageOptions.has('sess-1')).toBe(false)
  })

  it('keeps legacy string dequeue semantics and clears stale launch options', () => {
    useSessionStore
      .getState()
      .setPendingMessage('sess-1', 'Create a pull request', { goalMode: true })

    expect(useSessionStore.getState().dequeuePendingMessage('sess-1')).toBe('Create a pull request')
    expect(useSessionStore.getState().pendingMessageOptions.has('sess-1')).toBe(false)

    useSessionStore.getState().setPendingMessage('sess-1', 'Fix merge conflicts')

    expect(useSessionStore.getState().dequeuePendingMessageWithOptions('sess-1')).toEqual({
      message: 'Fix merge conflicts'
    })
  })
})
