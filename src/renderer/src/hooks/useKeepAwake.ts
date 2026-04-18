import { useEffect } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useSessionStore } from '@/stores/useSessionStore'

export function useKeepAwake(): void {
  const enabled = useSettingsStore((s) => s.keepAwakeEnabled)
  const sessionStatuses = useWorktreeStatusStore((s) => s.sessionStatuses)
  const sessionsByWorktree = useSessionStore((s) => s.sessionsByWorktree)
  const sessionsByConnection = useSessionStore((s) => s.sessionsByConnection)

  useEffect(() => {
    const shouldKeepAwake =
      enabled &&
      [...sessionsByWorktree.values(), ...sessionsByConnection.values()].some((sessions) =>
        sessions.some((session) => {
          const status = sessionStatuses[session.id]?.status
          return status === 'planning' || status === 'working'
        })
      )

    const request = window.systemOps?.setKeepAwakeEnabled(shouldKeepAwake)
    void request?.catch(() => {})
  }, [enabled, sessionStatuses, sessionsByWorktree, sessionsByConnection])
}
