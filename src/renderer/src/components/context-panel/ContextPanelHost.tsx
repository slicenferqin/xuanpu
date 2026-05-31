import React, { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  BarChart3,
  Files,
  GitPullRequest,
  HelpCircle,
  ListTodo,
  SquareTerminal,
  Target
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'
import { useLayoutStore, type RightContextTab } from '@/stores/useLayoutStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSessionRuntimeStore } from '@/stores/useSessionRuntimeStore'
import { useContextStore } from '@/stores/useContextStore'
import { FileTree } from '@/components/file-tree/FileTree'
import {
  ReviewWorkflowPanel,
  type ConnectionMemberInfo
} from '@/components/context-panel/ReviewWorkflowPanel'
import { GoalStatusCard } from '@/components/session-hq/cards/GoalStatusCard'
import { TodoCard } from '@/components/session-hq/cards/TodoCard'
import { FieldContextDebug } from '@/components/sessions/FieldContextDebug'
import { extractMissionTasks, type SessionTask } from '@/lib/session-tasks'
import { resolveUsageTokenTotals } from '@/lib/usage-token-totals'
import type {
  UsageAnalyticsScopeSummary,
  UsageAnalyticsSessionSummary
} from '@shared/types/usage-analytics'

interface ContextPanelHostProps {
  worktreePath: string | null
  scopeId?: string | null
  isConnectionMode?: boolean
  connectionMembers?: ConnectionMemberInfo[]
  onClose: () => void
  onFileClick: (node: { path: string; name: string; isDirectory: boolean }) => void
  terminalPanel?: React.ReactNode
  className?: string
}

const CONTEXT_TABS: Array<{
  id: RightContextTab
  icon: React.ComponentType<{ className?: string }>
  labelKey: string
}> = [
  { id: 'overview', icon: BarChart3, labelKey: 'contextPanel.tabs.overview' },
  { id: 'review', icon: GitPullRequest, labelKey: 'contextPanel.tabs.review' },
  { id: 'files', icon: Files, labelKey: 'contextPanel.tabs.files' },
  { id: 'tasks', icon: ListTodo, labelKey: 'contextPanel.tabs.tasks' },
  { id: 'goal', icon: Target, labelKey: 'contextPanel.tabs.goal' },
  { id: 'terminal', icon: SquareTerminal, labelKey: 'bottomPanel.tabs.terminal' }
]

const DEV_CONTEXT_TABS: Array<{
  id: RightContextTab
  icon: React.ComponentType<{ className?: string }>
  labelKey: string
}> = [
  ...CONTEXT_TABS.slice(0, -1),
  { id: 'diagnostics', icon: Activity, labelKey: 'contextPanel.tabs.diagnostics' },
  CONTEXT_TABS[CONTEXT_TABS.length - 1]
]

const SHOW_CONTEXT_DIAGNOSTICS =
  typeof process !== 'undefined' &&
  (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')

const EMPTY_TASKS: SessionTask[] = []

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

type OverviewSession = {
  id: string
  status?: string | null
}

function overviewSessionsEqual(a: OverviewSession[], b: OverviewSession[]): boolean {
  if (a.length !== b.length) return false
  return a.every((session, index) => {
    const other = b[index]
    return session.id === other?.id && session.status === other.status
  })
}

function encodeOverviewSession(session: OverviewSession): string {
  return `${session.id}:${session.status ?? ''}`
}

function decodeOverviewSession(value: string): OverviewSession {
  const separatorIndex = value.lastIndexOf(':')
  if (separatorIndex < 0) return { id: value }
  return {
    id: value.slice(0, separatorIndex),
    status: value.slice(separatorIndex + 1) || null
  }
}

function EmptyPanel({
  title,
  description
}: {
  title: string
  description: string
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-5 text-center">
      <div className="max-w-[240px]">
        <div className="text-sm font-medium text-sidebar-foreground">{title}</div>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</div>
      </div>
    </div>
  )
}

function MetricRow({
  label,
  value,
  alert = false
}: {
  label: string
  value: string
  alert?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 py-0.5">
      <div className="min-w-0 truncate text-[11px] text-xp-telemetry-muted">{label}</div>
      <div
        className={cn(
          'shrink-0 font-mono text-[11px] tabular-nums',
          alert ? 'text-xp-intent-danger font-medium' : 'text-xp-telemetry-text'
        )}
      >
        {value}
      </div>
    </div>
  )
}

function ContextBar({
  used,
  max,
  percent,
  alert
}: {
  used: number
  max: number
  percent: number | null
  alert: boolean
}): React.JSX.Element {
  const pct = percent ?? (max > 0 ? (used / max) * 100 : 0)
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-xp-telemetry-muted">
          {formatCompactNumber(used)} / {formatCompactNumber(max)}
        </span>
        <span
          className={cn(
            'font-mono tabular-nums',
            alert ? 'text-xp-intent-danger font-medium' : 'text-xp-telemetry-text'
          )}
        >
          {pct.toFixed(1)}%
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-xp-telemetry-track">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            alert ? 'bg-xp-intent-danger' : 'bg-xp-telemetry-text/30'
          )}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-xp-telemetry-muted">
      {children}
    </div>
  )
}

