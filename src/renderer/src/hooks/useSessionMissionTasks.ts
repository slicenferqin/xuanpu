import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import type { TimelineMessage } from '@shared/lib/timeline-types'
import {
  applySessionTaskToolEvent,
  extractMissionTasks,
  type SessionTask
} from '@/lib/session-tasks'
import { useSessionRuntimeStore } from '@/stores/useSessionRuntimeStore'

interface UseSessionMissionTasksOptions {
  sessionId: string
  timelineMessages: TimelineMessage[]
}

interface UseSessionMissionTasksResult {
  latestUserMessageId: string | null
  missionTasksRef: MutableRefObject<SessionTask[]>
  applyMissionTaskToolEvent: (
    toolName: string | undefined,
    input: unknown,
    toolUseId?: string
  ) => void
  syncMissionTasksFromMessages: (messages: TimelineMessage[]) => void
}

export function useSessionMissionTasks({
  sessionId,
  timelineMessages
}: UseSessionMissionTasksOptions): UseSessionMissionTasksResult {
  const missionTasksRef = useRef<SessionTask[]>([])
  const lastTaskRoundIdRef = useRef<string | null>(null)

  const setSharedMissionTasks = useCallback(
    (tasks: SessionTask[]) => {
      missionTasksRef.current = tasks
      useSessionRuntimeStore.getState().setSessionTasks(sessionId, tasks)
    },
    [sessionId]
  )

  const latestUserMessageId = useMemo(() => {
    for (let i = timelineMessages.length - 1; i >= 0; i--) {
      if (timelineMessages[i].role === 'user') return timelineMessages[i].id
    }
    return null
  }, [timelineMessages])

  useEffect(() => {
    if (lastTaskRoundIdRef.current !== latestUserMessageId) {
      lastTaskRoundIdRef.current = latestUserMessageId
      setSharedMissionTasks([])
    }
  }, [latestUserMessageId, setSharedMissionTasks])

  useEffect(() => {
    missionTasksRef.current = useSessionRuntimeStore.getState().getSessionTasks(sessionId)
  }, [sessionId])

  const applyMissionTaskToolEvent = useCallback(
    (toolName: string | undefined, input: unknown, toolUseId?: string) => {
      const nextTasks = applySessionTaskToolEvent(
        missionTasksRef.current,
        toolName,
        input,
        toolUseId
      )
      if (nextTasks !== missionTasksRef.current) {
        setSharedMissionTasks(nextTasks)
      }
    },
    [setSharedMissionTasks]
  )

  const syncMissionTasksFromMessages = useCallback(
    (messages: TimelineMessage[]) => {
      if (messages.length > 0) {
        setSharedMissionTasks(extractMissionTasks(messages))
      } else {
        setSharedMissionTasks([])
      }
    },
    [setSharedMissionTasks]
  )

  return {
    latestUserMessageId,
    missionTasksRef,
    applyMissionTaskToolEvent,
    syncMissionTasksFromMessages
  }
}
