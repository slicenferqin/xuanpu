import { useCallback, useEffect } from 'react'
import type { TimelineMessage } from '@shared/lib/timeline-types'
import {
  extractCost,
  extractCostEventKey,
  extractModelRef,
  extractModelUsage,
  extractTokens
} from '@/lib/token-utils'
import { useContextStore, type SessionModelRef, type TokenInfo } from '@/stores/useContextStore'

interface UseSessionUsageHydrationOptions {
  sessionId: string
  timelineMessages: TimelineMessage[]
  worktreePath: string | null
  runtimeSessionId: string | null
  currentProviderId: string
}

interface UseSessionUsageHydrationResult {
  refreshUsageSummary: () => Promise<void>
}

function getMessageRole(messageRecord: Record<string, unknown>): string | undefined {
  const info = messageRecord.info as Record<string, unknown> | undefined
  return (info?.role as string | undefined) ?? (messageRecord.role as string | undefined)
}

export function applyCompletedMessageUsage(
  sessionId: string,
  data: Record<string, unknown>,
  currentProviderId: string
): void {
  const tokens = extractTokens(data)
  if (tokens) {
    const modelRef = extractModelRef(data, currentProviderId) ?? undefined
    useContextStore.getState().setSessionTokens(sessionId, tokens, modelRef)
  }

  const cost = extractCost(data)
  if (cost > 0) {
    const costKey = extractCostEventKey(data)
    if (costKey) {
      useContextStore.getState().addSessionCostOnce(sessionId, costKey, cost)
    } else {
      useContextStore.getState().addSessionCost(sessionId, cost)
    }
  }

  const modelUsageEntries = extractModelUsage(data)
  if (modelUsageEntries) {
    for (const entry of modelUsageEntries) {
      if (entry.contextWindow > 0) {
        useContextStore.getState().setModelLimit(entry.modelName, entry.contextWindow)
      }
    }
  }
}

export function useSessionUsageHydration({
  sessionId,
  timelineMessages,
  worktreePath,
  runtimeSessionId,
  currentProviderId
}: UseSessionUsageHydrationOptions): UseSessionUsageHydrationResult {
  const refreshUsageSummary = useCallback(async (): Promise<void> => {
    if (!window.usageAnalyticsOps?.fetchSessionSummary) {
      return
    }

    try {
      const result = await window.usageAnalyticsOps.fetchSessionSummary(sessionId)
      if (!result.success || !result.data) {
        return
      }

      const data = result.data
      const store = useContextStore.getState()
      if ((store.costBySession[sessionId] ?? 0) < data.total_cost) {
        store.setSessionCost(sessionId, data.total_cost)
      }
    } catch {
      // Non-fatal: live context store remains the source of truth while active.
    }
  }, [sessionId])

  useEffect(() => {
    refreshUsageSummary().catch(() => {})
  }, [refreshUsageSummary])

  // Hydrate context-window tokens from the last persisted assistant message
  // when the timeline first loads / session switches. Runtime events overwrite
  // this with the exact current snapshot once a new turn fires.
  useEffect(() => {
    if (timelineMessages.length === 0) return

    let usageMsg: TimelineMessage | undefined
    for (let i = timelineMessages.length - 1; i >= 0; i--) {
      const msg = timelineMessages[i]
      if (msg.role !== 'assistant' || !msg.usage) continue
      const u = msg.usage
      if ((u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0) > 0) {
        usageMsg = msg
        break
      }
    }
    if (!usageMsg?.usage) return

    const store = useContextStore.getState()
    const existing = store.tokensBySession[sessionId]
    const existingTotal =
      (existing?.input ?? 0) +
      (existing?.output ?? 0) +
      (existing?.cacheRead ?? 0) +
      (existing?.cacheWrite ?? 0)
    if (existingTotal > 0) return

    store.setSessionTokens(
      sessionId,
      {
        input: usageMsg.usage.input ?? 0,
        output: usageMsg.usage.output ?? 0,
        reasoning: usageMsg.usage.reasoning ?? 0,
        cacheRead: usageMsg.usage.cacheRead ?? 0,
        cacheWrite: usageMsg.usage.cacheWrite ?? 0
      },
      usageMsg.modelRef
    )
  }, [sessionId, timelineMessages])

  useEffect(() => {
    if (!worktreePath || !runtimeSessionId || !window.agentOps?.getMessages) return

    let cancelled = false
    ;(async () => {
      try {
        const result = await window.agentOps.getMessages(worktreePath, runtimeSessionId)
        if (!result.success || !Array.isArray(result.messages) || cancelled) return

        const store = useContextStore.getState()
        let totalCost = 0
        let snapshotTokens: TokenInfo | null = null
        let snapshotModelRef: SessionModelRef | undefined

        for (let i = result.messages.length - 1; i >= 0; i--) {
          const rawMessage = result.messages[i]
          if (typeof rawMessage !== 'object' || rawMessage === null) continue

          const messageRecord = rawMessage as Record<string, unknown>
          if (getMessageRole(messageRecord) !== 'assistant') continue

          totalCost += extractCost(messageRecord)

          if (!snapshotTokens) {
            const tokens = extractTokens(messageRecord)
            if (tokens) {
              snapshotTokens = tokens
              snapshotModelRef = extractModelRef(messageRecord, currentProviderId) ?? undefined
            }
          }
        }

        if (!cancelled && snapshotTokens && !store.tokensBySession[sessionId]) {
          store.setSessionTokens(sessionId, snapshotTokens, snapshotModelRef)
        }
        if (!cancelled && totalCost > 0 && (store.costBySession[sessionId] ?? 0) === 0) {
          store.setSessionCost(sessionId, totalCost)
        }
      } catch (err) {
        console.warn('[useSessionUsageHydration] getMessages hydrate failed:', err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [sessionId, worktreePath, runtimeSessionId, currentProviderId])

  return { refreshUsageSummary }
}
