import { cn } from '@/lib/utils'
import type { MessagePart } from '@shared/types/opencode'

interface UserBubbleProps {
  content: string
  timestamp?: string
  isPlanMode?: boolean
  isAskMode?: boolean
  attachments?: MessagePart[]
}

export function UserBubble({
  content,
  isPlanMode,
  isAskMode,
  attachments
}: UserBubbleProps): React.JSX.Element {
  const imageAttachments =
    attachments?.filter(
      (a): a is Extract<MessagePart, { type: 'file' }> =>
        a.type === 'file' && a.mime.startsWith('image/')
    ) ?? []

  return (
    <div className="flex justify-end px-6 py-4" data-testid="message-user">
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-4 py-3',
          isPlanMode
            ? 'bg-purple-500/10 text-foreground'
            : isAskMode
              ? 'bg-amber-500/10 text-foreground'
              : 'bg-primary/10 text-foreground'
        )}
      >
        {isPlanMode && (
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold bg-purple-500/15 text-purple-400 mb-1"
            data-testid="plan-mode-badge"
          >
            PLAN
          </span>
        )}
        {isAskMode && (
          <span
            className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold bg-amber-500/15 text-amber-400 mb-1"
            data-testid="ask-mode-badge"
          >
            ASK
          </span>
        )}
        {imageAttachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2" data-testid="user-message-images">
            {imageAttachments.map((att, i) => (
              <img
                key={i}
                src={att.url}
                alt={att.filename ?? 'image'}
                className="max-h-48 max-w-full rounded-lg border border-border/50 object-contain"
              />
            ))}
          </div>
        )}
        <p className="text-sm whitespace-pre-wrap leading-relaxed">{content}</p>
      </div>
    </div>
  )
}
