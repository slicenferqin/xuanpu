/**
 * SessionHeader — thin-border capsule layout
 *
 * Left:  provider+lifecycle │ model selector
 * Right: context capsule │ cost capsule
 */

import { DollarSign, Clock3, Layers3, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ModelSelector } from '../sessions/ModelSelector'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger
} from '@/components/ui/popover'
import { useShallow } from 'zustand/react/shallow'
import { useContextStore } from '@/stores/useContextStore'
import type { SessionLifecycle } from '@/stores/useSessionRuntimeStore'
import type { UsageAnalyticsSessionSummary } from '@shared/types/usage-analytics'
import { formatModelLabelSummary, getSessionSummaryModelLabels } from '@/lib/model-labels'

const PROVIDER_LABELS: Record<string, string> = {
  'claude-code': 'Claude',
  opencode: 'OpenCode',
  codex: 'Codex',
  terminal: 'Terminal'
}

const LIFECYCLE_META: Record<SessionLifecycle, { label: string; dotClass: string }> = {
  idle: { label: 'Idle', dotClass: 'bg-muted-foreground/50' },
  busy: { label: 'Working', dotClass: 'bg-celadon animate-pulse' },
  retry: { label: 'Retrying', dotClass: 'bg-yellow-500 animate-pulse' },
  error: { label: 'Error', dotClass: 'bg-red-500' },
  materializing: { label: 'Starting', dotClass: 'bg-blue-500 animate-pulse' }
}

function formatNumber(n: number): string {
  return n.toLocaleString()
}

