import React, { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Loader2, Rows3 } from 'lucide-react'
import { useI18n } from '@/i18n/useI18n'
import { cn } from '@/lib/utils'
import { formatMessageTime } from '@/lib/format-time'

export type ThreadStatusRowKind = 'running' | 'compacting' | 'compacted'

export interface ThreadStatusRowData {
  id: string
  kind: ThreadStatusRowKind
  timestamp: number
  startedAt?: number
  ephemeral?: boolean
}

function formatElapsedMs(ms: number): string {
  const seconds = Math.max(0, ms / 1000)
  return `${seconds.toFixed(1)}s`
}

export function ThreadStatusRow({
  status
}: {
  status: ThreadStatusRowData
}): React.JSX.Element {
  const { t } = useI18n()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (status.kind !== 'running' || !status.startedAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [status.kind, status.startedAt])

  const label = useMemo(() => {
    switch (status.kind) {
      case 'compacting':
        return t('threadStatus.compacting')
      case 'compacted':
        return t('threadStatus.compacted')
      case 'running': {
        const duration = status.startedAt ? formatElapsedMs(now - status.startedAt) : '0.0s'
        return t('threadStatus.running', { duration })
      }
    }
  }, [status.kind, status.startedAt, now, t])

  const Icon =
    status.kind === 'compacted' ? CheckCircle2 : status.kind === 'running' ? Rows3 : Loader2

  return (
    <div
      className={cn(
        'relative pl-10 mb-4',
        status.ephemeral && 'animate-in fade-in duration-200'
      )}
      data-testid={`thread-status-${status.kind}`}
    >
      <div className="absolute left-[15px] top-0 bottom-0 w-[2px] bg-border" />
      <div
        className={cn(
          'absolute left-[4px] top-2.5 w-[24px] h-[24px] rounded-full',
          'flex items-center justify-center z-10',
          status.kind === 'compacted'
            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
            : 'bg-muted text-muted-foreground'
        )}
      >
        <Icon
          className={cn(
            'h-3.5 w-3.5',
            status.kind !== 'compacted' && 'animate-spin'
          )}
        />
      </div>
      <div className="rounded-[10px] border border-border/50 bg-card/70 px-3.5 py-2.5">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {formatMessageTime(new Date(status.timestamp).toISOString())}
        </div>
      </div>
    </div>
  )
}
