import { useCallback, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { TimelineMessage } from '@shared/lib/timeline-types'
import type { MessagePart } from '@shared/types/opencode'

interface CreateOptimisticUserMessageInput {
  id?: string
  idPrefix?: string
  content: string
  timestamp?: string
  deliveryStatus?: TimelineMessage['deliveryStatus']
  attachments?: MessagePart[]
}

interface AppendOptimisticUserMessageOptions {
  baseMessages?: TimelineMessage[]
}

export interface OptimisticTimelineMessagesController {
  appendOptimisticUserMessage: (
    message: TimelineMessage,
    options?: AppendOptimisticUserMessageOptions
  ) => void
  removeOptimisticUserMessage: (messageId: string) => void
  trimOptimisticMessagesToTimeline: (messages: TimelineMessage[]) => void
}

interface UseOptimisticTimelineMessagesOptions {
  appendOptimistic: (message: TimelineMessage) => void
  optimisticRef: MutableRefObject<TimelineMessage[]>
  timelineMessagesRef: MutableRefObject<TimelineMessage[]>
  setMessages: Dispatch<SetStateAction<TimelineMessage[]>>
  syncOptimisticMessagesToMirror: () => void
  requestTurnTopScroll: (roundId: string) => void
}

export function createOptimisticUserMessage({
  id,
  idPrefix = 'optimistic',
  content,
  timestamp,
  deliveryStatus,
  attachments
}: CreateOptimisticUserMessageInput): TimelineMessage {
  const messageAttachments = attachments?.length ? attachments : undefined

  return {
    id: id ?? `${idPrefix}-${Date.now()}`,
    role: 'user',
    content: content.trim(),
    timestamp: timestamp ?? new Date().toISOString(),
    ...(deliveryStatus ? { deliveryStatus } : {}),
    ...(messageAttachments ? { attachments: messageAttachments } : {})
  }
}

export function useOptimisticTimelineMessages({
  appendOptimistic,
  optimisticRef,
  timelineMessagesRef,
  setMessages,
  syncOptimisticMessagesToMirror,
  requestTurnTopScroll
}: UseOptimisticTimelineMessagesOptions): OptimisticTimelineMessagesController {
  const appendOptimisticUserMessage = useCallback(
    (message: TimelineMessage, options?: AppendOptimisticUserMessageOptions) => {
      appendOptimistic(message)
      requestTurnTopScroll(message.id)
      timelineMessagesRef.current = [
        ...(options?.baseMessages ?? timelineMessagesRef.current),
        message
      ]
      syncOptimisticMessagesToMirror()
    },
    [appendOptimistic, requestTurnTopScroll, syncOptimisticMessagesToMirror, timelineMessagesRef]
  )

  const removeOptimisticUserMessage = useCallback(
    (messageId: string) => {
      optimisticRef.current = optimisticRef.current.filter((message) => message.id !== messageId)
      timelineMessagesRef.current = timelineMessagesRef.current.filter(
        (message) => message.id !== messageId
      )
      setMessages((previous) => previous.filter((message) => message.id !== messageId))
      syncOptimisticMessagesToMirror()
    },
    [optimisticRef, setMessages, syncOptimisticMessagesToMirror, timelineMessagesRef]
  )

  const trimOptimisticMessagesToTimeline = useCallback(
    (messages: TimelineMessage[]) => {
      setMessages(messages)
      timelineMessagesRef.current = messages
      optimisticRef.current = optimisticRef.current.filter((message) =>
        messages.some((candidate) => candidate.id === message.id)
      )
      syncOptimisticMessagesToMirror()
    },
    [optimisticRef, setMessages, syncOptimisticMessagesToMirror, timelineMessagesRef]
  )

  return useMemo(
    () => ({
      appendOptimisticUserMessage,
      removeOptimisticUserMessage,
      trimOptimisticMessagesToTimeline
    }),
    [
      appendOptimisticUserMessage,
      removeOptimisticUserMessage,
      trimOptimisticMessagesToTimeline
    ]
  )
}
