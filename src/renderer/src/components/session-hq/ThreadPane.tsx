/**
 * ThreadPane — Phase 4
 *
 * Main conversation thread display. Wraps the existing VirtualizedMessageList
 * with a scroll container and connects it to timeline data from the store.
 *
 * This is a thin adapter — all message rendering logic lives in
 * VirtualizedMessageList and the individual tool renderers.
 */

import React, { useRef, useCallback, useState, useMemo } from 'react'
import {
  VirtualizedMessageList,
  type VirtualizedMessageListHandle
} from '../sessions/VirtualizedMessageList'
import { ScrollToBottomFab } from '../sessions/ScrollToBottomFab'
import type { DroidMessage, StreamingPart } from '../sessions/SessionView'
import type { TimelineMessage } from '@shared/lib/timeline-types'

// ---------------------------------------------------------------------------
// Helper: derive visible messages (filter system / empty messages)
// ---------------------------------------------------------------------------

function hasMeaningfulContent(message: DroidMessage): boolean {
  if (message.role === 'system') return false
  if (message.role === 'user') {
    return message.content.trim().length > 0 || (message.attachments?.length ?? 0) > 0
  }
  if (message.content.trim().length > 0) return true
  return (
    message.parts?.some((part) => {
      if (part.type === 'tool_use' || part.type === 'subtask' || part.type === 'compaction') {
        return true
      }
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0) {
        return true
      }
      return false
    }) ?? false
  )
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ThreadPaneProps {
  /** Durable timeline messages from getTimeline() IPC */
  timelineMessages: TimelineMessage[]
  /** Live streaming parts from the current assistant response */
  streamingParts: StreamingPart[]
  /** Live streaming text fallback */
  streamingContent: string
  /** Whether the session is currently streaming */
  isStreaming: boolean
  /** Whether the session is compacting context */
  isCompacting: boolean
  /** Worktree path for tool links */
  worktreePath: string | null
  /** Callback when user forks from an assistant message */
  onForkAssistantMessage?: (message: DroidMessage) => void
  /** Currently forking message ID */
  forkingMessageId?: string | null
}

export interface ThreadPaneHandle {
  scrollToEnd: (behavior?: ScrollBehavior) => void
}

export const ThreadPane = React.forwardRef<ThreadPaneHandle, ThreadPaneProps>(
  function ThreadPane(props, ref) {
    const {
      timelineMessages,
      streamingParts,
      streamingContent,
      isStreaming,
      isCompacting,
      worktreePath,
      onForkAssistantMessage,
      forkingMessageId
    } = props

    const scrollContainerRef = useRef<HTMLDivElement>(null)
    const virtualizedListRef = useRef<VirtualizedMessageListHandle>(null)

    // Cast timeline messages to the DroidMessage type used by VirtualizedMessageList.
    // They are structurally identical (Phase 2 ensured this).
    const messages = timelineMessages as DroidMessage[]

    const visibleMessages = useMemo(
      () => messages.filter(hasMeaningfulContent),
      [messages]
    )

    // Derive round terminal IDs for timestamp display
    const roundTerminalMessageIds = useMemo(() => {
      const ids = new Set<string>()
      if (visibleMessages.length === 0) return ids
      let chunkStart = 0
      for (let i = 1; i <= visibleMessages.length; i++) {
        const isBoundary = i === visibleMessages.length || visibleMessages[i]?.role === 'user'
        if (!isBoundary) continue
        const opener = visibleMessages[chunkStart]
        if (opener?.role === 'user' && hasMeaningfulContent(opener)) ids.add(opener.id)
        for (let j = i - 1; j >= chunkStart; j--) {
          if (hasMeaningfulContent(visibleMessages[j])) {
            ids.add(visibleMessages[j].id)
            break
          }
        }
        chunkStart = i
      }
      return ids
    }, [visibleMessages])

    const lastUserMessageId = useMemo(() => {
      for (let i = visibleMessages.length - 1; i >= 0; i--) {
        if (visibleMessages[i].role === 'user') return visibleMessages[i].id
      }
      return null
    }, [visibleMessages])

    // Editing state (view-layer only)
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
    const [editingContent, setEditingContent] = useState('')

    const handleEditMessage = useCallback((message: DroidMessage) => {
      setEditingMessageId(message.id)
      setEditingContent(message.content)
    }, [])

    const handleSaveEdit = useCallback((_id: string) => {
      // TODO: implement edit-and-resend in Phase 5
      setEditingMessageId(null)
      setEditingContent('')
    }, [])

    const handleCancelEdit = useCallback(() => {
      setEditingMessageId(null)
      setEditingContent('')
    }, [])

    const canEditMessage = useCallback(
      (id: string) => id === lastUserMessageId && !isStreaming,
      [lastUserMessageId, isStreaming]
    )

    const handleFork = useCallback(
      (message: DroidMessage) => {
        onForkAssistantMessage?.(message)
      },
      [onForkAssistantMessage]
    )

    // Expose scrollToEnd via ref
    React.useImperativeHandle(ref, () => ({
      scrollToEnd: (behavior?: ScrollBehavior) => {
        virtualizedListRef.current?.scrollToEnd(behavior)
      }
    }))

    const hasStreamingContent = streamingParts.length > 0 || streamingContent.length > 0

    return (
      <div className="flex-1 flex flex-col overflow-hidden relative">
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto"
        >
          <VirtualizedMessageList
            ref={virtualizedListRef}
            scrollContainerRef={scrollContainerRef}
            visibleMessages={visibleMessages}
            roundTerminalMessageIds={roundTerminalMessageIds}
            currentRoundAnchorId={null}
            hasStreamingContent={hasStreamingContent}
            executionStatusMeta={null}
            worktreePath={worktreePath}
            onForkAssistantMessage={handleFork}
            forkingMessageId={forkingMessageId ?? null}
            editingMessageId={editingMessageId}
            lastUserMessageId={lastUserMessageId}
            canEditMessage={canEditMessage}
            onEditMessage={handleEditMessage}
            onSaveEdit={handleSaveEdit}
            onCancelEdit={handleCancelEdit}
            editingContent={editingContent}
            onEditingContentChange={setEditingContent}
            revertMessageID={null}
            revertedUserCount={0}
            onRedoRevert={() => {}}
            sessionErrorMessage={null}
            sessionErrorStderr={null}
            sessionRetry={null}
            retrySecondsRemaining={null}
            streamingContent={streamingContent}
            streamingParts={streamingParts}
            isStreaming={isStreaming}
            isSending={false}
            hasVisibleWritingCursor={isStreaming}
            isCompacting={isCompacting}
          />
        </div>

        <ScrollToBottomFab
          scrollContainerRef={scrollContainerRef}
          isStreaming={isStreaming}
          onClick={() => virtualizedListRef.current?.scrollToEnd('smooth')}
        />
      </div>
    )
  }
)
