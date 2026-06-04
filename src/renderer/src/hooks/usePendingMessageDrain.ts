import { useCallback, useEffect, useMemo } from 'react'
import type { Attachment } from '@/components/sessions/AttachmentPreview'
import { buildRuntimeMessagePayload } from '@/lib/file-attachment-utils'
import { createPendingDrainController } from '@/lib/session-send-actions'
import { refreshSessionLastMessageAt } from '@/lib/session-last-message'
import {
  useSessionRuntimeStore,
  type PendingMessageModelSnapshot,
  type PendingMessagePromptOptions,
  type SessionLifecycle
} from '@/stores/useSessionRuntimeStore'

interface UsePendingMessageDrainOptions {
  sessionId: string
  worktreePath: string | null
  runtimeSessionId: string | null
  lifecycle: SessionLifecycle
  pendingCount: number
  requestModel?: PendingMessageModelSnapshot | null
  promptOptions?: PendingMessagePromptOptions
}

interface UsePendingMessageDrainResult {
  drainQueuedMessage: () => Promise<boolean>
}

export function usePendingMessageDrain({
  sessionId,
  worktreePath,
  runtimeSessionId,
  lifecycle,
  pendingCount,
  requestModel,
  promptOptions
}: UsePendingMessageDrainOptions): UsePendingMessageDrainResult {
  const pendingDrainController = useMemo(() => createPendingDrainController(), [])

  const drainQueuedMessage = useCallback(async (): Promise<boolean> => {
    if (!worktreePath || !runtimeSessionId) return false

    try {
      const drained = await pendingDrainController.drainNextPending(
        sessionId,
        runtimeSessionId,
        (sid) => useSessionRuntimeStore.getState().claimNextPendingMessage(sid),
        async (wp, sid, message) => {
          const payload =
            message.attachments.length > 0
              ? buildRuntimeMessagePayload(
                  message.runtimeId,
                  message.attachments as Attachment[],
                  message.content
                )
              : message.content
          return window.agentOps.prompt(
            wp,
            sid,
            payload,
            message.model ?? requestModel,
            message.promptOptions ?? promptOptions
          )
        },
        worktreePath,
        (sid, message) => useSessionRuntimeStore.getState().restorePendingMessage(sid, message.id),
        (sid, message) => useSessionRuntimeStore.getState().completePendingMessage(sid, message.id)
      )
      if (drained) void refreshSessionLastMessageAt(sessionId)
      return drained
    } catch (err) {
      console.error('[SessionShell] drainNextPending failed:', err)
      return false
    }
  }, [
    pendingDrainController,
    promptOptions,
    requestModel,
    runtimeSessionId,
    sessionId,
    worktreePath
  ])

  useEffect(() => {
    if (lifecycle !== 'idle' || pendingCount === 0) return
    void drainQueuedMessage()
  }, [drainQueuedMessage, lifecycle, pendingCount])

  return { drainQueuedMessage }
}
