import { useEffect } from 'react'
import { toast } from 'sonner'
import { lastSendMode, messageSendTimes } from '@/lib/message-send-times'
import { refreshSessionLastMessageAt } from '@/lib/session-last-message'
import {
  createOptimisticUserMessage,
  type OptimisticTimelineMessagesController
} from '@/hooks/useOptimisticTimelineMessages'
import {
  useSessionStore,
  type PendingPromptOptions,
  type SessionMode
} from '@/stores/useSessionStore'
import {
  type PendingMessageModelSnapshot,
  type PendingMessagePromptOptions
} from '@/stores/useSessionRuntimeStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

type ResetLiveOverlay = (nextIsStreaming: boolean) => void

interface UsePendingInitialMessageSenderOptions {
  sessionId: string
  worktreePath: string | null
  runtimeSessionId: string | null
  mode: SessionMode
  requestModel?: PendingMessageModelSnapshot | null
  buildPendingPromptOptions: (
    options?: PendingPromptOptions
  ) => PendingMessagePromptOptions | undefined
  optimisticTimeline: OptimisticTimelineMessagesController
  resetLiveOverlay: ResetLiveOverlay
}

export function usePendingInitialMessageSender({
  sessionId,
  worktreePath,
  runtimeSessionId,
  mode,
  requestModel,
  buildPendingPromptOptions,
  optimisticTimeline,
  resetLiveOverlay
}: UsePendingInitialMessageSenderOptions): void {
  useEffect(() => {
    if (!worktreePath || !runtimeSessionId) return

    const pending = useSessionStore.getState().dequeuePendingMessageWithOptions(sessionId)
    if (!pending) return

    let cancelled = false
    const effectivePromptOptions = buildPendingPromptOptions(pending.options)
    const pendingMode = pending.options?.mode ?? mode
    const optimisticMessageId = `optimistic-${Date.now()}`

    ;(async () => {
      try {
        resetLiveOverlay(true)
        useSessionStore.getState().markSessionFirstMessage(sessionId)
        messageSendTimes.set(sessionId, Date.now())
        lastSendMode.set(sessionId, pendingMode)
        useWorktreeStatusStore
          .getState()
          .setSessionStatus(sessionId, pendingMode === 'plan' ? 'planning' : 'working')

        optimisticTimeline.appendOptimisticUserMessage(
          createOptimisticUserMessage({
            id: optimisticMessageId,
            content: pending.message
          })
        )

        const result = await window.agentOps.prompt(
          worktreePath,
          runtimeSessionId,
          pending.message,
          requestModel,
          effectivePromptOptions
        )

        if (cancelled) return

        if (!result.success) {
          throw new Error(result.error || 'Failed to send pending message')
        }

        void refreshSessionLastMessageAt(sessionId)
        // Settlement is handled by useSessionEventSubscription on
        // session.status idle / session.error — do not call onPromptSettled here.
      } catch (err) {
        console.error('[SessionShell] pending message send failed:', err)
        useSessionStore
          .getState()
          .requeuePendingMessage(sessionId, pending.message, pending.options)
        optimisticTimeline.removeOptimisticUserMessage(optimisticMessageId)
        useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
        resetLiveOverlay(false)
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : 'Failed to send pending message')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    sessionId,
    worktreePath,
    runtimeSessionId,
    buildPendingPromptOptions,
    mode,
    requestModel,
    optimisticTimeline,
    resetLiveOverlay
  ])
}
