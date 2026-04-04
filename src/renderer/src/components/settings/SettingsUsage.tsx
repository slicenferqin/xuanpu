import { useEffect, useMemo, useRef } from 'react'
import { BarChart3, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'
import { useUsageAnalyticsStore } from '@/stores'

const RANGE_OPTIONS = ['today', '7d', '30d', 'all'] as const
const ENGINE_OPTIONS = ['all', 'claude-code', 'codex'] as const
const TAB_OPTIONS = ['overview', 'models', 'projects', 'sessions', 'timeline'] as const

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString()
}

function formatRelativeDate(value: string): string {
  return new Date(value).toLocaleString()
}

export function SettingsUsage(): React.JSX.Element {
  const { t } = useI18n()
  const {
    filters,
    activeTab,
    dashboard,
    isLoading,
    isResyncing,
    error,
    setRange,
    setEngine,
    setActiveTab,
    fetchDashboard,
    resyncAndRefresh
  } = useUsageAnalyticsStore()
  const backgroundSyncedKeyRef = useRef<string | null>(null)

  useEffect(() => {
    void fetchDashboard()
  }, [filters.range, filters.engine, fetchDashboard])

  useEffect(() => {
    if (!dashboard || isResyncing) return
    if (dashboard.sync.stale_session_count <= 0) return

    const syncKey = `${dashboard.filters.range}:${dashboard.filters.engine}:${dashboard.generated_at}`
    if (backgroundSyncedKeyRef.current === syncKey) return

    backgroundSyncedKeyRef.current = syncKey
    void resyncAndRefresh()
  }, [dashboard, isResyncing, resyncAndRefresh])

  const topModels = useMemo(() => dashboard?.by_model.slice(0, 3) ?? [], [dashboard])
  const topProjects = useMemo(() => dashboard?.by_project.slice(0, 3) ?? [], [dashboard])
  const maxTimelineCost = useMemo(() => {
    return Math.max(...(dashboard?.timeline.map((row) => row.total_cost) ?? [0]), 0)
  }, [dashboard])

  return (
    <div className="space-y-6" data-testid="settings-usage">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="text-base font-medium mb-1">{t('settings.usage.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('settings.usage.description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void fetchDashboard({ force: true })}
            disabled={isLoading}
            data-testid="usage-refresh-button"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t('settings.usage.actions.refresh')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void resyncAndRefresh()}
            disabled={isResyncing}
            data-testid="usage-resync-button"
          >
            {isResyncing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <BarChart3 className="h-4 w-4" />
            )}
            {t('settings.usage.actions.resync')}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-muted/20 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {t('settings.usage.filters.range')}
          </span>
          {RANGE_OPTIONS.map((range) => (
            <button
              key={range}
              type="button"
              onClick={() => setRange(range)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                filters.range === range
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'
              )}
              data-testid={`usage-range-${range}`}
            >
              {t(`settings.usage.ranges.${range}`)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {t('settings.usage.filters.engine')}
          </span>
          {ENGINE_OPTIONS.map((engine) => (
            <button
              key={engine}
              type="button"
              onClick={() => setEngine(engine)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                filters.engine === engine
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'
              )}
              data-testid={`usage-engine-${engine}`}
            >
              {t(`settings.usage.engines.${engine}`)}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {dashboard && (dashboard.partial_sessions.length > 0 || dashboard.sync.stale_session_count > 0) && (
        <div
          className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200"
          data-testid="usage-partial-banner"
        >
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              {dashboard.partial_sessions.length > 0 && (
                <div>
                  {t('settings.usage.partial.partialCount', {
                    count: dashboard.partial_sessions.length
                  })}
                </div>
              )}
              {dashboard.sync.stale_session_count > 0 && (
                <div>
                  {t('settings.usage.partial.staleCount', {
                    count: dashboard.sync.stale_session_count
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {isLoading && !dashboard ? (
        <div className="flex h-64 items-center justify-center rounded-2xl border border-border/70">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : dashboard ? (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-border/70 bg-background px-4 py-4">
              <div className="text-xs text-muted-foreground">{t('settings.usage.summary.totalCost')}</div>
              <div className="mt-2 text-2xl font-semibold">{formatCurrency(dashboard.total_cost)}</div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background px-4 py-4">
              <div className="text-xs text-muted-foreground">{t('settings.usage.summary.totalSessions')}</div>
              <div className="mt-2 text-2xl font-semibold">{dashboard.total_sessions.toLocaleString()}</div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background px-4 py-4">
              <div className="text-xs text-muted-foreground">{t('settings.usage.summary.totalTokens')}</div>
              <div className="mt-2 text-2xl font-semibold">{formatTokens(dashboard.total_tokens)}</div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background px-4 py-4">
              <div className="text-xs text-muted-foreground">
                {t('settings.usage.summary.averageCostPerSession')}
              </div>
              <div className="mt-2 text-2xl font-semibold">
                {formatCurrency(
                  dashboard.total_sessions > 0 ? dashboard.total_cost / dashboard.total_sessions : 0
                )}
              </div>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            {dashboard.by_engine.map((engine) => (
              <div
                key={engine.engine}
                className="rounded-2xl border border-border/70 bg-background px-4 py-4"
              >
                <div className="text-sm font-medium">{t(`settings.usage.engines.${engine.engine}`)}</div>
                <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
                  <div>
                    <div className="text-muted-foreground">{t('settings.usage.summary.totalCost')}</div>
                    <div className="mt-1 font-medium">{formatCurrency(engine.total_cost)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">{t('settings.usage.summary.totalSessions')}</div>
                    <div className="mt-1 font-medium">{engine.total_sessions.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">{t('settings.usage.summary.totalTokens')}</div>
                    <div className="mt-1 font-medium">{formatTokens(engine.total_tokens)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2 rounded-2xl border border-border/70 bg-muted/20 p-2">
            {TAB_OPTIONS.map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={cn(
                  'rounded-xl px-3 py-2 text-sm font-medium transition-colors',
                  activeTab === tab
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                data-testid={`usage-tab-${tab}`}
              >
                {t(`settings.usage.tabs.${tab}`)}
              </button>
            ))}
          </div>

          {activeTab === 'overview' && (
            <div className="space-y-4" data-testid="usage-tab-panel-overview">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-2xl border border-border/70 bg-background px-4 py-4">
                  <div className="text-xs text-muted-foreground">{t('settings.usage.tokens.input')}</div>
                  <div className="mt-2 text-lg font-semibold">{formatTokens(dashboard.total_input_tokens)}</div>
                </div>
                <div className="rounded-2xl border border-border/70 bg-background px-4 py-4">
                  <div className="text-xs text-muted-foreground">{t('settings.usage.tokens.output')}</div>
                  <div className="mt-2 text-lg font-semibold">{formatTokens(dashboard.total_output_tokens)}</div>
                </div>
                <div className="rounded-2xl border border-border/70 bg-background px-4 py-4">
                  <div className="text-xs text-muted-foreground">{t('settings.usage.tokens.cacheWrite')}</div>
                  <div className="mt-2 text-lg font-semibold">
                    {formatTokens(dashboard.total_cache_write_tokens)}
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 bg-background px-4 py-4">
                  <div className="text-xs text-muted-foreground">{t('settings.usage.tokens.cacheRead')}</div>
                  <div className="mt-2 text-lg font-semibold">
                    {formatTokens(dashboard.total_cache_read_tokens)}
                  </div>
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-2">
                <div className="rounded-2xl border border-border/70 bg-background px-4 py-4">
                  <div className="mb-3 text-sm font-medium">{t('settings.usage.overview.topModels')}</div>
                  <div className="space-y-3">
                    {topModels.map((row) => (
                      <div key={`${row.engine}-${row.model_key}`} className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{row.model_label}</div>
                          <div className="text-xs text-muted-foreground">
                            {t(`settings.usage.engines.${row.engine}`)} · {row.session_count.toLocaleString()} sessions
                          </div>
                        </div>
                        <div className="font-mono text-sm">{formatCurrency(row.total_cost)}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-2xl border border-border/70 bg-background px-4 py-4">
                  <div className="mb-3 text-sm font-medium">{t('settings.usage.overview.topProjects')}</div>
                  <div className="space-y-3">
                    {topProjects.map((row) => (
                      <div key={`${row.engine}-${row.project_id}`} className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{row.project_name}</div>
                          <div className="truncate text-xs text-muted-foreground">{row.project_path}</div>
                        </div>
                        <div className="font-mono text-sm">{formatCurrency(row.total_cost)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'models' && (
            <div className="rounded-2xl border border-border/70 bg-background" data-testid="usage-tab-panel-models">
              <div className="grid grid-cols-[minmax(0,2fr)_120px_120px_120px] gap-3 border-b border-border/70 px-4 py-3 text-xs font-medium text-muted-foreground">
                <div>{t('settings.usage.tables.model')}</div>
                <div>{t('settings.usage.tables.sessions')}</div>
                <div>{t('settings.usage.tables.tokens')}</div>
                <div>{t('settings.usage.tables.cost')}</div>
              </div>
              <div className="divide-y divide-border/60">
                {dashboard.by_model.map((row) => (
                  <div key={`${row.engine}-${row.model_key}`} className="grid grid-cols-[minmax(0,2fr)_120px_120px_120px] gap-3 px-4 py-3 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{row.model_label}</div>
                      <div className="text-xs text-muted-foreground">
                        {t(`settings.usage.engines.${row.engine}`)}
                      </div>
                    </div>
                    <div>{row.session_count.toLocaleString()}</div>
                    <div>{formatTokens(row.total_tokens)}</div>
                    <div className="font-mono">{formatCurrency(row.total_cost)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'projects' && (
            <div className="rounded-2xl border border-border/70 bg-background" data-testid="usage-tab-panel-projects">
              <div className="grid grid-cols-[minmax(0,2fr)_120px_120px_120px] gap-3 border-b border-border/70 px-4 py-3 text-xs font-medium text-muted-foreground">
                <div>{t('settings.usage.tables.project')}</div>
                <div>{t('settings.usage.tables.sessions')}</div>
                <div>{t('settings.usage.tables.tokens')}</div>
                <div>{t('settings.usage.tables.cost')}</div>
              </div>
              <div className="divide-y divide-border/60">
                {dashboard.by_project.map((row) => (
                  <div key={`${row.engine}-${row.project_id}`} className="grid grid-cols-[minmax(0,2fr)_120px_120px_120px] gap-3 px-4 py-3 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{row.project_name}</div>
                      <div className="truncate text-xs text-muted-foreground">{row.project_path}</div>
                    </div>
                    <div>{row.session_count.toLocaleString()}</div>
                    <div>{formatTokens(row.total_tokens)}</div>
                    <div className="font-mono">{formatCurrency(row.total_cost)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'sessions' && (
            <div className="rounded-2xl border border-border/70 bg-background" data-testid="usage-tab-panel-sessions">
              <div className="grid grid-cols-[minmax(0,1.8fr)_120px_120px_120px_180px] gap-3 border-b border-border/70 px-4 py-3 text-xs font-medium text-muted-foreground">
                <div>{t('settings.usage.tables.session')}</div>
                <div>{t('settings.usage.tables.model')}</div>
                <div>{t('settings.usage.tables.tokens')}</div>
                <div>{t('settings.usage.tables.cost')}</div>
                <div>{t('settings.usage.tables.lastUsed')}</div>
              </div>
              <div className="divide-y divide-border/60">
                {dashboard.sessions.map((row) => (
                  <div key={row.session_id} className="grid grid-cols-[minmax(0,1.8fr)_120px_120px_120px_180px] gap-3 px-4 py-3 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{row.session_name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {row.project_name} · {t(`settings.usage.engines.${row.engine}`)}
                      </div>
                    </div>
                    <div className="truncate">{row.model_label ?? '-'}</div>
                    <div>{formatTokens(row.total_tokens)}</div>
                    <div className="font-mono">{formatCurrency(row.total_cost)}</div>
                    <div className="text-xs text-muted-foreground">{formatRelativeDate(row.last_used_at)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'timeline' && (
            <div className="rounded-2xl border border-border/70 bg-background px-4 py-4" data-testid="usage-tab-panel-timeline">
              <div className="space-y-3">
                {dashboard.timeline.map((row) => (
                  <div key={row.date} className="grid grid-cols-[100px_1fr_120px_90px] items-center gap-3">
                    <div className="text-xs text-muted-foreground">{row.date}</div>
                    <div className="h-2 rounded-full bg-muted">
                      <div
                        className="h-2 rounded-full bg-primary"
                        style={{
                          width: `${maxTimelineCost > 0 ? Math.max((row.total_cost / maxTimelineCost) * 100, 2) : 0}%`
                        }}
                      />
                    </div>
                    <div className="font-mono text-sm">{formatCurrency(row.total_cost)}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.total_sessions.toLocaleString()} sessions
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">
          {t('settings.usage.empty')}
        </div>
      )}
    </div>
  )
}
