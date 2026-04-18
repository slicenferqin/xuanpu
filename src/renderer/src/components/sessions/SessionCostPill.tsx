import { DollarSign, Clock3, Layers3, TriangleAlert } from 'lucide-react'
import type { UsageAnalyticsSessionSummary } from '@shared/types/usage-analytics'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'
import { formatModelLabelSummary, getSessionSummaryModelLabels } from '@/lib/model-labels'

interface SessionCostPillProps {
  summary: UsageAnalyticsSessionSummary | null
  fallbackCost: number
  fallbackTokens?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  } | null
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(4)}`
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString()
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`
  }
  return `${secs}s`
}

export function SessionCostPill({
  summary,
  fallbackCost,
  fallbackTokens: _fallbackTokens
}: SessionCostPillProps): React.JSX.Element | null {
  const { t } = useI18n()
  const modelSummary = formatModelLabelSummary(getSessionSummaryModelLabels(summary))
  const totalCost = Math.max(summary?.total_cost ?? 0, fallbackCost ?? 0)
  const hasSummaryTokens = (summary?.total_tokens ?? 0) > 0
  const totalTokens = summary?.total_tokens ?? 0

  void _fallbackTokens

  if (totalCost <= 0 && !hasSummaryTokens) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'h-7 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 text-[12px] font-medium text-emerald-700 shadow-[0_0_0_1px_rgba(16,185,129,0.08)] transition-colors hover:bg-emerald-500/14 hover:text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-500/12 dark:text-emerald-200 dark:hover:bg-emerald-500/18'
          )}
          data-testid="session-cost-pill"
        >
          <DollarSign className="h-3.5 w-3.5" />
          <span className="font-mono">{formatCurrency(totalCost)}</span>
          {summary?.partial && <TriangleAlert className="h-3.5 w-3.5 text-amber-500" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72">
        <PopoverHeader className="gap-2">
          <PopoverTitle className="flex items-center gap-2 text-sm">
            <DollarSign className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
            {t('sessionView.costPill.title')}
          </PopoverTitle>
        </PopoverHeader>
        <div className="mt-3 space-y-2 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{t('sessionView.costPill.totalCost')}</span>
            <span className="font-mono font-medium">{formatCurrency(totalCost)}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{t('sessionView.costPill.totalTokens')}</span>
            {hasSummaryTokens ? (
              <span className="font-mono">{formatTokens(totalTokens)}</span>
            ) : (
              <span className="text-muted-foreground">
                {t('sessionView.costPill.totalsSyncing')}
              </span>
            )}
          </div>
          {hasSummaryTokens ? (
            <div className="grid grid-cols-2 gap-2 border-t border-border/70 pt-2">
              <div className="rounded-lg bg-muted/45 px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t('sessionView.costPill.input')}
                </div>
                <div className="mt-1 font-mono">{formatTokens(summary?.input_tokens ?? 0)}</div>
              </div>
              <div className="rounded-lg bg-muted/45 px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t('sessionView.costPill.output')}
                </div>
                <div className="mt-1 font-mono">{formatTokens(summary?.output_tokens ?? 0)}</div>
              </div>
              <div className="rounded-lg bg-muted/45 px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t('sessionView.costPill.cacheWrite')}
                </div>
                <div className="mt-1 font-mono">
                  {formatTokens(summary?.cache_write_tokens ?? 0)}
                </div>
              </div>
              <div className="rounded-lg bg-muted/45 px-2 py-1.5">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t('sessionView.costPill.cacheRead')}
                </div>
                <div className="mt-1 font-mono">
                  {formatTokens(summary?.cache_read_tokens ?? 0)}
                </div>
              </div>
            </div>
          ) : null}
          {modelSummary && (
            <div className="flex items-center justify-between gap-3 border-t border-border/70 pt-2">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Layers3 className="h-3.5 w-3.5" />
                {t('sessionView.costPill.model')}
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
                {t('sessionView.costPill.duration')}
              </span>
              <span className="font-mono">{formatDuration(summary.duration_seconds)}</span>
            </div>
          )}
          {summary?.partial && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-300">
              {t('sessionView.costPill.partialData')}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
