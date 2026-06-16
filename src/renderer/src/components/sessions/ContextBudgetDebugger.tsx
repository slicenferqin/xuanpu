import { useCallback, useEffect, useMemo, useState } from 'react'
import { Archive, ChevronDown, ChevronRight, Gauge, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  FieldContextPackageDebugRecord,
  FieldContextPackageSectionDebug,
  FieldEpisodeBlockDebugRecord
} from '@shared/types/field-context-debug'
import type {
  AgentProviderRequestReplay,
  AgentProviderRequestSummary,
  AgentTaskRun
} from '@shared/types/agent-task-run'

interface ContextBudgetDebuggerProps {
  sessionId: string | null | undefined
  runtimeSessionId?: string | null | undefined
  worktreeId: string | null | undefined
  className?: string
}

export function ContextBudgetDebugger({
  sessionId,
  runtimeSessionId,
  worktreeId,
  className
}: ContextBudgetDebuggerProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'packages' | 'episodes' | 'requests'>('packages')
  const [loading, setLoading] = useState(false)
  const [replayLoading, setReplayLoading] = useState(false)
  const [packages, setPackages] = useState<FieldContextPackageDebugRecord[]>([])
  const [episodes, setEpisodes] = useState<FieldEpisodeBlockDebugRecord[]>([])
  const [providerRequests, setProviderRequests] = useState<AgentProviderRequestSummary[]>([])
  const [selectedReplayId, setSelectedReplayId] = useState<string | null>(null)
  const [selectedReplay, setSelectedReplay] = useState<AgentProviderRequestReplay | null>(null)

  const sessionIds = useMemo(
    () =>
      [runtimeSessionId, sessionId].filter(
        (id, index, ids): id is string =>
          typeof id === 'string' && id.length > 0 && ids.indexOf(id) === index
      ),
    [runtimeSessionId, sessionId]
  )

  const refresh = useCallback(async () => {
    if (!worktreeId || sessionIds.length === 0) return
    setLoading(true)
    try {
      const [records, blocks, requests] = await Promise.all([
        loadContextPackages(worktreeId, sessionIds),
        loadEpisodeBlocks(worktreeId, sessionIds),
        loadProviderRequests(sessionId)
      ])
      setPackages(records)
      setEpisodes(blocks)
      setProviderRequests(requests)
    } finally {
      setLoading(false)
    }
  }, [sessionId, sessionIds, worktreeId])

  const loadReplay = useCallback(async (snapshotId: string) => {
    if (!hasXuanpuAgentOps()) return
    setSelectedReplayId(snapshotId)
    setSelectedReplay(null)
    setReplayLoading(true)
    try {
      const replay = await window.xuanpuAgentOps.getProviderRequestReplay(snapshotId)
      setSelectedReplay(replay)
    } finally {
      setReplayLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  if (!worktreeId || sessionIds.length === 0) return null

  const latest = packages[0]
  const latestSummary = latest ? summarizePackage(latest) : null
  const latestEpisode = episodes[0]

  return (
    <div
      className={cn('border-t border-border/40 bg-muted/20 text-xs', className)}
      data-testid="context-budget-debugger"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-muted-foreground transition-colors hover:bg-muted/30"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Gauge size={12} className="text-sky-400" />
          <span className="shrink-0">Context Budget</span>
          <span className="ml-2 min-w-0 truncate text-muted-foreground/70">
            {latestSummary ??
              (latestEpisode
                ? `${episodes.length} frozen episodes • latest ${formatTime(latestEpisode.createdAt)}`
                : 'managed context')}
          </span>
        </div>
        {open && (
          <span
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation()
              void refresh()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                event.stopPropagation()
                void refresh()
              }
            }}
            className={cn(
              'rounded p-1 hover:bg-muted/50',
              loading && 'animate-spin text-muted-foreground/60'
            )}
            title="Refresh"
          >
            <RefreshCw size={12} />
          </span>
        )}
      </button>

      {open && (
        <div className="max-h-[60vh] overflow-auto px-3 pb-3 pt-1">
          <div className="mb-2 flex items-center gap-1 text-[11px]">
            <TabButton
              active={tab === 'packages'}
              onClick={() => setTab('packages')}
              icon={<Gauge size={11} />}
              label="Packages"
            />
            <TabButton
              active={tab === 'episodes'}
              onClick={() => setTab('episodes')}
              icon={<Archive size={11} />}
              label="Episodes"
            />
            <TabButton
              active={tab === 'requests'}
              onClick={() => setTab('requests')}
              icon={<Gauge size={11} />}
              label="Requests"
            />
          </div>

          {tab === 'packages' && <PackageTab loading={loading} packages={packages} />}

          {tab === 'episodes' && <EpisodeTab loading={loading} episodes={episodes} />}

          {tab === 'requests' && (
            <ProviderRequestTab
              loading={loading}
              replayLoading={replayLoading}
              requests={providerRequests}
              selectedReplayId={selectedReplayId}
              selectedReplay={selectedReplay}
              onSelect={loadReplay}
            />
          )}
        </div>
      )}
    </div>
  )
}