function OverviewPanel({
  sessions,
  worktreePath,
  scopeLabel,
  scopeId,
  isConnectionMode,
  activeSessionId
}: {
  sessions: OverviewSession[]
  worktreePath: string | null
  scopeLabel: string
  scopeId: string | null
  isConnectionMode: boolean
  activeSessionId: string | null
}): React.JSX.Element {
  const { t } = useI18n()
  const sessionIds = useMemo(() => sessions.map((session) => session.id), [sessions])
  const sessionIdsKey = sessionIds.join('|')
  const activeSessionCount = sessions.filter((session) => session.status === 'active').length
  const inactiveSessionCount = Math.max(0, sessions.length - activeSessionCount)
  const sessionBreakdownTitle = [
    t('contextPanel.overview.activeSessions', { count: activeSessionCount }),
    t('contextPanel.overview.inactiveSessions', { count: inactiveSessionCount })
  ].join('\n')

  const [sessionSummary, setSessionSummary] = useState<UsageAnalyticsSessionSummary | null>(null)
  const [scopeSummary, setScopeSummary] = useState<UsageAnalyticsScopeSummary | null>(null)
  const [scopeSummaryStatus, setScopeSummaryStatus] = useState<'loading' | 'ready' | 'error' | 'empty'>('loading')

  const liveTokens = useContextStore(
    useShallow((state) => (activeSessionId ? state.tokensBySession[activeSessionId] : null))
  )
  const liveCost = useContextStore(
    useShallow((state) => (activeSessionId ? (state.costBySession[activeSessionId] ?? 0) : 0))
  )
  const contextSnapshot = useContextStore(
    useShallow((state) => (activeSessionId ? state.contextSnapshotsBySession[activeSessionId] : null))
  )

  const activityTick = useSessionRuntimeStore((state) =>
    activeSessionId ? state.sessions.get(activeSessionId)?.lastActivityAt ?? 0 : 0
  )

  // Fetch current session summary
  useEffect(() => {
    let cancelled = false
    if (!activeSessionId || !window.usageAnalyticsOps?.fetchSessionSummary) {
      setSessionSummary(null)
      return () => { cancelled = true }
    }

    window.usageAnalyticsOps.fetchSessionSummary(activeSessionId).then((result) => {
      if (cancelled) return
      setSessionSummary(result.success && result.data ? result.data : null)
    }).catch(() => {
      if (!cancelled) setSessionSummary(null)
    })

    return () => { cancelled = true }
  }, [activeSessionId, activityTick])

  // Fetch worktree aggregate
  useEffect(() => {
    let cancelled = false
    if (sessionIds.length === 0 || !scopeId || !window.usageAnalyticsOps?.fetchScopeSummary) {
      setScopeSummary(null)
      setScopeSummaryStatus('empty')
      return () => { cancelled = true }
    }

    setScopeSummaryStatus('loading')
    const scopeType = isConnectionMode ? 'connection' : 'worktree'
    window.usageAnalyticsOps.fetchScopeSummary(scopeId, scopeType, sessionIds).then((result) => {
      if (cancelled) return
      if (result.success && result.data) {
        setScopeSummary(result.data)
        setScopeSummaryStatus('ready')
      } else {
        setScopeSummary(null)
        setScopeSummaryStatus('error')
      }
    }).catch(() => {
      if (cancelled) return
      setScopeSummary(null)
      setScopeSummaryStatus('error')
    })

    return () => { cancelled = true }
  }, [sessionIds, sessionIdsKey, scopeId, isConnectionMode])

  if (!worktreePath && sessionIds.length === 0) {
    return (
      <EmptyPanel
        title={t('contextPanel.empty.noWorktree')}
        description={t('contextPanel.empty.noSessionDescription')}
      />
    )
  }

  // ── Current Session data: use resolveUsageTokenTotals for consistency ──
  const resolvedTokens = resolveUsageTokenTotals(sessionSummary, liveTokens)
  // Cost: Math.max like top SessionCostPill — never show older value when live is higher
  const sCost = Math.max(sessionSummary?.total_cost ?? 0, liveCost ?? 0)
  const sPartial = sessionSummary?.partial ?? false
  const sModel = sessionSummary?.latest_model_label ?? null
  const sDuration = sessionSummary?.duration_seconds ?? 0
  const sCacheHitRate = resolvedTokens.cacheReadTokens > 0
    ? Math.round(
        (resolvedTokens.cacheReadTokens /
          (resolvedTokens.cacheReadTokens + resolvedTokens.inputTokens + resolvedTokens.cacheWriteTokens)) * 100
      )
    : null

  // Context: prefer runtime snapshot, then persisted snapshot, then null
  const contextUsed = contextSnapshot?.usedTokens ?? sessionSummary?.context_used_tokens ?? null
  const contextWindow = contextSnapshot?.maxTokens ?? sessionSummary?.context_window_tokens ?? null
  const contextPercent = contextSnapshot?.percent ?? sessionSummary?.context_percent ?? null
  const contextAlert = contextPercent !== null && contextPercent >= 90

  // ── Worktree Aggregate data with live overlay ──
  // When the active session's live data is higher than its persisted contribution,
  // replace it in the scope aggregate. This ensures scope >= current session.
  // Guard: only do subtraction+addition when contribution exists. Otherwise
  // use Math.max to avoid double-counting (base already includes persisted data).
  const scopeContributions = scopeSummary?.session_contributions
  const activeContribution = activeSessionId ? scopeContributions?.[activeSessionId] : null
  const liveTotalTokens = liveTokens
    ? liveTokens.input + liveTokens.output + liveTokens.cacheRead + liveTokens.cacheWrite
    : 0
  const liveTotalCost = liveCost ?? 0

  const wBaseCost = scopeSummary?.total_cost ?? 0
  const wBaseTokens = scopeSummary?.total_tokens ?? 0
  let wCost = wBaseCost
  let wTokens = wBaseTokens

  if (activeContribution) {
    // Contribution exists: replace it with live if live is higher
    const oldCost = activeContribution.totalCost
    const oldTokens = activeContribution.totalTokens
    if (liveTotalTokens > oldTokens || liveTotalCost > oldCost) {
      wCost = wBaseCost - oldCost + Math.max(oldCost, liveTotalCost)
      wTokens = wBaseTokens - oldTokens + Math.max(oldTokens, liveTotalTokens)
    }
  } else if (activeSessionId && (liveTotalTokens > 0 || liveTotalCost > 0)) {
    // No contribution found: use Math.max to avoid double-counting
    wCost = Math.max(wBaseCost, liveTotalCost)
    wTokens = Math.max(wBaseTokens, liveTotalTokens)
  }

  const wSessionCount = scopeSummary?.session_count ?? sessionIds.length
  const wCoverage = scopeSummary?.coverage

  return (
    <div className="min-h-0 flex-1 overflow-auto px-2.5 py-3" data-testid="context-panel-overview">
      <div className="space-y-3">

        {/* ── Current Session ── */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <SectionLabel>{t('contextPanel.inspector.currentSession')}</SectionLabel>
            {sPartial && (
              <span className="text-[9px] font-medium text-xp-intent-warning bg-xp-intent-warning/10 rounded px-1 py-0.5">
                {t('contextPanel.inspector.partial')}
              </span>
            )}
          </div>

          <div className="rounded-lg border border-xp-telemetry-border bg-xp-ops-surface-muted px-3 py-2 space-y-1">
            <MetricRow label={t('contextPanel.overview.cost')} value={formatCost(sCost)} />
            <MetricRow label={t('contextPanel.overview.tokens')} value={formatCompactNumber(resolvedTokens.totalTokens)} />
            {sModel && (
              <MetricRow label={t('contextPanel.inspector.model')} value={sModel} />
            )}
            {sDuration > 0 && (
              <MetricRow
                label={t('contextPanel.inspector.duration')}
                value={sDuration < 60 ? `${sDuration}s` : `${Math.round(sDuration / 60)}m`}
              />
            )}
          </div>

          {/* Token breakdown */}
          {resolvedTokens.totalTokens > 0 && (
            <div className="rounded-lg border border-xp-telemetry-border bg-xp-ops-surface-muted px-3 py-2 space-y-1">
              <SectionLabel>{t('contextPanel.inspector.tokenBreakdown')}</SectionLabel>
              <MetricRow label={t('contextPanel.overview.input')} value={formatCompactNumber(resolvedTokens.inputTokens)} />
              <MetricRow label={t('contextPanel.overview.output')} value={formatCompactNumber(resolvedTokens.outputTokens)} />
              <MetricRow label={t('contextPanel.overview.cacheRead')} value={formatCompactNumber(resolvedTokens.cacheReadTokens)} />
              {sCacheHitRate !== null && (
                <MetricRow
                  label={t('contextPanel.overview.cacheHitRate')}
                  value={`${sCacheHitRate}% (${formatCompactNumber(resolvedTokens.cacheReadTokens)} / ${formatCompactNumber(resolvedTokens.cacheReadTokens + resolvedTokens.inputTokens + resolvedTokens.cacheWriteTokens)})`}
                />
              )}
            </div>
          )}
        </section>

        {/* ── Context ── */}
        {contextUsed !== null && contextUsed > 0 && (
          <section className="space-y-1.5">
            <SectionLabel>{t('contextPanel.overview.contextPressure')}</SectionLabel>
            <div className="rounded-lg border border-xp-telemetry-border bg-xp-ops-surface-muted px-3 py-2">
              {contextWindow && contextWindow > 0 ? (
                <ContextBar used={contextUsed} max={contextWindow} percent={contextPercent} alert={false} />
              ) : (
                <MetricRow label={t('contextPanel.inspector.contextUsed')} value={formatCompactNumber(contextUsed)} />
              )}
            </div>
          </section>
        )}

        {/* ── Worktree Aggregate ── */}
        <section className="space-y-1.5">
          <SectionLabel>
            {scopeLabel} · {t('contextPanel.inspector.aggregate')}
            <span
              className="ml-1 inline-flex h-3.5 w-3.5 translate-y-[1px] items-center justify-center rounded-full border border-xp-telemetry-border text-xp-telemetry-muted"
              aria-label={t('contextPanel.overview.sessionBreakdownLabel')}
              title={sessionBreakdownTitle}
            >
              <HelpCircle className="h-2.5 w-2.5" />
            </span>
          </SectionLabel>
          {scopeSummaryStatus === 'loading' && (
            <div className="rounded-lg border border-xp-telemetry-border/40 bg-xp-ops-surface-muted/30 px-3 py-2">
              <div className="text-[10px] text-xp-telemetry-muted">
                {t('contextPanel.inspector.noAggregateData')}
              </div>
            </div>
          )}
          {scopeSummaryStatus === 'error' && (
            <div className="rounded-lg border border-xp-intent-warning/30 bg-xp-intent-warning/5 px-3 py-2">
              <div className="text-[10px] text-xp-intent-warning">
                {t('contextPanel.inspector.aggregateError')}
              </div>
            </div>
          )}
          {scopeSummaryStatus === 'empty' && (
            <div className="rounded-lg border border-xp-telemetry-border/40 bg-xp-ops-surface-muted/30 px-3 py-2">
              <div className="text-[10px] text-xp-telemetry-muted">
                {t('contextPanel.inspector.noAggregateData')}
              </div>
            </div>
          )}
          {scopeSummaryStatus === 'ready' && scopeSummary && (
            <div className="rounded-lg border border-xp-telemetry-border/60 bg-xp-ops-surface-muted/50 px-3 py-2 space-y-1">
              <MetricRow label={t('contextPanel.inspector.totalCost')} value={formatCost(wCost)} />
              <MetricRow label={t('contextPanel.inspector.totalTokens')} value={formatCompactNumber(wTokens)} />
              <MetricRow
                label={t('contextPanel.inspector.sessions')}
                value={`${wSessionCount}`}
              />
            </div>
          )}
        </section>

        {/* ── Diagnostics ── */}
        {wCoverage && (
          <section className="space-y-1.5">
            <SectionLabel>{t('contextPanel.overview.dataQuality')}</SectionLabel>
            <div className="rounded-lg border border-xp-telemetry-border/60 bg-xp-ops-surface-muted/50 px-3 py-2">
              <div className="space-y-0.5 font-mono text-[10px] leading-relaxed text-xp-telemetry-muted">
                {wCoverage.synced > 0 && <div>synced: {wCoverage.synced}</div>}
                {wCoverage.legacy_undercounted > 0 && (
                  <div className="text-xp-intent-warning">legacy (undercounted): {wCoverage.legacy_undercounted}</div>
                )}
                {wCoverage.partial > 0 && (
                  <div className="text-xp-intent-warning">partial: {wCoverage.partial}</div>
                )}
                {wCoverage.missing_source > 0 && <div>missing source: {wCoverage.missing_source}</div>}
                {wCoverage.unsupported > 0 && <div>unsupported: {wCoverage.unsupported}</div>}
              </div>
            </div>
          </section>
        )}

        {/* ── Path ── */}
        <section className="rounded-lg border border-xp-telemetry-border/40 bg-xp-ops-surface-muted/30 px-3 py-2">
          <div className="break-all font-mono text-[10px] leading-relaxed text-xp-telemetry-muted">
            {worktreePath ?? t('contextPanel.empty.noWorktree')}
          </div>
        </section>
      </div>
    </div>
  )
}

function getGoalSignature(goal: {
  threadId?: string
  objective: string
  successCriteria?: string
  status: string
  createdAt?: number | null
}): string {
  return [
    goal.threadId?.trim() ?? '',
    goal.objective.trim(),
    goal.successCriteria?.trim() ?? '',
    goal.status.trim().toLowerCase(),
    goal.createdAt ?? ''
  ].join('|')
}

function useSessionTasks(activeSessionId: string | null): SessionTask[] {
  const [tasks, setTasks] = useState<SessionTask[]>([])
  const liveTasks = useSessionRuntimeStore((state) =>
    activeSessionId ? state.getSessionTasks(activeSessionId) : EMPTY_TASKS
  )
  const activityTick = useSessionRuntimeStore((state) =>
    activeSessionId ? state.getSession(activeSessionId).lastActivityAt : 0
  )

  useEffect(() => {
    let cancelled = false
    if (!activeSessionId || !window.agentOps?.getTimeline) {
      setTasks([])
      return () => {
        cancelled = true
      }
    }

    window.agentOps
      .getTimeline(activeSessionId)
      .then((result) => {
        if (!cancelled) {
          setTasks(extractMissionTasks(result.messages ?? []))
        }
      })
      .catch(() => {
        if (!cancelled) setTasks([])
      })

    return () => {
      cancelled = true
    }
  }, [activeSessionId, activityTick])

  return liveTasks.length > 0 ? liveTasks : tasks
}

function GoalPanel({ activeSessionId }: { activeSessionId: string | null }): React.JSX.Element {
  const { t } = useI18n()
  const goal = useSessionRuntimeStore((state) =>
    activeSessionId ? (state.goals.get(activeSessionId) ?? null) : null
  )
  const dismissedGoalSignature = useSessionRuntimeStore((state) =>
    activeSessionId ? state.getDismissedGoalSignature(activeSessionId) : null
  )

  if (!activeSessionId) {
    return (
      <EmptyPanel
        title={t('contextPanel.empty.noSessionTitle')}
        description={t('contextPanel.empty.noSessionDescription')}
      />
    )
  }

  if (!goal || dismissedGoalSignature === getGoalSignature(goal)) {
    return (
      <EmptyPanel
        title={t('contextPanel.goal.emptyTitle')}
        description={t('contextPanel.goal.emptyDescription')}
      />
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="context-panel-goal">
      <GoalStatusCard
        goal={goal}
        onDismiss={
          goal.status.trim().toLowerCase() === 'completed'
            ? () => {
                useSessionRuntimeStore
                  .getState()
                  .dismissGoalSignature(activeSessionId, getGoalSignature(goal))
              }
            : undefined
        }
      />
    </div>
  )
}

function TasksPanel({ activeSessionId }: { activeSessionId: string | null }): React.JSX.Element {
  const { t } = useI18n()
  const tasks = useSessionTasks(activeSessionId)

  if (!activeSessionId) {
    return (
      <EmptyPanel
        title={t('contextPanel.empty.noSessionTitle')}
        description={t('contextPanel.empty.noSessionDescription')}
      />
    )
  }

  if (tasks.length === 0) {
    return (
      <EmptyPanel
        title={t('contextPanel.tasks.emptyTitle')}
        description={t('contextPanel.tasks.emptyDescription')}
      />
    )
  }

  return (
    <div className="min-h-0 flex flex-1 flex-col overflow-hidden px-3 pb-3 pt-2" data-testid="context-panel-tasks">
      <div className="pb-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {t('contextPanel.tabs.tasks')}
        </div>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">仅显示当前最新一轮规划。</div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <TodoCard tasks={tasks} />
      </div>
    </div>
  )
}

function FilesPanel({
  worktreePath,
  isConnectionMode,
  onClose,
  onFileClick
}: Pick<
  ContextPanelHostProps,
  'worktreePath' | 'isConnectionMode' | 'onClose' | 'onFileClick'
>): React.JSX.Element {
  return (
    <FileTree
      worktreePath={worktreePath}
      isConnectionMode={isConnectionMode}
      onClose={onClose}
      onFileClick={onFileClick}
      hideHeader
      hideGitIndicators
      hideGitContextActions
    />
  )
}

function DiagnosticsPanel({
  activeSessionId,
  worktreeId
}: {
  activeSessionId: string | null
  worktreeId: string | null
}): React.JSX.Element {
  const { t } = useI18n()

  if (!activeSessionId && !worktreeId) {
    return (
      <EmptyPanel
        title={t('contextPanel.diagnostics.emptyTitle')}
        description={t('contextPanel.diagnostics.emptyDescription')}
      />
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="context-panel-diagnostics">
      <section className="crisp-panel-surface rounded-xl p-3">
        <div className="mb-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {t('contextPanel.tabs.diagnostics')}
          </div>
          <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t('contextPanel.diagnostics.description')}
          </div>
        </div>
        <FieldContextDebug
          sessionId={activeSessionId}
          worktreeId={worktreeId}
          defaultOpen
          embedded
        />
      </section>
    </div>
  )
}

export function ContextPanelHost({
  worktreePath,
  scopeId,
  isConnectionMode,
  connectionMembers,
  onClose,
  onFileClick,
  terminalPanel,
  className
}: ContextPanelHostProps): React.JSX.Element {
  const { t } = useI18n()
  const activeTab = useLayoutStore((s) => s.rightContextTab)
  const setRightContextTab = useLayoutStore((s) => s.setRightContextTab)
  const setRightReviewTab = useLayoutStore((s) => s.setRightReviewTab)
  const setBottomPanelTab = useLayoutStore((s) => s.setBottomPanelTab)
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)
  const activeSessionId = useSessionStore((s) => s.inlineConnectionSessionId ?? s.activeSessionId)
  const fallbackOverviewScopeId = useSessionStore((s) =>
    isConnectionMode ? s.activeConnectionId : s.activeWorktreeId
  )
  const overviewScopeId = scopeId ?? fallbackOverviewScopeId
  const cachedOverviewSessionKeys = useSessionStore(
    useShallow((s) => {
      const sessions = overviewScopeId
        ? isConnectionMode
          ? (s.sessionsByConnection.get(overviewScopeId) ?? [])
          : (s.sessionsByWorktree.get(overviewScopeId) ?? [])
        : []
      const overviewSessionKeys = sessions.map((session) =>
        encodeOverviewSession({
          id: session.id,
          status: session.status
        })
      )
      if (overviewSessionKeys.length > 0) return overviewSessionKeys
      return activeSessionId
        ? [encodeOverviewSession({ id: activeSessionId, status: 'active' })]
        : []
    })
  )
  const cachedOverviewSessions = useMemo(
    () => cachedOverviewSessionKeys.map(decodeOverviewSession),
    [cachedOverviewSessionKeys]
  )
  const cachedOverviewSessionsKey = cachedOverviewSessionKeys.join('|')
  const [overviewSessions, setOverviewSessions] =
    useState<OverviewSession[]>(cachedOverviewSessions)
  const tabs = useMemo(
    () => {
      const baseTabs = SHOW_CONTEXT_DIAGNOSTICS ? DEV_CONTEXT_TABS : CONTEXT_TABS
      return terminalPanel ? baseTabs : baseTabs.filter((tab) => tab.id !== 'terminal')
    },
    [terminalPanel]
  )
  const overviewScopeLabel = isConnectionMode
    ? t('contextPanel.overview.connection')
    : t('contextPanel.overview.worktree')

  useEffect(() => {
    let cancelled = false

    setOverviewSessions((current) =>
      overviewSessionsEqual(current, cachedOverviewSessions) ? current : cachedOverviewSessions
    )

    if (!overviewScopeId || !window.db?.session) {
      return () => {
        cancelled = true
      }
    }

    const loadSessions = isConnectionMode
      ? window.db.session.getByConnection
      : window.db.session.getByWorktree

    loadSessions(overviewScopeId)
      .then((sessions) => {
        if (cancelled) return
        const loadedSessions = sessions.map((session) => ({
          id: session.id,
          status: session.status
        }))
        const nextSessions = loadedSessions.length > 0 ? loadedSessions : cachedOverviewSessions
        setOverviewSessions((current) =>
          overviewSessionsEqual(current, nextSessions) ? current : nextSessions
        )
      })
      .catch(() => {
        if (cancelled) return
        setOverviewSessions((current) =>
          overviewSessionsEqual(current, cachedOverviewSessions) ? current : cachedOverviewSessions
        )
      })

    return () => {
      cancelled = true
    }
  }, [cachedOverviewSessions, cachedOverviewSessionsKey, isConnectionMode, overviewScopeId])

  useEffect(() => {
    if (activeTab === 'terminal' && !terminalPanel) {
      setRightContextTab('overview')
    }
    if (activeTab === 'diagnostics' && !SHOW_CONTEXT_DIAGNOSTICS) {
      setRightContextTab('overview')
    }
  }, [activeTab, setRightContextTab, terminalPanel])

  useEffect(() => {
    const handler = (event: Event): void => {
      if (!vimModeEnabled) return
      const tab = (event as CustomEvent).detail?.tab
      if (tab === 'files') {
        setRightContextTab('files')
        return
      }
      if (tab === 'terminal' && terminalPanel) {
        setBottomPanelTab('terminal')
        setRightContextTab('terminal')
        return
      }
      if (tab === 'changes' || tab === 'diffs' || tab === 'comments') {
        setRightContextTab('review')
        setRightReviewTab(tab)
      }
    }
    window.addEventListener('hive:right-sidebar-tab', handler)
    return () => window.removeEventListener('hive:right-sidebar-tab', handler)
  }, [setBottomPanelTab, setRightContextTab, setRightReviewTab, terminalPanel, vimModeEnabled])

  const mainContent = useMemo(() => {
    switch (activeTab) {
      case 'terminal':
        return null
      case 'overview':
        return (
          <OverviewPanel
            sessions={overviewSessions}
            worktreePath={worktreePath}
            scopeLabel={overviewScopeLabel}
            scopeId={overviewScopeId ?? null}
            isConnectionMode={!!isConnectionMode}
            activeSessionId={activeSessionId}
          />
        )
      case 'review':
        return (
          <ReviewWorkflowPanel
            worktreePath={worktreePath}
            isConnectionMode={isConnectionMode}
            connectionMembers={connectionMembers}
          />
        )
      case 'files':
        return (
          <FilesPanel
            worktreePath={worktreePath}
            isConnectionMode={isConnectionMode}
            onClose={onClose}
            onFileClick={onFileClick}
          />
        )
      case 'tasks':
        return <TasksPanel activeSessionId={activeSessionId} />
      case 'goal':
        return <GoalPanel activeSessionId={activeSessionId} />
      case 'diagnostics':
        if (!SHOW_CONTEXT_DIAGNOSTICS) return null
        return (
          <DiagnosticsPanel
            activeSessionId={activeSessionId}
            worktreeId={!isConnectionMode ? (overviewScopeId ?? null) : null}
          />
        )
    }
  }, [
    activeSessionId,
    activeTab,
    connectionMembers,
    isConnectionMode,
    onClose,
    onFileClick,
    overviewScopeLabel,
    overviewScopeId,
    overviewSessions,
    worktreePath
  ])

  return (
    <div className={cn('flex h-full bg-transparent', className)} data-testid="context-panel-host">
      <div
        className="flex min-w-0 flex-1 flex-col overflow-hidden bg-transparent"
        data-testid="context-panel-content"
      >
        <div
          className={cn(
            'min-h-0 flex-1 flex-col overflow-hidden',
            activeTab === 'terminal' ? 'hidden' : 'flex'
          )}
          data-testid="context-panel-main-content"
          aria-hidden={activeTab === 'terminal'}
        >
          {mainContent}
        </div>

        {terminalPanel && (
          <div
            className={cn(
              'min-h-0 flex-1 flex-col overflow-hidden',
              activeTab === 'terminal' ? 'flex' : 'hidden'
            )}
            data-testid="context-panel-terminal-content"
            aria-hidden={activeTab !== 'terminal'}
          >
            {terminalPanel}
          </div>
        )}
      </div>

      <div
        className="flex w-12 shrink-0 flex-col items-center border-l border-sidebar-border/35 bg-agent-canvas/45 px-1.5 py-2 backdrop-blur-sm dark:bg-agent-canvas/70"
        data-testid="context-panel-rail"
      >
        <div className="flex flex-col items-center gap-1 rounded-xl border border-sidebar-border/70 bg-agent-card/80 p-1 dark:border-sidebar-border/45 dark:bg-agent-card/40">
          {tabs.map((tab) => {
            const Icon = tab.icon
            const label = t(tab.labelKey)
            return (
              <button
                key={tab.id}
                type="button"
                className={cn(
                  'relative flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors',
                  activeTab === tab.id
                    ? 'bg-tech-blue-soft text-tech-blue shadow-sm ring-1 ring-tech-blue/20 dark:bg-tech-blue-soft/70 dark:ring-tech-blue/15'
                    : 'hover:bg-agent-hover/70 hover:text-sidebar-accent-foreground dark:hover:bg-agent-hover/45'
                )}
                onClick={() => {
                  if (tab.id === 'terminal') {
                    setBottomPanelTab('terminal')
                  }
                  setRightContextTab(tab.id)
                }}
                data-testid={`context-panel-tab-${tab.id}`}
                data-active={activeTab === tab.id}
                aria-label={label}
                title={label}
              >
                {activeTab === tab.id && (
                  <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
                )}
                <Icon className="h-4 w-4" />
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
