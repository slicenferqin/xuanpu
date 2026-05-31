import { useEffect, useMemo, useState, useCallback } from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { XfpAuditEvent } from '@shared/types/xfp-audit'
import type {
  FieldContextPackageDebugRecord,
  FieldEpisodeBlockDebugRecord
} from '@shared/types/field-context-debug'

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

type Tab = 'injection' | 'managed' | 'episodes' | 'episodic' | 'semantic' | 'checkpoint'
type InspectorTab = 'xfp' | Tab

const EMPTY_FALLBACK_SESSION_IDS: Array<string | null | undefined> = []

/**
 * XFP Inspector + legacy Field Context debug UI.
 *
 * XFP is now the primary field access path. The old injection view remains
 * available as a fallback tab so debugging no longer centers on hidden prompt
 * prefixes.
 */
export function FieldContextDebug({
  sessionId,
  fallbackSessionIds = EMPTY_FALLBACK_SESSION_IDS,
  worktreeId,
  defaultOpen = false,
  embedded = false,
  className
}: FieldContextDebugProps): React.JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen)
  const [tab, setTab] = useState<InspectorTab>('xfp')
  const [xfpAudit, setXfpAudit] = useState<XfpAuditEvent[]>([])
  const [data, setData] = useState<LastInjection | null>(null)
  const [contextPackages, setContextPackages] = useState<FieldContextPackageDebugRecord[]>([])
  const [episodeBlocks, setEpisodeBlocks] = useState<FieldEpisodeBlockDebugRecord[]>([])
  const [episodic, setEpisodic] = useState<EpisodicMemoryEntry | null>(null)
  const [semantic, setSemantic] = useState<SemanticMemoryEntry | null>(null)
  const [checkpoint, setCheckpoint] = useState<CheckpointEntry | null>(null)
  const [loading, setLoading] = useState(false)

  const fallbackSessionIdsKey = fallbackSessionIds
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\u0000')
  const stableFallbackSessionIds = useMemo(
    () => (fallbackSessionIdsKey.length > 0 ? fallbackSessionIdsKey.split('\u0000') : []),
    [fallbackSessionIdsKey]
  )
  const sessionIdCandidates = useMemo(() => {
    const seen = new Set<string>()
    return [sessionId, ...stableFallbackSessionIds].filter((s): s is string => {
      if (typeof s !== 'string' || s.length === 0 || seen.has(s)) return false
      seen.add(s)
      return true
    })
  }, [sessionId, stableFallbackSessionIds])
  const hasInspectableContext = sessionIdCandidates.length > 0 || Boolean(worktreeId)

  const refresh = useCallback(async () => {
    if (!hasInspectableContext) return
    setLoading(true)
    try {
      const audit =
        worktreeId || sessionIdCandidates.length > 0
          ? await loadXfpAudit(worktreeId, sessionIdCandidates)
          : []
      setXfpAudit(audit)

      let injection: LastInjection | null = null
      for (const id of sessionIdCandidates) {
        const result = await window.fieldOps.getLastInjection(id)
        if (result) {
          injection = result
          break
        }
      }
      setData(injection)
      if (worktreeId) {
        const [ep, sem, ck, packages, blocks] = await Promise.all([
          window.fieldOps.getEpisodicMemory(worktreeId),
          window.fieldOps.getSemanticMemory(worktreeId),
          window.fieldOps.getCheckpoint(worktreeId),
          loadManagedContextPackages(worktreeId, sessionIdCandidates),
          loadEpisodeBlocks(worktreeId, sessionIdCandidates)
        ])
        setEpisodic(ep)
        setSemantic(sem)
        setCheckpoint(ck)
        setContextPackages(packages)
        setEpisodeBlocks(blocks)
      } else {
        setEpisodic(null)
        setSemantic(null)
        setCheckpoint(null)
        setContextPackages([])
        setEpisodeBlocks([])
      }
    } finally {
      setLoading(false)
    }
  }, [hasInspectableContext, sessionIdCandidates, worktreeId])

  // Re-fetch when the panel opens, or when sessionId/worktreeId changes while open
  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  if (!hasInspectableContext) return null

  const headerLabel =
    tab === 'xfp'
      ? xfpAudit.length > 0
        ? `${xfpAudit.length} recent events`
        : 'no XFP activity yet'
      : getHeaderLabel(tab, {
          data,
          episodic,
          contextPackages,
          episodeBlocks
        })

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
        <div className="flex min-w-0 items-center gap-1.5">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>XFP Inspector</span>
          <span className="text-muted-foreground/70 ml-2 min-w-0 truncate">{headerLabel}</span>
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
          <div className="flex flex-wrap items-center gap-1 mb-2 text-[11px]">
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
              onClick={() => setTab('managed')}
              className={cn(
                'px-2 py-0.5 rounded',
                tab === 'managed'
                  ? 'bg-primary/20 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50'
              )}
            >
              Managed Context
            </button>
            <button
              type="button"
              onClick={() => setTab('episodes')}
              className={cn(
                'px-2 py-0.5 rounded',
                tab === 'episodes'
                  ? 'bg-primary/20 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50'
              )}
            >
              Episode Blocks
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

          {tab === 'managed' && (
            <>
              {loading && contextPackages.length === 0 && (
                <div className="text-muted-foreground/60">Loading…</div>
              )}
              {!loading && contextPackages.length === 0 && (
                <div className="text-muted-foreground/60">
                  No managed context package has been recorded for this session yet. `xuanpu-agent`
                  records one before each provider call.
                </div>
              )}
              {contextPackages.length > 0 && (
                <div className="space-y-3">
                  {contextPackages.map((pkg) => (
                    <ManagedContextPackageBlock key={pkg.id} pkg={pkg} />
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'episodes' && (
            <>
              {loading && episodeBlocks.length === 0 && (
                <div className="text-muted-foreground/60">Loading…</div>
              )}
              {!loading && episodeBlocks.length === 0 && (
                <div className="text-muted-foreground/60">
                  No managed episode blocks have been frozen for this worktree yet. `xuanpu-agent`
                  freezes older turns after enough raw messages accumulate.
                </div>
              )}
              {episodeBlocks.length > 0 && (
                <div className="space-y-3">
                  {episodeBlocks.map((block) => (
                    <EpisodeBlock key={block.id} block={block} />
                  ))}
                </div>
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

async function loadManagedContextPackages(
  worktreeId: string,
  sessionIds: string[]
): Promise<FieldContextPackageDebugRecord[]> {
  for (const sessionId of sessionIds) {
    const packages = await window.fieldOps.listContextPackages({
      worktreeId,
      sessionId,
      runtimeId: 'xuanpu-agent',
      includeRenderedMarkdown: true,
      limit: 5
    })
    if (packages.length > 0) return packages
  }

  return await window.fieldOps.listContextPackages({
    worktreeId,
    runtimeId: 'xuanpu-agent',
    includeRenderedMarkdown: true,
    limit: 5
  })
}

async function loadEpisodeBlocks(
  worktreeId: string,
  sessionIds: string[]
): Promise<FieldEpisodeBlockDebugRecord[]> {
  for (const sessionId of sessionIds) {
    const blocks = await window.fieldOps.listEpisodeBlocks({
      worktreeId,
      sessionId,
      limit: 5
    })
    if (blocks.length > 0) return blocks
  }

  return await window.fieldOps.listEpisodeBlocks({
    worktreeId,
    limit: 5
  })
}

function getHeaderLabel(
  tab: Tab,
  state: {
    data: LastInjection | null
    episodic: EpisodicMemoryEntry | null
    contextPackages: FieldContextPackageDebugRecord[]
    episodeBlocks: FieldEpisodeBlockDebugRecord[]
  }
): string {
  if (tab === 'injection') {
    return state.data
      ? `~${state.data.approxTokens} tokens • ${new Date(state.data.timestamp).toLocaleTimeString()}`
      : 'no injection yet'
  }
  if (tab === 'managed') {
    const latest = state.contextPackages[0]
    return latest
      ? `${latest.budgetProfile} • ~${latest.approxTokens} tokens • ${formatTime(latest.createdAt)}`
      : 'no managed package yet'
  }
  if (tab === 'episodes') {
    const latest = state.episodeBlocks[0]
    return latest
      ? `${state.episodeBlocks.length} blocks • latest ${formatTime(latest.createdAt)}`
      : 'no episode blocks yet'
  }
  return state.episodic
    ? `${state.episodic.compactorId} • ${formatTime(state.episodic.compactedAt)}`
    : 'no episodic summary yet'
}

function ManagedContextPackageBlock({
  pkg
}: {
  pkg: FieldContextPackageDebugRecord
}): React.JSX.Element {
  const includedCount = pkg.sections.filter((section) => section.included).length
  return (
    <div className="bg-background/50 rounded p-2 text-[11px] leading-relaxed space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground/70">
        <span>
          <strong className="text-foreground">{pkg.runtimeId}</strong>{' '}
          {pkg.modelProviderId ?? 'provider?'} / {pkg.modelId ?? 'model?'}
        </span>
        <span>
          {pkg.budgetProfile} • ~{pkg.approxTokens} tokens • {formatTime(pkg.createdAt)}
        </span>
      </div>
      <div className="text-[10px] text-muted-foreground/60">
        id: {shortId(pkg.id)} • session: {shortId(pkg.sessionId)} • sections: {includedCount}/
        {pkg.sections.length} included
      </div>
      <div className="space-y-1">
        {pkg.sections.map((section) => (
          <div
            key={section.id}
            className={cn(
              'rounded border px-2 py-1',
              section.included
                ? 'border-green-500/30 bg-green-500/5'
                : 'border-border/50 bg-muted/20 text-muted-foreground'
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <strong>{section.title}</strong>{' '}
                <span className="text-muted-foreground/70">({section.kind})</span>
              </span>
              <span className="text-muted-foreground/70">~{section.approxTokens} tokens</span>
            </div>
            {(section.reason || section.source) && (
              <div className="text-[10px] text-muted-foreground/70">
                {section.source ? `source: ${section.source}` : null}
                {section.source && section.reason ? ' • ' : null}
                {section.reason ? `reason: ${section.reason}` : null}
              </div>
            )}
          </div>
        ))}
      </div>
      <details>
        <summary className="cursor-pointer text-muted-foreground/70">decisions</summary>
        <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-muted/30 p-2 text-[10px]">
          {stringifyJson(pkg.decisions)}
        </pre>
      </details>
      <details>
        <summary className="cursor-pointer text-muted-foreground/70">rendered markdown</summary>
        {pkg.renderedMarkdown ? (
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 text-[10px]">
            {pkg.renderedMarkdown}
          </pre>
        ) : (
          <div className="mt-1 text-muted-foreground/60">
            {pkg.renderedMarkdownStored
              ? 'Rendered markdown is stored but was not returned by this read.'
              : 'Rendered markdown was not stored for this package.'}
          </div>
        )}
      </details>
    </div>
  )
}

function EpisodeBlock({ block }: { block: FieldEpisodeBlockDebugRecord }): React.JSX.Element {
  return (
    <div className="bg-background/50 rounded p-2 text-[11px] leading-relaxed space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground/70">
        <span>
          <strong className="text-foreground">{block.title ?? 'Untitled Episode'}</strong>{' '}
          {block.kind} / {block.confidence}
        </span>
        <span>
          ~{block.tokenEstimate} tokens • {formatTime(block.createdAt)}
        </span>
      </div>
      <div className="text-[10px] text-muted-foreground/60">
        id: {shortId(block.id)} • raw refs: {block.rawRefs.length}
        {block.sourceMessageIdStart && block.sourceMessageIdEnd
          ? ` • messages ${shortId(block.sourceMessageIdStart)}..${shortId(block.sourceMessageIdEnd)}`
          : null}
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 text-[10px]">
        {block.summaryMarkdown}
      </pre>
      <TagList label="files" values={block.files} />
      <TagList label="commands" values={block.commands} />
      <TagList label="constraints" values={block.constraints} />
      <TagList label="failures" values={block.failures} />
      <details>
        <summary className="cursor-pointer text-muted-foreground/70">raw refs</summary>
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 text-[10px]">
          {stringifyJson(block.rawRefs)}
        </pre>
      </details>
    </div>
  )
}

function TagList({ label, values }: { label: string; values: string[] }): React.JSX.Element | null {
  if (values.length === 0) return null
  return (
    <div className="text-[10px]">
      <span className="text-muted-foreground/70">{label}:</span>{' '}
      <span className="break-words">{values.join(', ')}</span>
    </div>
  )
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8)
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString()
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
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
