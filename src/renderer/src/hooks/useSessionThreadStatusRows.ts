import { useEffect, useMemo } from 'react'
import type { TimelineMessage } from '@shared/lib/timeline-types'
import type { ThreadStatusRowData } from '@/components/session-hq/ThreadStatusRow'
import { updateStreamingBuffer, type SessionLifecycle } from '@/stores/useSessionRuntimeStore'

type CompactionState = {
  phase: 'running' | 'completed'
  timestamp: number
} | null

interface UseSessionThreadStatusRowsOptions {
  sessionId: string
  lifecycle: SessionLifecycle
  runStartedAt: number | null
  compactionState: CompactionState
  timelineMessages: TimelineMessage[]
}

interface UseSessionThreadStatusRowsResult {
  ephemeralStatusRows: ThreadStatusRowData[]
  inflightCompactionRow: ThreadStatusRowData | null
}

export function useSessionThreadStatusRows({
  sessionId,
  lifecycle,
  runStartedAt,
  compactionState,
  timelineMessages
}: UseSessionThreadStatusRowsOptions): UseSessionThreadStatusRowsResult {
  const hasDurableCompactionMessage = useMemo(
    () =>
      timelineMessages.some((message) =>
        (message.parts ?? []).some((part) => part.type === 'compaction')
      ),
    [timelineMessages]
  )

  const inflightCompactionRow = useMemo<ThreadStatusRowData | null>(() => {
    if (!compactionState) return null
    if (compactionState.phase === 'completed' && hasDurableCompactionMessage) return null
    return {
      id: `compaction-${sessionId}`,
      kind: compactionState.phase === 'running' ? 'compacting' : 'compacted',
      timestamp: compactionState.timestamp,
      ephemeral: true
    }
  }, [compactionState, hasDurableCompactionMessage, sessionId])

  const ephemeralStatusRows = useMemo<ThreadStatusRowData[]>(() => {
    const rows: ThreadStatusRowData[] = []

    if (runStartedAt && (lifecycle === 'busy' || lifecycle === 'materializing')) {
      rows.push({
        id: `running-${sessionId}`,
        kind: 'running',
        timestamp: runStartedAt,
        startedAt: runStartedAt,
        ephemeral: true
      })
    }

    return rows
  }, [lifecycle, runStartedAt, sessionId])

  useEffect(() => {
    if (hasDurableCompactionMessage && compactionState?.phase === 'completed') {
      updateStreamingBuffer(
        sessionId,
        (current) => ({
          ...current,
          compactionState: null
        }),
        { notify: 'immediate' }
      )
    }
  }, [hasDurableCompactionMessage, compactionState, sessionId])

  return { ephemeralStatusRows, inflightCompactionRow }
}
