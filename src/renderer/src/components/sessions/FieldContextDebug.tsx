import { useEffect, useState, useCallback } from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

interface LastInjection {
  preview: string
  timestamp: number
  approxTokens: number
}

interface EpisodicMemoryEntry {
  worktreeId: string
  summaryMarkdown: string
  compactorId: string
  version: number
  compactedAt: number
  sourceEventCount: number
  sourceSince: number
  sourceUntil: number
}

interface SemanticMemoryFile {
  path: string
  mtimeMs: number
  size: number
  markdown: string | null
}

interface SemanticMemoryEntry {
  project: SemanticMemoryFile
  user: SemanticMemoryFile
  lastReadAt: number
}

interface FieldContextDebugProps {
  sessionId: string | null | undefined
  /** Optional extra ids to try (e.g. the Hive session id vs the runtime session id). */
  fallbackSessionIds?: Array<string | null | undefined>
  /** Worktree id for the Episodic Memory tab (Phase 22B.1). */
  worktreeId?: string | null
  className?: string
}

type Tab = 'injection' | 'episodic' | 'semantic'

/**
 * Phase 22A/22B debug UI: lets the user inspect what Field Context was injected
 * into the last agent prompt, and what the worktree's episodic memory summary
 * currently contains. Intentionally minimal — Phase 22+ will replace
 * this with a first-class UI.
 */
export function FieldContextDebug({
  sessionId,
  fallbackSessionIds = [],
  worktreeId,
  className
}: FieldContextDebugProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('injection')
  const [data, setData] = useState<LastInjection | null>(null)
  const [episodic, setEpisodic] = useState<EpisodicMemoryEntry | null>(null)
  const [semantic, setSemantic] = useState<SemanticMemoryEntry | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!sessionId && fallbackSessionIds.every((s) => !s) && !worktreeId) return
    setLoading(true)
    try {
      const candidates = [sessionId, ...fallbackSessionIds].filter(
        (s): s is string => typeof s === 'string' && s.length > 0
      )
      let injection: LastInjection | null = null
      for (const id of candidates) {
        const result = await window.fieldOps.getLastInjection(id)
        if (result) {
          injection = result
          break
        }
      }
      setData(injection)
      if (worktreeId) {
        const [ep, sem] = await Promise.all([
          window.fieldOps.getEpisodicMemory(worktreeId),
          window.fieldOps.getSemanticMemory(worktreeId)
        ])
        setEpisodic(ep)
        setSemantic(sem)
      } else {
        setEpisodic(null)
        setSemantic(null)
      }
    } finally {
      setLoading(false)
    }
  }, [sessionId, fallbackSessionIds, worktreeId])

  // Re-fetch when the panel opens, or when sessionId/worktreeId changes while open
  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  if (!sessionId && fallbackSessionIds.every((s) => !s) && !worktreeId) return null

  const headerLabel =
    tab === 'injection'
      ? data
        ? `~${data.approxTokens} tokens • ${new Date(data.timestamp).toLocaleTimeString()}`
        : 'no injection yet'
      : episodic
        ? `${episodic.compactorId} • ${new Date(episodic.compactedAt).toLocaleTimeString()}`
        : 'no episodic summary yet'

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
          <span>Field Context</span>
          <span className="text-muted-foreground/70 ml-2">{headerLabel}</span>
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
          {/* Tab bar */}
          <div className="flex items-center gap-1 mb-2 text-[11px]">
            <button
              type="button"
              onClick={() => setTab('injection')}
              className={cn(
                'px-2 py-0.5 rounded',
                tab === 'injection'
                  ? 'bg-primary/20 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50'
              )}
            >
              Last Injection
            </button>
            <button
              type="button"
              onClick={() => setTab('episodic')}
              className={cn(
                'px-2 py-0.5 rounded',
                tab === 'episodic'
                  ? 'bg-primary/20 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50'
              )}
            >
              Episodic Memory
            </button>
            <button
              type="button"
              onClick={() => setTab('semantic')}
              className={cn(
                'px-2 py-0.5 rounded',
                tab === 'semantic'
                  ? 'bg-primary/20 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50'
              )}
            >
              Semantic Memory
            </button>
          </div>

          {tab === 'injection' && (
            <>
              {loading && !data && <div className="text-muted-foreground/60">Loading…</div>}
              {!loading && !data && (
                <div className="text-muted-foreground/60">
                  No injection recorded yet for this session. Field Context is injected on
                  the next prompt when field event collection is enabled.
                </div>
              )}
              {data && (
                <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed bg-background/50 rounded p-2 max-h-64 overflow-auto">
                  {data.preview}
                </pre>
              )}
            </>
          )}

          {tab === 'episodic' && (
            <>
              {loading && !episodic && <div className="text-muted-foreground/60">Loading…</div>}
              {!loading && !episodic && (
                <div className="text-muted-foreground/60">
                  No episodic summary yet. Summaries are compacted from the event stream
                  every 30 minutes (or after ~20 events) when collection is enabled.
                </div>
              )}
              {episodic && (
                <>
                  <div className="text-muted-foreground/70 mb-1">
                    {episodic.compactorId} v{episodic.version} • {episodic.sourceEventCount}{' '}
                    events
                  </div>
                  <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed bg-background/50 rounded p-2 max-h-64 overflow-auto">
                    {episodic.summaryMarkdown}
                  </pre>
                </>
              )}
            </>
          )}

          {tab === 'semantic' && (
            <>
              {loading && !semantic && (
                <div className="text-muted-foreground/60">Loading…</div>
              )}
              {!loading && !semantic && (
                <div className="text-muted-foreground/60">
                  Memory injection is disabled. Enable it in Settings → Privacy to include
                  your memory.md files in agent prompts.
                </div>
              )}
              {semantic && (
                <div className="space-y-3">
                  <SemanticFileBlock label="Project Rules" file={semantic.project} />
                  <SemanticFileBlock label="User Preferences" file={semantic.user} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function SemanticFileBlock({
  label,
  file
}: {
  label: string
  file: SemanticMemoryFile
}): React.JSX.Element {
  return (
    <div>
      <div className="text-muted-foreground/70 mb-1 flex items-center justify-between">
        <span>
          <strong className="text-foreground">{label}</strong>{' '}
          <code className="text-[10px]">{file.path}</code>
        </span>
        {file.markdown === null && (
          <span className="text-muted-foreground/50">(file not found)</span>
        )}
      </div>
      {file.markdown !== null && (
        <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed bg-background/50 rounded p-2 max-h-48 overflow-auto">
          {file.markdown}
        </pre>
      )}
    </div>
  )
}
