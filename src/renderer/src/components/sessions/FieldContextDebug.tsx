import { useEffect, useState, useCallback } from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { XfpAuditEvent } from '@shared/types/xfp-audit'

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

interface CheckpointEntry {
  verified: {
    createdAt: number
    ageMinutes: number
    source: 'abort' | 'shutdown'
    summary: string
    currentGoal: string | null
    nextAction: string | null
    blockingReason: string | null
    hotFiles: string[]
    warnings: string[]
  } | null
  raw: {
    id: string
    createdAt: number
    worktreeId: string
    sessionId: string
    branch: string | null
    repoHead: string | null
    source: 'abort' | 'shutdown'
    summary: string
    currentGoal: string | null
    nextAction: string | null
    blockingReason: string | null
    hotFiles: string[]
    hotFileDigests: Record<string, string | null> | null
    packetHash: string
  } | null
}

interface FieldContextDebugProps {
  sessionId: string | null | undefined
  /** Optional extra ids to try (e.g. the Hive session id vs the runtime session id). */
  fallbackSessionIds?: Array<string | null | undefined>
  /** Worktree id for the Episodic Memory tab (Phase 22B.1). */
  worktreeId?: string | null
  defaultOpen?: boolean
  embedded?: boolean
  className?: string
}

type Tab = 'injection' | 'episodic' | 'semantic' | 'checkpoint'
type InspectorTab = 'xfp' | Tab

/**
 * XFP Inspector + legacy Field Context debug UI.
 *
 * XFP is now the primary field access path. The old injection view remains
 * available as a fallback tab so debugging no longer centers on hidden prompt
 * prefixes.
 */