function formatTokensShort(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString()
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(4)}`
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

function getBarColor(percent: number): string {
  if (percent >= 90) return '#d9485f'
  if (percent >= 80) return '#d17a22'
  if (percent >= 60) return '#b28a17'
  return '#237a68'
}

function ProviderCapsule({
  sdk,
  lifecycle
}: {
  sdk: string
  lifecycle: SessionLifecycle
}): React.JSX.Element {
  const label = PROVIDER_LABELS[sdk] ?? sdk
  const meta = LIFECYCLE_META[lifecycle] ?? LIFECYCLE_META.idle

  return (
    <span className="inline-flex items-center gap-1.5 border border-border/40 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground">
      <span className={cn('h-1.5 w-1.5 rounded-full', meta.dotClass)} />
      {label}
    </span>
  )
}

function ContextCapsule({
  sessionId,
  modelId,
  providerId
}: {
  sessionId: string
  modelId: string
  providerId: string
}): React.JSX.Element | null {
  // useShallow + field picking is required: getContextUsage() returns a fresh
  // object each call, and some fields (model, cost, rawMaxTokens) can also be
  // freshly-allocated — a naive selector would loop useSyncExternalStore.
  const { used, limit, percent, tokens, categories, isRefreshing } = useContextStore(
    useShallow((state) => {
      const usage = state.getContextUsage(sessionId, modelId, providerId)
      return {
        used: usage.used,
        limit: usage.limit,
        percent: usage.percent,
        tokens: usage.tokens,
        categories: usage.categories,
        isRefreshing: usage.isRefreshing
      }
    })
  )

  if (!limit && used === 0 && !isRefreshing) return null

  const pct = Math.min(100, Math.max(0, percent ?? 0))
  const barColor = getBarColor(pct)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            'inline-flex items-center gap-1.5 border border-border/40 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground cursor-default',
            isRefreshing && 'animate-pulse'
          )}
          data-testid="context-capsule"
        >
          <div className="h-1 w-8 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${pct}%`, backgroundColor: barColor }}
            />
          </div>
          <span className="font-mono">{pct}%</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8} className="max-w-[260px]">
        <div className="space-y-1.5">
          <div className="font-medium">Context Window</div>
          <div>
            {formatNumber(used)}
            {limit ? ` / ${formatNumber(limit)}` : ''} tokens
          </div>
          {categories && categories.length > 0 ? (
            <div className="border-t border-background/20 pt-1.5 space-y-0.5 text-[10px] opacity-80">
              {categories.slice(0, 6).map((category) => (
                <div key={category.name} className="flex items-center justify-between gap-3">
                  <span className="truncate">{category.name}</span>
                  <span className="font-mono shrink-0">{formatNumber(category.tokens)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="border-t border-background/20 pt-1.5 space-y-0.5 text-[10px] opacity-80">
              <div>Input: {formatNumber(tokens.input)}</div>
              <div>Cache read: {formatNumber(tokens.cacheRead)}</div>
              <div>Cache write: {formatNumber(tokens.cacheWrite)}</div>
            </div>
          )}
          {(tokens.output > 0 || tokens.reasoning > 0) && (
            <div className="border-t border-background/20 pt-1.5 space-y-0.5 text-[10px] opacity-60">
              <div className="text-[10px]">Generated</div>
              {tokens.output > 0 && <div>Output: {formatNumber(tokens.output)}</div>}
              {tokens.reasoning > 0 && <div>Reasoning: {formatNumber(tokens.reasoning)}</div>}
            </div>
          )}
          {isRefreshing && (
            <div className="border-t border-background/20 pt-1.5 text-[10px] opacity-70">
              Compressing context...
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function CostCapsule({
  summary,
  fallbackCost,
  fallbackTokens
}: {
  summary: UsageAnalyticsSessionSummary | null
  fallbackCost: number
  fallbackTokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
}): React.JSX.Element | null {
  const totalCost = Math.max(summary?.total_cost ?? 0, fallbackCost ?? 0)
  const totalTokens =
    summary?.total_tokens ??
    ((fallbackTokens?.input ?? 0) +
      (fallbackTokens?.output ?? 0) +
      (fallbackTokens?.cacheRead ?? 0) +
      (fallbackTokens?.cacheWrite ?? 0))
  const modelSummary = formatModelLabelSummary(getSessionSummaryModelLabels(summary))

  if (totalCost <= 0 && totalTokens <= 0) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="inline-flex items-center gap-1 border border-border/40 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors cursor-pointer"
          data-testid="cost-capsule"
        >
          <span className="font-mono">${totalCost.toFixed(2)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-72">
        <PopoverHeader className="gap-2">
          <PopoverTitle className="flex items-center gap-2 text-sm">
            <DollarSign className="h-4 w-4 text-muted-foreground" />
            Session Cost
          </PopoverTitle>
        </PopoverHeader>
        <div className="mt-3 space-y-2 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Total cost</span>
            <span className="font-mono font-medium">{formatCurrency(totalCost)}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Total tokens</span>
            <span className="font-mono">{formatTokensShort(totalTokens)}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 border-t border-border/70 pt-2">
            <div className="rounded-lg bg-muted/45 px-2 py-1.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Input</div>
              <div className="mt-1 font-mono">
                {formatTokensShort(summary?.input_tokens ?? fallbackTokens?.input ?? 0)}
              </div>
            </div>
            <div className="rounded-lg bg-muted/45 px-2 py-1.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Output</div>
              <div className="mt-1 font-mono">
                {formatTokensShort(summary?.output_tokens ?? fallbackTokens?.output ?? 0)}
              </div>
            </div>
            <div className="rounded-lg bg-muted/45 px-2 py-1.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Cache write</div>
              <div className="mt-1 font-mono">
                {formatTokensShort(summary?.cache_write_tokens ?? fallbackTokens?.cacheWrite ?? 0)}
              </div>
            </div>
            <div className="rounded-lg bg-muted/45 px-2 py-1.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Cache read</div>
              <div className="mt-1 font-mono">
                {formatTokensShort(summary?.cache_read_tokens ?? fallbackTokens?.cacheRead ?? 0)}
              </div>
            </div>
          </div>
          {modelSummary && (
            <div className="flex items-center justify-between gap-3 border-t border-border/70 pt-2">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Layers3 className="h-3.5 w-3.5" />
                Model
              </span>
              <span className="truncate font-medium" title={modelSummary.full}>
                {modelSummary.short}
              </span>
            </div>
          )}
          {summary && summary.duration_seconds > 0 && (
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Clock3 className="h-3.5 w-3.5" />
                Duration
              </span>
              <span className="font-mono">{formatDuration(summary.duration_seconds)}</span>
            </div>
          )}
          {summary?.partial && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-300">
              <TriangleAlert className="inline h-3 w-3 mr-1" />
              Partial data — some usage may not be reflected yet.
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export interface SessionHeaderProps {
  sessionId: string
  session: {
    agent_sdk: string
    model_id: string | null
    model_provider_id: string | null
  }
  lifecycle: SessionLifecycle
  modelId?: string
  providerId?: string
  sessionCost?: number
  sessionTokens?: { input: number; output: number; cacheRead: number; cacheWrite: number } | null
  usageSummary?: UsageAnalyticsSessionSummary | null
}

export function SessionHeader({
  sessionId,
  session,
  lifecycle,
  modelId,
  providerId,
  sessionCost,
  sessionTokens,
  usageSummary
}: SessionHeaderProps): React.JSX.Element {
  const effectiveModelId = modelId ?? session.model_id ?? ''
  const effectiveProviderId = providerId ?? session.model_provider_id ?? ''

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-border/60 shrink-0">
      <ProviderCapsule sdk={session.agent_sdk} lifecycle={lifecycle} />
      <ModelSelector sessionId={sessionId} compact showProviderPrefix={false} />

      <div className="flex-1" />

      {effectiveModelId && (
        <ContextCapsule
          sessionId={sessionId}
          modelId={effectiveModelId}
          providerId={effectiveProviderId}
        />
      )}
      <CostCapsule
        summary={usageSummary ?? null}
        fallbackCost={sessionCost ?? 0}
        fallbackTokens={sessionTokens ?? null}
      />
    </div>
  )
}