function PackageTab({
  loading,
  packages
}: {
  loading: boolean
  packages: FieldContextPackageDebugRecord[]
}): React.JSX.Element {
  return (
    <>
      {loading && packages.length === 0 && (
        <div className="text-muted-foreground/60">Loading...</div>
      )}
      {!loading && packages.length === 0 && (
        <div className="text-muted-foreground/60">No managed context package recorded.</div>
      )}
      {packages.length > 0 && (
        <div className="space-y-3">
          {packages.map((pkg) => (
            <ContextPackageSummary key={pkg.id} pkg={pkg} />
          ))}
        </div>
      )}
    </>
  )
}

function EpisodeTab({
  loading,
  episodes
}: {
  loading: boolean
  episodes: FieldEpisodeBlockDebugRecord[]
}): React.JSX.Element {
  return (
    <>
      {loading && episodes.length === 0 && (
        <div className="text-muted-foreground/60">Loading...</div>
      )}
      {!loading && episodes.length === 0 && (
        <div className="text-muted-foreground/60">No frozen episode blocks recorded.</div>
      )}
      {episodes.length > 0 && (
        <div className="space-y-3">
          {episodes.map((episode) => (
            <EpisodeBlockSummary key={episode.id} episode={episode} />
          ))}
        </div>
      )}
    </>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  label
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded px-2 py-0.5',
        active ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-muted/50'
      )}
    >
      {icon}
      {label}
    </button>
  )
}

async function loadContextPackages(
  worktreeId: string,
  sessionIds: string[]
): Promise<FieldContextPackageDebugRecord[]> {
  for (const sessionId of sessionIds) {
    const records = await window.fieldOps.listContextPackages({
      worktreeId,
      sessionId,
      runtimeId: 'xuanpu-agent',
      includeRenderedMarkdown: false,
      limit: 5
    })
    if (records.length > 0) return records
  }

  return window.fieldOps.listContextPackages({
    worktreeId,
    runtimeId: 'xuanpu-agent',
    includeRenderedMarkdown: false,
    limit: 5
  })
}

async function loadEpisodeBlocks(
  worktreeId: string,
  sessionIds: string[]
): Promise<FieldEpisodeBlockDebugRecord[]> {
  for (const sessionId of sessionIds) {
    const records = await window.fieldOps.listEpisodeBlocks({
      worktreeId,
      sessionId,
      limit: 5
    })
    if (records.length > 0) return records
  }

  return window.fieldOps.listEpisodeBlocks({
    worktreeId,
    limit: 5
  })
}

async function loadProviderRequests(
  sessionId: string | null | undefined
): Promise<AgentProviderRequestSummary[]> {
  if (!sessionId || !hasXuanpuAgentOps()) return []

  const runs = await window.xuanpuAgentOps.listTaskRuns(sessionId)
  const active = findActiveTaskRun(runs)
  if (!active) return []

  return window.xuanpuAgentOps.listProviderRequests(active.id)
}

function hasXuanpuAgentOps(): boolean {
  return typeof window !== 'undefined' && Boolean(window.xuanpuAgentOps)
}

function findActiveTaskRun(runs: AgentTaskRun[]): AgentTaskRun | null {
  return runs.find((run) => run.status === 'running' || run.status === 'paused') ?? runs[0] ?? null
}

