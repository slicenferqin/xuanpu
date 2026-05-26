import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionAbortReadiness } from '../../src/renderer/src/hooks/useSessionAbortReadiness'
import { useSessionRuntimeStore } from '../../src/renderer/src/stores/useSessionRuntimeStore'

const SESSION_ID = 'abort-readiness-session'

function resetRuntimeStore(): void {
  const state = useSessionRuntimeStore.getState()
  for (const sessionId of state.sessions.keys()) {
    state.clearSession(sessionId)
  }
}

describe('useSessionAbortReadiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRuntimeStore()
  })

  it('resolves only after the aborted session reaches idle or error', async () => {
    useSessionRuntimeStore.getState().setLifecycle(SESSION_ID, 'busy')
    const { result } = renderHook(() => useSessionAbortReadiness(SESSION_ID))
    let resolved = false

    const pending = result.current().then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)

    act(() => {
      useSessionRuntimeStore.getState().setLifecycle(SESSION_ID, 'idle')
    })

    await pending
    expect(resolved).toBe(true)
  })
})
