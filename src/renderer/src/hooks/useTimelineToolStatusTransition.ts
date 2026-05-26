import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { StreamingPart, TimelineMessage } from '@shared/lib/timeline-types'
import { updateStreamingBuffer } from '@/stores/useSessionRuntimeStore'

export type TimelineToolStatus = 'success' | 'error' | 'rejected'

interface UseTimelineToolStatusTransitionOptions {
  sessionId: string
  timelineMessagesRef: MutableRefObject<TimelineMessage[]>
  setMessages: Dispatch<SetStateAction<TimelineMessage[]>>
}

export function useTimelineToolStatusTransition({
  sessionId,
  timelineMessagesRef,
  setMessages
}: UseTimelineToolStatusTransitionOptions): (
  toolUseID: string,
  status: TimelineToolStatus,
  error?: string
) => void {
  return useCallback(
    (toolUseID: string, status: TimelineToolStatus, error?: string) => {
      const mapper = (part: StreamingPart): StreamingPart =>
        part.type === 'tool_use' && part.toolUse?.id === toolUseID
          ? { ...part, toolUse: { ...part.toolUse, status, ...(error ? { error } : {}) } }
          : part

      updateStreamingBuffer(
        sessionId,
        (current) => ({
          ...current,
          parts: current.parts.map(mapper)
        }),
        { notify: 'immediate' }
      )

      // Persist the visual status in committed timeline messages too, since
      // the plan card may already have been materialized from durable history.
      const updatedMessages = timelineMessagesRef.current.map((message) => {
        if (!message.parts) return message
        let changed = false
        const updatedParts = message.parts.map((part) => {
          const result = mapper(part)
          if (result !== part) changed = true
          return result
        })
        return changed ? { ...message, parts: updatedParts } : message
      })
      timelineMessagesRef.current = updatedMessages
      setMessages(updatedMessages)
    },
    [sessionId, setMessages, timelineMessagesRef]
  )
}
