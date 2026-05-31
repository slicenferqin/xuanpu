import { useCallback } from 'react'
import { useSessionRuntimeStore } from '@/stores/useSessionRuntimeStore'

export function waitForSessionIdleAfterAbort(sessionId: string, timeoutMs = 2500): Promise<void> {
  const isReady = (): boolean => {
    const lifecycle = useSessionRuntimeStore.getState().getSession(sessionId).lifecycle
    return lifecycle === 'idle' || lifecycle === 'error'
  }

  if (isReady()) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof window.setTimeout> | null = null
    let unsubscribe: (() => void) | null = null

    const settle = (): void => {
      if (settled) return
      settled = true
      unsubscribe?.()
      if (timer !== null) window.clearTimeout(timer)
      resolve()
    }

    unsubscribe = useSessionRuntimeStore.subscribe(() => {
      if (isReady()) settle()
    })

    // Close the small race where the idle transition lands between the first
    // read and subscription registration.
    if (isReady()) {
      settle()
      return
    }

    // Deadlock guard only: the normal path resolves on the lifecycle event.
    timer = window.setTimeout(settle, timeoutMs)
  })
}

export function useSessionAbortReadiness(sessionId: string): () => Promise<void> {
  return useCallback(() => waitForSessionIdleAfterAbort(sessionId), [sessionId])
}
