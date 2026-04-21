import { useEffect, useState, useCallback } from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

interface LastInjection {
  preview: string
  timestamp: number
  approxTokens: number
}

interface FieldContextDebugProps {
  sessionId: string | null | undefined
  /** Optional extra ids to try (e.g. the Hive session id vs the runtime session id). */
  fallbackSessionIds?: Array<string | null | undefined>
  className?: string
}

/**
 * Phase 22A debug UI: lets the user inspect what Field Context was injected
 * into the last agent prompt. Intentionally minimal — Phase 22B will replace
 * this with a first-class UI.
 */
export function FieldContextDebug({
  sessionId,
  fallbackSessionIds = [],
  className
}: FieldContextDebugProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<LastInjection | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!sessionId && fallbackSessionIds.every((s) => !s)) return
    setLoading(true)
    try {
      const candidates = [sessionId, ...fallbackSessionIds].filter(
        (s): s is string => typeof s === 'string' && s.length > 0
      )
      for (const id of candidates) {
        const result = await window.fieldOps.getLastInjection(id)
        if (result) {
          setData(result)
          return
        }
      }
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [sessionId, fallbackSessionIds])

  // Re-fetch when the panel opens, or when sessionId changes while open
  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  if (!sessionId && fallbackSessionIds.every((s) => !s)) return null

  return (
    <div
      className={cn(
        'border-t border-border/40 bg-muted/20 text-xs font-mono',
        className
      )}
      data-testid="field-context-debug"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-muted-foreground hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-1.5">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>Field Context (last injection)</span>
          {data && (
            <span className="text-muted-foreground/70 ml-2">
              ~{data.approxTokens} tokens • {new Date(data.timestamp).toLocaleTimeString()}
            </span>
          )}
        </div>
        {open && (
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation()
              void refresh()
            }}
            className={cn(
              'p-1 rounded hover:bg-muted/50',
              loading && 'animate-spin text-muted-foreground/60'
            )}
            title="Refresh"
          >
            <RefreshCw size={12} />
          </span>
        )}
      </button>

      {open && (
        <div className="px-3 pb-2 pt-1">
          {loading && !data && (
            <div className="text-muted-foreground/60">Loading…</div>
          )}
          {!loading && !data && (
            <div className="text-muted-foreground/60">
              No injection recorded yet for this session. Field Context is injected on the
              next prompt when field event collection is enabled.
            </div>
          )}
          {data && (
            <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed bg-background/50 rounded p-2 max-h-64 overflow-auto">
              {data.preview}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