export function FieldContextDebug({
  sessionId,
  fallbackSessionIds = [],
  worktreeId,
  defaultOpen = false,
  embedded = false,
  className
}: FieldContextDebugProps): React.JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen)
  const [tab, setTab] = useState<InspectorTab>('xfp')
  const [xfpAudit, setXfpAudit] = useState<XfpAuditEvent[]>([])
  const [data, setData] = useState<LastInjection | null>(null)
  const [episodic, setEpisodic] = useState<EpisodicMemoryEntry | null>(null)
  const [semantic, setSemantic] = useState<SemanticMemoryEntry | null>(null)
  const [checkpoint, setCheckpoint] = useState<CheckpointEntry | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!sessionId && fallbackSessionIds.every((s) => !s) && !worktreeId) return
    setLoading(true)
    try {
      const candidates = [sessionId, ...fallbackSessionIds].filter(
        (s): s is string => typeof s === 'string' && s.length > 0
      )
      const audit =
        worktreeId || candidates.length > 0 ? await loadXfpAudit(worktreeId, candidates) : []
      setXfpAudit(audit)

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
        const [ep, sem, ck] = await Promise.all([
          window.fieldOps.getEpisodicMemory(worktreeId),
          window.fieldOps.getSemanticMemory(worktreeId),
          window.fieldOps.getCheckpoint(worktreeId)
        ])
        setEpisodic(ep)
        setSemantic(sem)
        setCheckpoint(ck)
      } else {
        setEpisodic(null)
        setSemantic(null)
        setCheckpoint(null)
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
    tab === 'xfp'
      ? xfpAudit.length > 0
        ? `${xfpAudit.length} recent events`
        : 'no XFP activity yet'
      : tab === 'injection'
        ? data
          ? `~${data.approxTokens} tokens • ${new Date(data.timestamp).toLocaleTimeString()}`
          : 'no injection yet'
        : episodic
          ? `${episodic.compactorId} • ${new Date(episodic.compactedAt).toLocaleTimeString()}`
          : 'no episodic summary yet'

  return (
    <div
      className={cn(
        embedded ? 'text-xs font-mono' : 'border-t border-border/40 bg-muted/20 text-xs font-mono',
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
          <span>XFP Inspector</span>
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
              onClick={() => setTab('xfp')}
              className={cn(
                'px-2 py-0.5 rounded',
                tab === 'xfp'
                  ? 'bg-primary/20 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50'
              )}
            >
              XFP Calls
            </button>
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
              Legacy Injection
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
            <button
              type="button"
              onClick={() => setTab('checkpoint')}
              className={cn(
                'px-2 py-0.5 rounded',
                tab === 'checkpoint'
                  ? 'bg-primary/20 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50'
              )}
            >
              Session Checkpoint
            </button>
          </div>

          {tab === 'xfp' && (
            <XfpAuditBlock
              events={xfpAudit}
              loading={loading}
              worktreeScoped={Boolean(worktreeId)}
            />
          )}

          {tab === 'injection' && (
            <>
              {loading && !data && <div className="text-muted-foreground/60">Loading…</div>}
              {!loading && !data && (
                <div className="text-muted-foreground/60">
                  No injection recorded yet for this session. Field Context is injected on the next
                  prompt when field event collection is enabled.
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
                  No episodic summary yet. Summaries are compacted from the event stream every 30
                  minutes (or after ~20 events) when collection is enabled.
                </div>
              )}
              {episodic && (
                <>
                  <div className="text-muted-foreground/70 mb-1">
                    {episodic.compactorId} v{episodic.version} • {episodic.sourceEventCount} events
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
              {loading && !semantic && <div className="text-muted-foreground/60">Loading…</div>}
              {!loading && !semantic && (
                <div className="text-muted-foreground/60">
                  Memory injection is disabled. Enable it in Settings → Privacy to include your
                  memory.md files in agent prompts.
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

          {tab === 'checkpoint' && (
            <>
              {loading && !checkpoint && <div className="text-muted-foreground/60">Loading…</div>}
              {!loading && !checkpoint?.raw && (
                <div className="text-muted-foreground/60">
                  No checkpoint for this worktree yet. Checkpoints are generated on session abort
                  and app shutdown when field collection is enabled.
                </div>
              )}
              {checkpoint?.raw && <CheckpointBlock data={checkpoint} />}
            </>
          )}
        </div>
      )}
    </div>
  )
}

async function loadXfpAudit(
  worktreeId: string | null | undefined,
  sessionIds: string[]
): Promise<XfpAuditEvent[]> {
  if (worktreeId) {
    return window.fieldOps.getXfpAuditEvents({ worktreeId, limit: 30 })
  }

  const results = await Promise.all(
    sessionIds.map((sessionId) => window.fieldOps.getXfpAuditEvents({ sessionId, limit: 30 }))
  )
  const seen = new Set<string>()
  return results
    .flat()
    .filter((event) => {
      if (seen.has(event.id)) return false
      seen.add(event.id)
      return true
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30)
}

function XfpAuditBlock({
  events,
  loading,
  worktreeScoped
}: {
  events: XfpAuditEvent[]
  loading: boolean
  worktreeScoped: boolean
}): React.JSX.Element {
  if (loading && events.length === 0) {
    return <div className="text-muted-foreground/60">Loading…</div>
  }

  if (events.length === 0) {
    return (
      <div className="text-muted-foreground/60">
        No XFP calls recorded yet. Claude Code tool calls and Claude/Codex bounded fallback prefixes
        will appear here after the next field-sensitive turn.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] text-muted-foreground/60">
        Showing latest {events.length} {worktreeScoped ? 'worktree' : 'session'} XFP audit events.
        Results are summarized; full tool outputs are not stored in this inspector.
      </div>
      <div className="space-y-1.5 max-h-72 overflow-auto pr-1">
        {events.map((event) => (
          <div key={event.id} className="rounded-md border border-border/50 bg-background/60 p-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                      event.kind === 'tool'
                        ? 'bg-blue-500/10 text-blue-700 dark:text-blue-300'
                        : event.kind === 'prompt'
                          ? 'bg-slate-500/10 text-slate-700 dark:text-slate-300'
                          : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                    )}
                  >
                    {event.kind}
                  </span>
                  <span className="truncate font-semibold text-foreground">{event.toolName}</span>
                  <span className="text-muted-foreground/60">{event.runtimeId}</span>
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground/60">
                  {new Date(event.createdAt).toLocaleTimeString()} • {event.outputChars} chars
                  {event.truncated ? ' • truncated' : ''}
                  {event.privacy !== 'allowed' ? ` • privacy: ${event.privacy}` : ''}
                </div>
              </div>
            </div>
            {Object.keys(event.input).length > 0 && (
              <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
                input: {JSON.stringify(event.input)}
              </pre>
            )}
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 px-2 py-1 text-[11px] leading-relaxed text-muted-foreground">
              {event.outputSummary}
            </pre>
          </div>
        ))}
      </div>
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

function CheckpointBlock({ data }: { data: CheckpointEntry }): React.JSX.Element {
  const { verified, raw } = data
  const isStale = raw !== null && verified === null
  return (
    <div className="space-y-3">
      {/* Status banner */}
      <div
        className={cn(
          'rounded px-2 py-1 text-[11px]',
          isStale
            ? 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border border-yellow-500/30'
            : 'bg-green-500/10 text-green-700 dark:text-green-400 border border-green-500/30'
        )}
      >
        {isStale
          ? '⚠ Stale — not injected (branch changed / files drifted / expired)'
          : '✓ Active — injected into Field Context'}
      </div>

      {/* Verifier-evaluated block (what the agent sees) */}
      {verified && (
        <div>
          <div className="text-muted-foreground/70 mb-1 font-semibold">As seen by agent</div>
          <div className="bg-background/50 rounded p-2 space-y-1 text-[11px] leading-relaxed">
            <div>
              <span className="text-muted-foreground/70">age:</span> {verified.ageMinutes}m
              <span className="text-muted-foreground/70 ml-3">source:</span> {verified.source}
            </div>
            <div className="whitespace-pre-wrap break-words">{verified.summary}</div>
            {verified.currentGoal && (
              <div>
                <span className="text-muted-foreground/70">goal (heuristic):</span>{' '}
                {verified.currentGoal}
              </div>
            )}
            {verified.nextAction && (
              <div>
                <span className="text-muted-foreground/70">next (heuristic):</span>{' '}
                {verified.nextAction}
              </div>
            )}
            {verified.hotFiles.length > 0 && (
              <div>
                <span className="text-muted-foreground/70">hot files:</span>{' '}
                <code className="text-[10px]">{verified.hotFiles.join(', ')}</code>
              </div>
            )}
            {verified.warnings.length > 0 && (
              <ul className="list-none">
                {verified.warnings.map((w, i) => (
                  <li key={i} className="text-yellow-700 dark:text-yellow-400">
                    ⚠ {w}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Raw record details */}
      {raw && (
        <div>
          <div className="text-muted-foreground/70 mb-1 font-semibold">Raw row</div>
          <div className="bg-background/50 rounded p-2 text-[10px] leading-relaxed font-mono space-y-0.5">
            <div>
              <span className="text-muted-foreground/70">id:</span> {raw.id.slice(0, 8)}
              <span className="text-muted-foreground/70 ml-3">session:</span>{' '}
              {raw.sessionId.slice(0, 8)}
            </div>
            <div>
              <span className="text-muted-foreground/70">branch:</span>{' '}
              {raw.branch ?? <em className="text-muted-foreground/50">null</em>}
              <span className="text-muted-foreground/70 ml-3">HEAD:</span>{' '}
              {raw.repoHead ? (
                raw.repoHead.slice(0, 8)
              ) : (
                <em className="text-muted-foreground/50">null</em>
              )}
            </div>
            <div>
              <span className="text-muted-foreground/70">created:</span>{' '}
              {new Date(raw.createdAt).toLocaleString()}
            </div>
            <div>
              <span className="text-muted-foreground/70">hash:</span> {raw.packetHash.slice(0, 12)}
            </div>
            {raw.hotFileDigests && (
              <details>
                <summary className="cursor-pointer text-muted-foreground/70">
                  digests ({Object.keys(raw.hotFileDigests).length})
                </summary>
                <div className="pl-2 pt-1">
                  {Object.entries(raw.hotFileDigests).map(([p, sha]) => (
                    <div key={p}>
                      {p}:{' '}
                      {sha ? (
                        <code>{sha.slice(0, 10)}</code>
                      ) : (
                        <em className="text-muted-foreground/50">null</em>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
