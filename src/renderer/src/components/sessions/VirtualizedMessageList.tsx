import { forwardRef, useImperativeHandle, useMemo, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { MessageRenderer } from './MessageRenderer'
import type { OpenCodeMessage, StreamingPart } from './SessionView'
import { AlertCircle, RefreshCw, Minimize2 } from 'lucide-react'
import { useI18n } from '@/i18n/useI18n'

// ── Types ──────────────────────────────────────────────────────

interface MessageExecutionStatus {
  label: string
  elapsedMs: number
}

interface SessionRetryState {
  attempt?: number
  message?: string
  next?: number
}

type VirtualListItem =
  | { type: 'message'; message: OpenCodeMessage; key: string }
  | { type: 'revert-banner'; key: string }
  | { type: 'error-banner'; key: string }
  | { type: 'retry-banner'; key: string }
  | { type: 'streaming'; key: string }
  | { type: 'typing'; key: string }

export interface VirtualizedMessageListHandle {
  scrollToEnd: (behavior?: ScrollBehavior) => void
}

export interface VirtualizedMessageListProps {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  visibleMessages: OpenCodeMessage[]
  roundTerminalMessageIds: Set<string>
  currentRoundAnchorId: string | null
  hasStreamingContent: boolean
  executionStatusMeta: MessageExecutionStatus | null
  worktreePath: string | null
  // Message action handlers
  onForkAssistantMessage: (message: OpenCodeMessage) => void | Promise<void>
  forkingMessageId: string | null
  editingMessageId: string | null
  lastUserMessageId: string | null
  canEditMessage: (id: string) => boolean
  onEditMessage: (message: OpenCodeMessage) => void
  onSaveEdit: (id: string) => void
  onCancelEdit: () => void
  editingContent: string
  onEditingContentChange: (content: string) => void
  // Revert banner
  revertMessageID: string | null
  revertedUserCount: number
  onRedoRevert: () => void
  // Error banner
  sessionErrorMessage: string | null
  sessionErrorStderr: string | null
  // Retry banner
  sessionRetry: SessionRetryState | null
  retrySecondsRemaining: number | null
  // Streaming
  streamingContent: string
  streamingParts: StreamingPart[]
  isStreaming: boolean
  // Typing / compacting
  isSending: boolean
  hasVisibleWritingCursor: boolean
  isCompacting: boolean
}

// ── Component ──────────────────────────────────────────────────

export const VirtualizedMessageList = forwardRef<
  VirtualizedMessageListHandle,
  VirtualizedMessageListProps
>(function VirtualizedMessageList(props, ref) {
  const { t } = useI18n()
  const {
    scrollContainerRef,
    visibleMessages,
    roundTerminalMessageIds,
    currentRoundAnchorId,
    hasStreamingContent,
    executionStatusMeta,
    worktreePath,
    onForkAssistantMessage,
    forkingMessageId,
    editingMessageId,
    lastUserMessageId,
    canEditMessage,
    onEditMessage,
    onSaveEdit,
    onCancelEdit,
    editingContent,
    onEditingContentChange,
    revertMessageID,
    revertedUserCount,
    onRedoRevert,
    sessionErrorMessage,
    sessionErrorStderr,
    sessionRetry,
    retrySecondsRemaining,
    streamingContent,
    streamingParts,
    isStreaming,
    isSending,
    hasVisibleWritingCursor,
    isCompacting
  } = props

  // Build the flat list of virtual items
  const items = useMemo<VirtualListItem[]>(() => {
    const result: VirtualListItem[] = []

    // 1. All visible messages
    for (const msg of visibleMessages) {
      result.push({ type: 'message', message: msg, key: msg.id })
    }

    // 2. Revert banner
    if (revertMessageID && revertedUserCount > 0) {
      result.push({ type: 'revert-banner', key: 'revert-banner' })
    }

    // 3. Error banner
    if (sessionErrorMessage) {
      result.push({ type: 'error-banner', key: 'error-banner' })
    }

    // 4. Retry banner
    if (sessionRetry) {
      result.push({ type: 'retry-banner', key: 'retry-banner' })
    }

    // 5. Streaming message
    if (hasStreamingContent) {
      result.push({ type: 'streaming', key: 'streaming-msg' })
    }

    // 6. Typing indicator
    if (isSending && !hasVisibleWritingCursor) {
      result.push({ type: 'typing', key: 'typing-indicator' })
    }

    return result
  }, [
    visibleMessages,
    revertMessageID,
    revertedUserCount,
    sessionErrorMessage,
    sessionRetry,
    hasStreamingContent,
    isSending,
    hasVisibleWritingCursor
  ])

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 150,
    overscan: 5,
    measureElement: (element) => element.getBoundingClientRect().height
  })

  // Expose scrollToEnd
  useImperativeHandle(
    ref,
    () => ({
      scrollToEnd: (behavior?: ScrollBehavior) => {
        if (items.length > 0) {
          virtualizer.scrollToIndex(items.length - 1, {
            align: 'end',
            behavior: behavior ?? 'instant'
          })
        }
      }
    }),
    [virtualizer, items.length]
  )

  const renderItem = useCallback(
    (item: VirtualListItem) => {
      switch (item.type) {
        case 'message': {
          const msg = item.message
          return (
            <MessageRenderer
              message={msg}
              showTimestamp={roundTerminalMessageIds.has(msg.id)}
              executionStatus={
                currentRoundAnchorId === msg.id && !hasStreamingContent
                  ? executionStatusMeta
                  : null
              }
              cwd={worktreePath}
              onForkAssistantMessage={onForkAssistantMessage}
              forkDisabled={forkingMessageId !== null && forkingMessageId !== msg.id}
              isForking={forkingMessageId === msg.id}
              isEditing={editingMessageId === msg.id}
              isLastUserMessage={msg.id === lastUserMessageId}
              canEdit={canEditMessage(msg.id)}
              onEditClick={() => onEditMessage(msg)}
              onEditSave={() => onSaveEdit(msg.id)}
              onEditCancel={onCancelEdit}
              editingContent={editingMessageId === msg.id ? editingContent : undefined}
              onEditingContentChange={onEditingContentChange}
            />
          )
        }

        case 'revert-banner':
          return (
            <div
              className="mx-6 my-3 rounded-lg border border-border/50 bg-muted/30 px-4 py-3"
              data-testid="revert-banner"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  {revertedUserCount === 1
                    ? t('sessionView.revert.summarySingular')
                    : t('sessionView.revert.summaryPlural', { count: revertedUserCount })}
                </span>
                <button
                  className="text-xs text-primary hover:text-primary/80 font-medium transition-colors"
                  onClick={onRedoRevert}
                >
                  {t('sessionView.revert.restore')}
                </button>
              </div>
            </div>
          )

        case 'error-banner':
          return (
            <div
              className="mx-6 my-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3"
              data-testid="session-error-banner"
            >
              <div className="flex items-start gap-2 text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="text-sm font-medium">{t('sessionView.sessionError.title')}</p>
                  <p className="mt-0.5 text-sm text-destructive/90">{sessionErrorMessage}</p>
                  {sessionErrorStderr && (
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-destructive/10 px-2 py-1.5 font-mono text-xs text-destructive/80">
                      {sessionErrorStderr}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          )

        case 'retry-banner':
          return (
            <div
              className="mx-6 my-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3"
              data-testid="session-retry-banner"
            >
              <div className="flex items-start gap-2 text-destructive">
                <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
                <div>
                  <p className="text-sm font-medium">
                    {retrySecondsRemaining !== null
                      ? t('sessionView.retry.withCountdown', {
                          seconds: retrySecondsRemaining,
                          attempt: sessionRetry!.attempt ?? 1
                        })
                      : t('sessionView.retry.withoutCountdown', {
                          attempt: sessionRetry!.attempt ?? 1
                        })}
                  </p>
                  {sessionRetry!.message && (
                    <p className="mt-0.5 text-sm text-destructive/90">
                      {sessionRetry!.message}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )

        case 'streaming':
          return (
            <MessageRenderer
              message={{
                id: 'streaming',
                role: 'assistant',
                content: streamingContent,
                timestamp: new Date().toISOString(),
                parts: streamingParts
              }}
              showTimestamp={false}
              executionStatus={
                currentRoundAnchorId === 'streaming' ? executionStatusMeta : null
              }
              isStreaming={isStreaming}
              cwd={worktreePath}
              onForkAssistantMessage={onForkAssistantMessage}
              forkDisabled={true}
            />
          )

        case 'typing':
          return (
            <div className="px-6 py-5" data-testid="typing-indicator">
              {isCompacting ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Minimize2 className="h-3.5 w-3.5 shrink-0 animate-pulse" />
                  <span>{t('sessionView.compacting')}</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" />
                  <span
                    className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce"
                    style={{ animationDelay: '0.1s' }}
                  />
                  <span
                    className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce"
                    style={{ animationDelay: '0.2s' }}
                  />
                </div>
              )}
            </div>
          )

        default:
          return null
      }
    },
    [
      roundTerminalMessageIds,
      currentRoundAnchorId,
      hasStreamingContent,
      executionStatusMeta,
      worktreePath,
      onForkAssistantMessage,
      forkingMessageId,
      editingMessageId,
      lastUserMessageId,
      canEditMessage,
      onEditMessage,
      onSaveEdit,
      onCancelEdit,
      editingContent,
      onEditingContentChange,
      revertedUserCount,
      onRedoRevert,
      sessionErrorMessage,
      sessionErrorStderr,
      sessionRetry,
      retrySecondsRemaining,
      streamingContent,
      streamingParts,
      isStreaming,
      isCompacting,
      t
    ]
  )

  return (
    <div
      className="py-4"
      style={{
        height: `${virtualizer.getTotalSize()}px`,
        width: '100%',
        position: 'relative'
      }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const item = items[virtualRow.index]
        return (
          <div
            key={item.key}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`
            }}
          >
            {renderItem(item)}
          </div>
        )
      })}
    </div>
  )
})
