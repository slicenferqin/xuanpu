import { X, ListOrdered } from 'lucide-react'
import { useI18n } from '@/i18n/useI18n'
import { cn } from '@/lib/utils'

export interface QueuedMsg {
  id: string
  content: string
  timestamp: number
}

interface QueuedMessagesBarProps {
  messages: QueuedMsg[]
  onCancel: (id: string) => void
  onClearAll: () => void
}

/**
 * Compact chip bar rendered directly above the input box to show messages the
 * user queued while the assistant is streaming. Replaces the old in-list
 * QueuedMessageBubble so the message area stays clean and pending sends stay
 * visually attached to the composer.
 */
export function QueuedMessagesBar({
  messages,
  onCancel,
  onClearAll
}: QueuedMessagesBarProps): React.JSX.Element | null {
  const { t } = useI18n()
  if (messages.length === 0) return null

  return (
    <div
      className={cn(
        'mb-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2',
        'animate-in fade-in slide-in-from-bottom-1 duration-200',
        'motion-reduce:animate-none'
      )}
      data-testid="queued-messages-bar"
      role="status"
      aria-live="polite"
    >
      {/* Header row */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ListOrdered className="h-3 w-3" />
          <span>{t('sessionView.queuedBar.heading', { count: messages.length })}</span>
        </div>
        {messages.length > 1 && (
          <button
            type="button"
            onClick={onClearAll}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            data-testid="queued-messages-clear-all"
          >
            {t('sessionView.queuedBar.clearAll')}
          </button>
        )}
      </div>

      {/* Chip list — scrollable when too many */}
      <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
        {messages.map((msg, idx) => {
          const preview = msg.content.replace(/\s+/g, ' ').trim()
          return (
            <div
              key={msg.id}
              className={cn(
                'group inline-flex items-center gap-1.5 max-w-[280px]',
                'rounded-md border border-border/60 bg-background/80 px-2 py-1',
                'text-xs text-foreground',
                'animate-in fade-in zoom-in-95 duration-150',
                'motion-reduce:animate-none'
              )}
              title={msg.content}
              data-testid={`queued-chip-${msg.id}`}
            >
              <span className="shrink-0 text-[10px] font-mono text-muted-foreground tabular-nums">
                {idx + 1}
              </span>
              <span className="truncate">{preview}</span>
              <button
                type="button"
                onClick={() => onCancel(msg.id)}
                className="shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                aria-label={t('sessionView.queuedBar.cancelAriaLabel')}
                data-testid={`queued-chip-cancel-${msg.id}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
