import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { TimelineMessage } from '@shared/lib/timeline-types'
import { mapRawTranscriptToTimeline } from '@shared/lib/timeline-mappers'
import type { MessagePart } from '@shared/types/opencode'
import { getStreamingBuffer } from '@/stores/useSessionRuntimeStore'

export interface UseSessionTimelineOptions {
  worktreePath?: string | null
  opencodeSessionId?: string | null
  agentSdk?: string | null
}

export interface UseSessionTimelineResult {
  messages: TimelineMessage[]
  setMessages: Dispatch<SetStateAction<TimelineMessage[]>>
  loading: boolean
  refresh: () => Promise<TimelineMessage[]>
  appendOptimistic: (message: TimelineMessage) => void
  optimisticRef: MutableRefObject<TimelineMessage[]>
}

function cacheMessageAttachments(
  cache: Map<string, MessagePart[]>,
  message: TimelineMessage
): void {
  if (message.role !== 'user') return
  if (!message.content.trim()) return
  if (!message.attachments || message.attachments.length === 0) return
  cache.set(message.content.trim(), message.attachments)
}

export function useSessionTimeline(
  sessionId: string,
  options?: UseSessionTimelineOptions
): UseSessionTimelineResult {
  const worktreePath = options?.worktreePath
  const opencodeSessionId = options?.opencodeSessionId
  const agentSdk = options?.agentSdk
  // Restore optimistic messages from buffer on mount so they survive tab switches
  const initBuffer = getStreamingBuffer(sessionId)
  const [messages, setMessages] = useState<TimelineMessage[]>(
    () => (initBuffer?.optimisticMessages as TimelineMessage[] | undefined) ?? []
  )
  const [loading, setLoading] = useState(true)
  // Cache user-message attachments so they survive transcript refreshes.
  // Backend-loaded messages don't carry attachment data (images are base64-encoded
  // locally), so we preserve them by matching on normalised content.
  const attachmentCacheRef = useRef(new Map<string, MessagePart[]>())
  // Track optimistic (not-yet-persisted) user messages so they can be
  // merged back after a refresh and saved to the streaming buffer.
  const optimisticRef = useRef<TimelineMessage[]>(
    (initBuffer?.optimisticMessages as TimelineMessage[] | undefined) ?? []
  )

  const refresh = useCallback(async (): Promise<TimelineMessage[]> => {
    if (!window.agentOps?.getTimeline) {
      setLoading(false)
      return []
    }
    try {
      const result = await window.agentOps.getTimeline(sessionId)
      let durableMessages = result.messages

      const hasRenderableAssistant = durableMessages.some(
        (msg) =>
          msg.role === 'assistant' &&
          ((typeof msg.content === 'string' && msg.content.trim().length > 0) ||
            (Array.isArray(msg.parts) && msg.parts.length > 0))
      )

      const canFallbackToSdkMessages =
        Boolean(window.agentOps?.getMessages) &&
        typeof worktreePath === 'string' &&
        worktreePath.length > 0 &&
        typeof opencodeSessionId === 'string' &&
        opencodeSessionId.length > 0 &&
        agentSdk !== 'codex' &&
        agentSdk !== 'terminal'

      if (!hasRenderableAssistant && canFallbackToSdkMessages) {
        try {
          const transcript = await window.agentOps.getMessages(worktreePath!, opencodeSessionId!)
          if (
            transcript.success &&
            Array.isArray(transcript.messages) &&
            transcript.messages.length > 0
          ) {
            const fallbackMessages = mapRawTranscriptToTimeline(transcript.messages)
            const fallbackHasAssistant = fallbackMessages.some(
              (msg) =>
                msg.role === 'assistant' &&
                ((typeof msg.content === 'string' && msg.content.trim().length > 0) ||
                  (Array.isArray(msg.parts) && msg.parts.length > 0))
            )
            if (fallbackHasAssistant) {
              durableMessages = fallbackMessages
            }
          }
        } catch (err) {
          console.warn('[useSessionTimeline] getMessages fallback failed:', err)
        }
      }

      // Restore cached attachments onto refreshed messages
      const cache = attachmentCacheRef.current
      const restored =
        cache.size > 0
          ? durableMessages.map((msg) => {
              if (msg.role === 'user' && !msg.attachments) {
                const stored = cache.get(msg.content.trim())
                if (stored) return { ...msg, attachments: stored }
              }
              return msg
            })
          : durableMessages

      // Merge back optimistic messages not yet present in DB results.
      // Match by content — once the DB contains a user message with the same
      // trimmed text, the optimistic copy is no longer needed.
      const dbContents = new Set(
        restored
          .filter((message) => message.role === 'user')
          .map((message) => message.content.trim())
      )
      const stillPending = optimisticRef.current.filter(
        (message) => !dbContents.has(message.content.trim())
      )
      optimisticRef.current = stillPending
      // Merge by timestamp so optimistic user messages appear before any
      // assistant response that already landed in the DB, not tacked onto the end.
      const merged =
        stillPending.length > 0
          ? [...restored, ...stillPending].sort((a, b) => {
              const ta = Date.parse(a.timestamp)
              const tb = Date.parse(b.timestamp)
              if (Number.isNaN(ta) || Number.isNaN(tb)) return 0
              return ta - tb
            })
          : restored
      setMessages(merged)
      return merged
    } catch (err) {
      console.warn('[useSessionTimeline] getTimeline failed:', err)
      return []
    } finally {
      setLoading(false)
    }
  }, [sessionId, worktreePath, opencodeSessionId, agentSdk])

  useEffect(() => {
    setLoading(true)
    // Don't clear messages here — refresh() overwrites them once IPC returns.
    // Clearing early causes a flash-of-empty and loses optimistic messages
    // when SessionShell remounts (e.g. tab switch).
    attachmentCacheRef.current.clear()
    for (const message of optimisticRef.current) {
      cacheMessageAttachments(attachmentCacheRef.current, message)
    }
    refresh()
  }, [sessionId, refresh])

  // Optimistic insert — append a local user message before the server confirms
  const appendOptimistic = useCallback((message: TimelineMessage) => {
    // Cache attachments keyed by normalised content for restoreUserAttachments
    cacheMessageAttachments(attachmentCacheRef.current, message)
    // Track optimistic messages so they survive tab switches via streaming buffer
    optimisticRef.current = [...optimisticRef.current, message]
    setMessages((prev) => [...prev, message])
  }, [])

  return { messages, setMessages, loading, refresh, appendOptimistic, optimisticRef }
}
