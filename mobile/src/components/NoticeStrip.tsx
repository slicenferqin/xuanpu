/**
 * NoticeStrip: collapsible top strip rendering `system/notice` frames.
 *
 *   - When 0 notices: renders nothing.
 *   - When >=1 notices: shows the most recent one as a one-line bar coloured
 *     by level, with a chevron expanding the full list. Each entry can be
 *     dismissed individually.
 *
 * Categories (e.g. context_usage) are displayed as a small mono badge so the
 * user can pattern-match without reading the body.
 */

import { useState } from 'react'
import type { NoticeEntry } from '../hooks/useSessionStream'

export function NoticeStrip({
  notices,
  onDismiss,
  onClearAll
}: {
  notices: NoticeEntry[]
  onDismiss: (seq: number) => void
  onClearAll: () => void
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  if (notices.length === 0) return null
  const top = notices[0]
  const cls = levelClass(top.level)

  return (
    <div className={'border-b ' + cls.bar}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left"
      >
        <span className={'text-[10px] font-mono uppercase ' + cls.badge}>
          {top.category}
        </span>
        <span className="flex-1 text-xs truncate">{top.text}</span>
        {notices.length > 1 && (
          <span className="text-xs text-zinc-500">+{notices.length - 1}</span>
        )}
        <span className="text-xs text-zinc-500">{expanded ? '▴' : '▾'}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-1">
          {notices.map((n) => (
            <div
              key={n.seq}
              className={
                'flex items-start gap-2 text-xs px-2 py-1 rounded ' +
                levelClass(n.level).row
              }
            >
              <span className={'font-mono uppercase shrink-0 ' + levelClass(n.level).badge}>
                {n.category}
              </span>
              <span className="flex-1 break-words">{n.text}</span>
              <button
                onClick={() => onDismiss(n.seq)}
                className="text-zinc-500 active:text-zinc-200"
                aria-label="dismiss"
              >
                ×
              </button>
            </div>
          ))}
          {notices.length > 1 && (
            <button
              onClick={onClearAll}
              className="text-[11px] text-zinc-500 active:text-zinc-300 mt-1"
            >
              全部清除
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function levelClass(level: 'info' | 'warn' | 'error'): {
  bar: string
  badge: string
  row: string
} {
  switch (level) {
    case 'error':
      return {
        bar: 'bg-red-950/40 border-red-900/40 text-red-200',
        badge: 'text-red-400',
        row: 'bg-red-950/30'
      }
    case 'warn':
      return {
        bar: 'bg-amber-950/40 border-amber-900/40 text-amber-200',
        badge: 'text-amber-400',
        row: 'bg-amber-950/30'
      }
    default:
      return {
        bar: 'bg-zinc-900/80 border-zinc-800 text-zinc-300',
        badge: 'text-zinc-500',
        row: 'bg-zinc-900/60'
      }
  }
}
