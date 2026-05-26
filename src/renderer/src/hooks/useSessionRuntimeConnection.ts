import { useCallback, useEffect, useState } from 'react'
import { useWorktreeStore } from '@/stores'
import { useSessionStore } from '@/stores/useSessionStore'

interface UseSessionRuntimeConnectionOptions {
  sessionId: string
  worktreeId?: string | null
  connectionId?: string | null
  opencodeSessionId?: string | null
  agentSdk?: string | null
}

interface UseSessionRuntimeConnectionResult {
  worktreePath: string | null
  runtimeSessionId: string | null
  setRuntimeSessionId: (runtimeSessionId: string) => void
  supportsSteer: boolean
}

export function useSessionRuntimeConnection({
  sessionId,
  worktreeId,
  connectionId,
  opencodeSessionId,
  agentSdk
}: UseSessionRuntimeConnectionOptions): UseSessionRuntimeConnectionResult {
  const worktreePathFromStore = useWorktreeStore((s) => {
    if (!worktreeId) return null
    for (const worktrees of s.worktreesByProject.values()) {
      const match = worktrees.find((w) => w.id === worktreeId)
      if (match) return match.path
    }
    return null
  })

  const [resolvedPath, setResolvedPath] = useState<string | null>(worktreePathFromStore)
  const [runtimeSessionId, setRuntimeSessionIdState] = useState<string | null>(
    opencodeSessionId ?? null
  )
  const [supportsSteer, setSupportsSteer] = useState(agentSdk === 'codex')

  useEffect(() => {
    if (worktreePathFromStore) {
      setResolvedPath(worktreePathFromStore)
      return
    }
    if (!connectionId) return

    let cancelled = false
    window.connectionOps
      .get(connectionId)
      .then((result) => {
        if (!cancelled && result.success && result.connection?.path) {
          setResolvedPath(result.connection.path)
        }
      })
      .catch((err) => {
        console.error('[useSessionRuntimeConnection:path] IPC error', err)
      })
    return () => {
      cancelled = true
    }
  }, [worktreePathFromStore, connectionId])

  useEffect(() => {
    void agentSdk
    if (!resolvedPath) return

    let cancelled = false
    ;(async () => {
      try {
        if (opencodeSessionId) {
          const result = await window.agentOps.reconnect(resolvedPath, opencodeSessionId, sessionId)
          if (!cancelled && result.success) {
            const nextRuntimeSessionId = result.sessionId ?? opencodeSessionId
            setRuntimeSessionIdState(nextRuntimeSessionId)
            if (nextRuntimeSessionId !== opencodeSessionId) {
              useSessionStore.getState().setOpenCodeSessionId(sessionId, nextRuntimeSessionId)
              await window.db.session.update(sessionId, {
                opencode_session_id: nextRuntimeSessionId
              })
            }
          }
        } else {
          const result = await window.agentOps.connect(resolvedPath, sessionId)
          if (!cancelled && result.success && result.sessionId) {
            setRuntimeSessionIdState(result.sessionId)
            useSessionStore.getState().setOpenCodeSessionId(sessionId, result.sessionId)
            await window.db.session.update(sessionId, {
              opencode_session_id: result.sessionId
            })
          }
        }
      } catch (err) {
        console.warn('[useSessionRuntimeConnection] connect/reconnect failed:', err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [sessionId, resolvedPath, opencodeSessionId, agentSdk])

  useEffect(() => {
    if (!runtimeSessionId || !window.agentOps?.capabilities) {
      setSupportsSteer(agentSdk === 'codex')
      return
    }

    let cancelled = false

    window.agentOps
      .capabilities(runtimeSessionId)
      .then((result) => {
        if (cancelled) return
        setSupportsSteer(Boolean(result.success && result.capabilities?.supportsSteer))
      })
      .catch(() => {
        if (!cancelled) {
          setSupportsSteer(agentSdk === 'codex')
        }
      })

    return () => {
      cancelled = true
    }
  }, [agentSdk, runtimeSessionId])

  const setRuntimeSessionId = useCallback((nextRuntimeSessionId: string) => {
    setRuntimeSessionIdState(nextRuntimeSessionId)
  }, [])

  return {
    worktreePath: resolvedPath,
    runtimeSessionId,
    setRuntimeSessionId,
    supportsSteer
  }
}
