/**
 * useHubConfirmationToasts: subscribes to the hub controller's pending-prompt
 * confirmations and pops a sonner toast with 批准/拒绝 buttons for each.
 *
 * Mount once at the app root (AppLayout). Intentionally side-effect only —
 * it does not render a component.
 */

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useHubStore } from '@/stores/useHubStore'

export function useHubConfirmationToasts(): void {
  const confirmations = useHubStore((s) => s.pendingConfirmations)
  const respond = useHubStore((s) => s.respondConfirmation)
  const init = useHubStore((s) => s.init)
  const shown = useRef(new Set<string>())

  useEffect(() => {
    // Kick off IPC subscription once. Safe to call repeatedly — init is idempotent.
    let cleanup: (() => void) | undefined
    init().then((u) => {
      cleanup = u
    })
    return () => cleanup?.()
  }, [init])

  useEffect(() => {
    for (const c of confirmations) {
      if (shown.current.has(c.confirmId)) continue
      shown.current.add(c.confirmId)
      toast(
        `手机请求执行 prompt`,
        {
          description:
            c.preview.length > 200 ? c.preview.slice(0, 200) + '…' : c.preview,
          duration: 30_000,
          action: {
            label: '批准',
            onClick: () => {
              respond(c.confirmId, true)
            }
          },
          cancel: {
            label: '拒绝',
            onClick: () => {
              respond(c.confirmId, false)
            }
          },
          id: c.confirmId,
          onDismiss: () => respond(c.confirmId, false),
          onAutoClose: () => respond(c.confirmId, false)
        }
      )
    }
  }, [confirmations, respond])
}
