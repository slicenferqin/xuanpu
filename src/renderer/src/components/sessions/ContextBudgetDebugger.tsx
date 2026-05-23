import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Gauge, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  FieldContextPackageDebugRecord,
  FieldContextPackageSectionDebug
} from '@shared/types/field-context-debug'

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
  const [loading, setLoading] = useState(false)
  const [packages, setPackages] = useState<FieldContextPackageDebugRecord[]>([])

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
      const records = await loadContextPackages(worktreeId, sessionIds)
      setPackages(records)
    } finally {
      setLoading(false)
    }
  }, [sessionIds, worktreeId])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  if (!worktreeId || sessionIds.length === 0) return null

  const latest = packages[0]
  const latestSummary = latest ? summarizePackage(latest) : null

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
            {latestSummary ?? 'managed context'}
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
        </div>
      )}
    </div>
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

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded border border-border/40 bg-muted/20 px-2 py-1">
      <div className="text-[10px] text-muted-foreground/60">{label}</div>
      <div className="font-mono text-sm text-foreground">{value}</div>
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
