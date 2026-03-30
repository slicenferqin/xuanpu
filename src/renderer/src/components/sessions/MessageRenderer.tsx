import { Clock3 } from 'lucide-react'
import { UserBubble } from './UserBubble'
import { AssistantCanvas } from './AssistantCanvas'
import { CopyMessageButton } from './CopyMessageButton'
import { ForkMessageButton } from './ForkMessageButton'
import { PLAN_MODE_PREFIX, ASK_MODE_PREFIX } from '@/lib/constants'
import {
  formatElapsedTimer,
  formatFullTimestamp,
  formatMessageTimestamp
} from '@/lib/format-utils'
import { cn } from '@/lib/utils'
import type { OpenCodeMessage } from './SessionView'

interface MessageExecutionStatus {
  label: string
  elapsedMs: number
}

interface MessageRendererProps {
  message: OpenCodeMessage
  isStreaming?: boolean
  cwd?: string | null
  onForkAssistantMessage?: (message: OpenCodeMessage) => void | Promise<void>
  forkDisabled?: boolean
  isForking?: boolean
  showTimestamp?: boolean
  executionStatus?: MessageExecutionStatus | null
}

export function MessageRenderer({
  message,
  isStreaming = false,
  cwd,
  onForkAssistantMessage,
  forkDisabled = false,
  isForking = false,
  showTimestamp = false,
  executionStatus = null
}: MessageRendererProps): React.JSX.Element {
  const isPlanMode = message.role === 'user' && message.content.startsWith(PLAN_MODE_PREFIX)
  const isAskMode = message.role === 'user' && message.content.startsWith(ASK_MODE_PREFIX)
  const displayContent = isPlanMode
    ? message.content.slice(PLAN_MODE_PREFIX.length)
    : isAskMode
      ? message.content.slice(ASK_MODE_PREFIX.length)
      : message.content
  const isAssistantMessage = message.role === 'assistant' && !isStreaming
  const timestampLabel = showTimestamp ? formatMessageTimestamp(message.timestamp) : ''
  const fullTimestamp = timestampLabel ? formatFullTimestamp(message.timestamp) : ''
  const hasMeta = !!timestampLabel || !!executionStatus
  const isUserMessage = message.role === 'user'

  return (
    <div className="group relative">
      <CopyMessageButton content={displayContent} />
      {isAssistantMessage && onForkAssistantMessage && (
        <ForkMessageButton
          onFork={() => onForkAssistantMessage(message)}
          disabled={forkDisabled}
          isForking={isForking}
        />
      )}
      {message.role === 'user' ? (
        <UserBubble
          content={displayContent}
          timestamp={message.timestamp}
          isPlanMode={isPlanMode}
          isAskMode={isAskMode}
          attachments={message.attachments}
        />
      ) : (
        <AssistantCanvas
          content={message.content}
          timestamp={message.timestamp}
          isStreaming={isStreaming}
          parts={message.parts}
          cwd={cwd}
        />
      )}
      {hasMeta && (
        <div
          className={cn(
            'px-6 -mt-1 pb-1',
            isUserMessage && 'flex justify-end'
          )}
          data-testid="message-meta"
        >
          <div
            className={cn(
              'flex max-w-full flex-wrap items-center gap-2',
              isUserMessage && 'max-w-[80%] justify-end'
            )}
            aria-live={executionStatus ? 'polite' : undefined}
          >
            {executionStatus && (
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium tabular-nums backdrop-blur-sm',
                  'border-primary/18 bg-primary/[0.07] text-foreground/78 shadow-[0_1px_10px_rgba(15,23,42,0.04)]'
                )}
                data-testid="message-execution-status"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-primary/75 animate-pulse" />
                <span>
                  {executionStatus.label}... {formatElapsedTimer(executionStatus.elapsedMs)}
                </span>
              </span>
            )}
            {timestampLabel && (
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/72 px-2.5 py-1',
                  'text-[11px] font-medium text-muted-foreground/80 tabular-nums shadow-[0_1px_10px_rgba(15,23,42,0.03)] backdrop-blur-sm'
                )}
                title={fullTimestamp}
              >
                <Clock3 className="h-3 w-3 text-muted-foreground/65" />
                <span data-testid="message-timestamp">{timestampLabel}</span>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