function ContextPackageSummary({
  pkg
}: {
  pkg: FieldContextPackageDebugRecord
}): React.JSX.Element {
  const includedSections = pkg.sections.filter((section) => section.included)
  const excludedSections = pkg.sections.length - includedSections.length
  const renderedPolicy = getDecisionString(pkg.decisions, 'renderedMarkdownPolicy')
  const retrievalCount = getDecisionNumber(pkg.decisions, 'retrievedEpisodeCount')
  const frozenCandidateCount = getDecisionNumber(pkg.decisions, 'frozenEpisodeCandidateCount')

  return (
    <div className="space-y-2 rounded border border-border/50 bg-background/50 p-2 text-[11px] leading-relaxed">
      <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground/70">
        <span>
          <strong className="text-foreground">{pkg.budgetProfile}</strong> budget
          <span className="ml-2">~{pkg.approxTokens} tokens</span>
        </span>
        <span>
          {pkg.modelProviderId ?? 'provider?'} / {pkg.modelId ?? 'model?'} •{' '}
          {formatTime(pkg.createdAt)}
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <Metric label="Included" value={String(includedSections.length)} />
        <Metric label="Excluded" value={String(excludedSections)} />
        <Metric label="Retrieved" value={String(retrievalCount ?? 0)} />
        <Metric label="Frozen" value={String(frozenCandidateCount ?? 0)} />
      </div>

      <div className="space-y-1">
        {pkg.sections.map((section) => (
          <ContextSectionRow key={section.id} section={section} />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground/60">
        <span>id: {shortId(pkg.id)}</span>
        <span>runtime: {pkg.runtimeId}</span>
        <span>markdown: {renderedPolicy ?? markdownState(pkg)}</span>
      </div>

      <details>
        <summary className="cursor-pointer text-[10px] text-muted-foreground/70">decisions</summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 text-[10px]">
          {stringifyJson(pkg.decisions)}
        </pre>
      </details>
    </div>
  )
}

function ContextSectionRow({
  section
}: {
  section: FieldContextPackageSectionDebug
}): React.JSX.Element {
  return (
    <div
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
      {(section.source || section.reason) && (
        <div className="text-[10px] text-muted-foreground/70">
          {section.source ? `source: ${section.source}` : null}
          {section.source && section.reason ? ' | ' : null}
          {section.reason ? `reason: ${section.reason}` : null}
        </div>
      )}
    </div>
  )
}

function ProviderRequestTab({
  loading,
  replayLoading,
  requests,
  selectedReplayId,
  selectedReplay,
  onSelect
}: {
  loading: boolean
  replayLoading: boolean
  requests: AgentProviderRequestSummary[]
  selectedReplayId: string | null
  selectedReplay: AgentProviderRequestReplay | null
  onSelect: (snapshotId: string) => void
}): React.JSX.Element {
  const orderedRequests = [...requests].reverse()

  return (
    <>
      {loading && requests.length === 0 && (
        <div className="text-muted-foreground/60">Loading...</div>
      )}
      {!loading && requests.length === 0 && (
        <div className="text-muted-foreground/60">No provider request snapshot recorded.</div>
      )}
      {requests.length > 0 && (
        <div className="space-y-3">
          <div className="space-y-1">
            {orderedRequests.map((request) => (
              <ProviderRequestRow
                key={request.id}
                request={request}
                selected={request.id === selectedReplayId}
                onSelect={onSelect}
              />
            ))}
          </div>

          {selectedReplayId && replayLoading && (
            <div className="text-muted-foreground/60">Loading provider request replay...</div>
          )}

          {selectedReplay && <ProviderRequestReplayDetails replay={selectedReplay} />}

          {selectedReplayId && !replayLoading && !selectedReplay && (
            <div className="text-muted-foreground/60">Provider request snapshot not found.</div>
          )}
        </div>
      )}
    </>
  )
}

function ProviderRequestRow({
  request,
  selected,
  onSelect
}: {
  request: AgentProviderRequestSummary
  selected: boolean
  onSelect: (snapshotId: string) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onSelect(request.id)}
      className={cn(
        'w-full rounded border px-2 py-1 text-left transition-colors',
        selected
          ? 'border-sky-500/40 bg-sky-500/10'
          : 'border-border/50 bg-background/50 hover:bg-muted/30'
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <strong>#{request.providerCallSeq + 1}</strong>{' '}
          <span className="font-mono text-[10px]">{shortId(request.providerRequestHash)}</span>
        </span>
        <span className="text-[10px] text-muted-foreground/70">
          {formatTime(request.createdAt)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground/70">
        <span>segment: {formatOrdinal(request.contextSegmentOrdinal)}</span>
        <span>managed: ~{request.managedApproxTokens} tokens</span>
        <span>provider: ~{request.providerEstimatedInputTokens} tokens</span>
        <span>max: {formatTokens(request.maxContextTokens)}</span>
      </div>
    </button>
  )
}

function ProviderRequestReplayDetails({
  replay
}: {
  replay: AgentProviderRequestReplay
}): React.JSX.Element {
  return (
    <div
      className="space-y-2 rounded border border-border/50 bg-background/50 p-2 text-[11px] leading-relaxed"
      data-testid="provider-request-replay"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground/70">
        <span>
          <strong className="text-foreground">Provider Request Replay</strong>{' '}
          <span className="font-mono text-[10px]">{shortId(replay.providerRequestHash)}</span>
        </span>
        <span>{formatTime(replay.createdAt)}</span>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <Metric label="Managed" value={`~${replay.managedApproxTokens}`} />
        <Metric label="Provider" value={`~${replay.providerEstimatedInputTokens}`} />
        <Metric label="Max" value={formatTokens(replay.maxContextTokens)} />
        <Metric label="Segment" value={formatOrdinal(replay.contextSegmentOrdinal)} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground/60">
        <span>snapshot: {shortId(replay.id)}</span>
        <span>turn: {shortId(replay.turnId)}</span>
        <span>round: {replay.userRoundId ? shortId(replay.userRoundId) : '-'}</span>
        <span>prefix: {replay.prefixHash ? shortId(replay.prefixHash) : '-'}</span>
        <span>xfp: {replay.xfpPacketId ? shortId(replay.xfpPacketId) : '-'}</span>
      </div>

      <JsonBlock title="provider messages" value={replay.providerMessagesJson} />
      <JsonBlock title="provider tools" value={replay.providerToolsJson} />
      <JsonBlock title="provider config" value={replay.providerConfigJson} />
      <JsonBlock title="decisions" value={replay.decisionsJson} />
      <JsonBlock title="managed context" value={replay.managedContextJson} />
    </div>
  )
}

function JsonBlock({ title, value }: { title: string; value: string }): React.JSX.Element {
  return (
    <details open={title === 'provider messages'}>
      <summary className="cursor-pointer text-[10px] text-muted-foreground/70">{title}</summary>
      <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 text-[10px]">
        {prettyJson(value)}
      </pre>
    </details>
  )
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded border border-border/40 bg-muted/20 px-2 py-1">
      <div className="text-[10px] text-muted-foreground/60">{label}</div>
      <div className="font-mono text-sm text-foreground">{value}</div>
    </div>
  )
}

function EpisodeBlockSummary({
  episode
}: {
  episode: FieldEpisodeBlockDebugRecord
}): React.JSX.Element {
  return (
    <div className="space-y-2 rounded border border-border/50 bg-background/50 p-2 text-[11px] leading-relaxed">
      <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground/70">
        <span>
          <strong className="text-foreground">{episode.title ?? 'Untitled Episode'}</strong>{' '}
          {episode.kind} / {episode.confidence}
        </span>
        <span>
          ~{episode.tokenEstimate} tokens • {formatTime(episode.createdAt)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground/60">
        <span>id: {shortId(episode.id)}</span>
        <span>raw refs: {episode.rawRefs.length}</span>
        {episode.sourceMessageIdStart && episode.sourceMessageIdEnd && (
          <span>
            messages: {shortId(episode.sourceMessageIdStart)}..{shortId(episode.sourceMessageIdEnd)}
          </span>
        )}
      </div>

      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 text-[10px]">
        {episode.summaryMarkdown}
      </pre>

      <TagList label="files" values={episode.files} />
      <TagList label="commands" values={episode.commands} />
      <TagList label="constraints" values={episode.constraints} />
      <TagList label="failures" values={episode.failures} />

      <details>
        <summary className="cursor-pointer text-[10px] text-muted-foreground/70">raw refs</summary>
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-2 text-[10px]">
          {stringifyJson(episode.rawRefs)}
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

function summarizePackage(pkg: FieldContextPackageDebugRecord): string {
  const included = pkg.sections.filter((section) => section.included).length
  return `${pkg.budgetProfile} • ~${pkg.approxTokens} tokens • ${included}/${pkg.sections.length} sections`
}

function getDecisionString(decisions: Record<string, unknown>, key: string): string | null {
  const value = decisions[key]
  return typeof value === 'string' ? value : null
}

function getDecisionNumber(decisions: Record<string, unknown>, key: string): number | null {
  const value = decisions[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function markdownState(pkg: FieldContextPackageDebugRecord): string {
  if (pkg.renderedMarkdownStored) return 'stored'
  return 'not stored'
}

function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8)
}

function formatTime(value: number | string): string {
  return new Date(value).toLocaleTimeString()
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

function formatOrdinal(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return String(value + 1)
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}
