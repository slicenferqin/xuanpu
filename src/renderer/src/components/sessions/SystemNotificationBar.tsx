import { CheckCircle2, XCircle, Info } from 'lucide-react'
import {
  extractTaskNotifications,
  simplifyTaskNotification
} from '@/lib/content-sanitizer'
import { cn } from '@/lib/utils'

interface SystemNotificationBarProps {
  content: string
}

/**
 * Renders system notification messages (e.g. task-notification) as a lightweight
 * centred divider bar instead of a full chat bubble.
 *
 * Visual style: a thin horizontal rule with a small icon + label centred on it,
 * similar to date dividers or git merge commit markers.
 */
export function SystemNotificationBar({ content }: SystemNotificationBarProps): React.JSX.Element | null {
  const notifications = extractTaskNotifications(content)

  // If there are no recognisable task-notification blocks, render a generic
  // muted system line so the message doesn't silently disappear.
  if (notifications.length === 0) {
    const trimmed = content.trim()
    if (!trimmed) return null

    return (
      <div className="flex items-center gap-3 px-6 py-1.5 select-none">
        <div className="h-px flex-1 bg-border/40" />
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground/50">
          <Info className="h-3 w-3 shrink-0" />
          <span className="max-w-[400px] truncate">{trimmed}</span>
        </span>
        <div className="h-px flex-1 bg-border/40" />
      </div>
    )
  }

  return (
    <>
      {notifications.map((raw, i) => {
        const { label, status } = simplifyTaskNotification(raw)
        const Icon = status === 'failed' ? XCircle : CheckCircle2

        return (
          <div
            key={i}
            className="flex items-center gap-3 px-6 py-1.5 select-none"
          >
            <div className="h-px flex-1 bg-border/40" />
            <span
              className={cn(
                'flex items-center gap-1.5 text-[11px]',
                status === 'failed'
                  ? 'text-destructive/60'
                  : 'text-muted-foreground/50'
              )}
            >
              <Icon className="h-3 w-3 shrink-0" />
              <span className="max-w-[400px] truncate">{label}</span>
            </span>
            <div className="h-px flex-1 bg-border/40" />
          </div>
        )
      })}
    </>
  )
}
