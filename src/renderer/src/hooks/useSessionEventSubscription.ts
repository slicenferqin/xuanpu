import { useEffect } from 'react'
import type { TimelineMessage } from '@shared/lib/timeline-types'
import type { CanonicalAgentEvent } from '@shared/types/agent-protocol'
import { applySessionContextUsage } from '@/lib/context-usage'
import { messageSendTimes } from '@/lib/message-send-times'
import { applyCompletedMessageUsage } from '@/hooks/useSessionUsageHydration'
import {
  useSessionRuntimeStore,
  clearStreamingBufferRunState,
  clearStreamingBufferOptimisticMessages
} from '@/stores/useSessionRuntimeStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

interface UseSessionEventSubscriptionOptions {
  sessionId: string
  currentProviderId: string
  refresh: () => Promise<TimelineMessage[]>
  refreshUsageSummary: () => Promise<void>
  drainQueuedMessage: () => Promise<boolean>
  clearOptimisticMessages: () => void
  setRuntimeSessionId: (runtimeSessionId: string) => void
  notifyCommandsAvailable: () => void
  applyMissionTaskToolEvent: (
    toolName: string | undefined,
    input: unknown,
    toolUseId?: string
  ) => void
  syncMissionTasksFromMessages: (messages: TimelineMessage[]) => void
}

function isCompletedMessageUpdate(data: unknown): data is Record<string, unknown> {
  const info = (data as Record<string, unknown> | undefined)?.info as
    | Record<string, unknown>
    | undefined
  return Boolean((info?.time as Record<string, unknown> | undefined)?.completed)
}

function getRuntimeStatusType(event: CanonicalAgentEvent): string | undefined {
  return event.data?.status?.type
}

function getSessionTitle(data: unknown): string | undefined {
  const record = data as Record<string, unknown> | undefined
  const info = record?.info as Record<string, unknown> | undefined
  const title = info?.title || record?.title
  return typeof title === 'string' ? title : undefined
}

function isOpenCodeDefaultTitle(title: string): boolean {
  return /^New session\s*-?\s*\d{4}-\d{2}-\d{2}/i.test(title)
}

export function useSessionEventSubscription({
  sessionId,
  currentProviderId,
  refresh,
  refreshUsageSummary,
  drainQueuedMessage,
  clearOptimisticMessages,
  setRuntimeSessionId,
  notifyCommandsAvailable,
  applyMissionTaskToolEvent,
  syncMissionTasksFromMessages
}: UseSessionEventSubscriptionOptions): void {
  useEffect(() => {
    const unsubscribe = useSessionRuntimeStore
      .getState()
      .subscribeToSessionEvents(sessionId, (event: CanonicalAgentEvent) => {
        // Live streaming task snapshots for the side panel.
        if (event.type === 'message.part.updated') {
          const partData = event.data
          if (!partData) return
          if (event.childSessionId) return

          const part = partData.part as Record<string, unknown> | undefined
          if (part?.type === 'tool') {
            const toolName = (part.tool as string) || undefined
            const state = (part.state as Record<string, unknown>) || {}
            // callID stays stable across the full tool lifecycle; fallback to part.id.
            const toolUseId =
              (typeof part.callID === 'string' ? part.callID : undefined) ??
              (typeof part.id === 'string' ? part.id : undefined)

            applyMissionTaskToolEvent(toolName, state.input, toolUseId)
          }
        }

        if (event.type === 'session.status') {
          const statusType = getRuntimeStatusType(event)
          if (statusType === 'idle') {
            void refreshUsageSummary()
            // Mark the tab badge / sidebar as completed. useAgentEventBridge
            // intentionally skips active sessions on idle; Session HQ handles it here.
            const pendingPlan = useSessionStore.getState().getPendingPlan(sessionId)
            const currentBadge = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
            const skipBadge =
              !!pendingPlan ||
              currentBadge?.status === 'plan_ready' ||
              currentBadge?.status === 'command_approval' ||
              currentBadge?.status === 'answering' ||
              currentBadge?.status === 'permission'
            if (!skipBadge) {
              const sendTime = messageSendTimes.get(sessionId)
              const durationMs = sendTime ? Date.now() - sendTime : 0
              useWorktreeStatusStore
                .getState()
                .setSessionStatus(sessionId, 'completed', { durationMs })
            }

            void refresh()
              .then((msgs) => {
                syncMissionTasksFromMessages(msgs)
              })
              .finally(() => {
                clearOptimisticMessages()
                // Fix #4: Also clear runtime buffer's optimisticMessages
                // to prevent stale optimistic bubbles on tab switch / remount.
                clearStreamingBufferOptimisticMessages(sessionId)
                // Lift the run-cutoff filter now that refresh() has delivered
                // the definitive message ordering. This must happen AFTER
                // clearOptimisticMessages so the view-model sees the committed
                // user+assistant pair in correct chronological order.
                clearStreamingBufferRunState(sessionId)
                // NOTE: do NOT clearStreamingBufferOverlay here. By the time
                // we reach this finally, the runtime mirror's idle handler
                // already set isStreaming=false (so streamingNodes stop
                // rendering). Wiping `parts` would destroy content the user
                // might switch back to read, and the next user message will
                // call resetLiveOverlay(true) before any new stream lands.
              })

            void drainQueuedMessage()
          }
        }

        // On session error, the run ends but runStartedAt is preserved in the
        // runtime store (same rationale as idle). Refresh to get the definitive
        // message ordering, then lift the run-cutoff filter.
        if (event.type === 'session.error') {
          void refresh().finally(() => {
            clearOptimisticMessages()
            clearStreamingBufferOptimisticMessages(sessionId)
            clearStreamingBufferRunState(sessionId)
          })
        }

        // Token / cost tracking (active session; global bridge skips the active one).
        if (event.type === 'message.updated' && isCompletedMessageUpdate(event.data)) {
          applyCompletedMessageUsage(sessionId, event.data, currentProviderId)
        }

        if (event.type === 'session.context_usage') {
          applySessionContextUsage(sessionId, event.data)
        }

        if (event.type === 'session.materialized') {
          const newId = event.data?.newSessionId as string | undefined
          if (newId) setRuntimeSessionId(newId)
          void refreshUsageSummary()
        }

        if (event.type === 'session.updated') {
          const sessionTitle = getSessionTitle(event.data)
          if (sessionTitle && !isOpenCodeDefaultTitle(sessionTitle)) {
            useSessionStore.getState().updateSessionName(sessionId, sessionTitle)
          }
          return
        }

        if (event.type === 'session.commands_available') {
          notifyCommandsAvailable()
        }
      })

    return unsubscribe
  }, [
    sessionId,
    currentProviderId,
    refresh,
    refreshUsageSummary,
    drainQueuedMessage,
    clearOptimisticMessages,
    setRuntimeSessionId,
    notifyCommandsAvailable,
    applyMissionTaskToolEvent,
    syncMissionTasksFromMessages
  ])
}
