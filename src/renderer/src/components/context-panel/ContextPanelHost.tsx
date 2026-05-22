import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  BarChart3,
  Files,
  GitPullRequest,
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
import type { UsageAnalyticsSessionSummary } from '@shared/types/usage-analytics'

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

function idsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((id, index) => id === b[index])
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

function OverviewTokenRow({
  label,
  amount,
  value,
  max,
  tone = 'default'
}: {
  label: string
  amount: number
  value: string
  max: number
  tone?: 'mint' | 'lavender' | 'muted'
}): React.JSX.Element {
  const percent =
    max > 0 && Number.isFinite(amount) && amount > 0 ? Math.max(3, (amount / max) * 100) : 0

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">
          {label}
        </div>
        <div
          className={cn(
            'shrink-0 font-mono text-xs font-medium tabular-nums',
            tone === 'muted' ? 'text-muted-foreground/80' : 'text-steel'
          )}
        >
          {value}
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-neon-mint-soft/80">
        <div
          className={cn(
            'h-full rounded-full',
            tone === 'mint'
              ? 'bg-neon-mint'
              : tone === 'lavender'
                ? 'bg-neon-violet/75'
                : 'bg-steel/25'
          )}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>
    </div>
  )
}

function OverviewHeroMetric({
  label,
  value,
  tone = 'default'
}: {
  label: string
  value: string
  tone?: 'default' | 'cost' | 'tokens'
}): React.JSX.Element {
  return (
    <div className="relative flex min-w-0 flex-col gap-1 overflow-hidden rounded-[10px] border border-sidebar-border bg-agent-card px-3.5 py-2">
      <div
        className={cn(
          'absolute left-0 right-0 top-0 h-0.5',
          tone === 'cost' ? 'bg-neon-pink' : tone === 'tokens' ? 'bg-neon-mint' : 'bg-tech-blue'
        )}
      />
      <div className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/85">
        {label}
      </div>
      <div
        className={cn(
          'shrink-0 whitespace-nowrap font-mono text-[24px] font-semibold leading-none tabular-nums tracking-tight',
          tone === 'cost' ? 'text-neon-pink' : tone === 'tokens' ? 'text-neon-mint' : 'text-ink'
        )}
      >
        {value}
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

function OverviewPanel({
  sessionIds,
  worktreePath,
  scopeLabel
}: {
  sessionIds: string[]
  worktreePath: string | null
  scopeLabel: string
}): React.JSX.Element {
  const { t } = useI18n()
  const sessionIdsKey = sessionIds.join('|')
  const [summaryBySession, setSummaryBySession] = useState<
    Record<string, UsageAnalyticsSessionSummary>
  >({})
  const summaryBySessionRef = useRef(summaryBySession)
  const activityTick = useSessionRuntimeStore((state) =>
    sessionIds.map((sessionId) => state.sessions.get(sessionId)?.lastActivityAt ?? 0).join('|')
  )
  const { tokensBySession, costBySession } = useContextStore(
    useShallow((state) => ({
      tokensBySession: state.tokensBySession,
      costBySession: state.costBySession
    }))
  )

  useEffect(() => {
    summaryBySessionRef.current = summaryBySession
  }, [summaryBySession])

  useEffect(() => {
    let cancelled = false

    if (sessionIds.length === 0 || !window.usageAnalyticsOps?.fetchSessionSummary) {
      setSummaryBySession({})
      return () => {
        cancelled = true
      }
    }

    Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          const result = await window.usageAnalyticsOps.fetchSessionSummary(sessionId)
          if (!result.success || !result.data) return null
          return [sessionId, result.data] as const
        } catch {
          return null
        }
      })
    )
      .then((entries) => {
        if (cancelled) return

        const next: Record<string, UsageAnalyticsSessionSummary> = {}
        const store = useContextStore.getState()
        for (const entry of entries) {
          if (!entry) continue
          const [sessionId, summary] = entry
          next[sessionId] = summary
          if (
            summary.total_cost > 0 &&
            (store.costBySession[sessionId] ?? 0) < summary.total_cost
          ) {
            store.setSessionCost(sessionId, summary.total_cost)
          }
        }
        if (
          Object.keys(next).length === 0 &&
          Object.keys(summaryBySessionRef.current).length === 0
        ) {
          return
        }
        setSummaryBySession(next)
      })
      .catch(() => {
        if (!cancelled) setSummaryBySession({})
      })

    return () => {
      cancelled = true
    }
  }, [activityTick, sessionIds, sessionIdsKey])

  if (!worktreePath && sessionIds.length === 0) {
    return (
      <EmptyPanel
        title={t('contextPanel.empty.noWorktree')}
        description={t('contextPanel.empty.noSessionDescription')}
      />
    )
  }

  const totals = sessionIds.reduce(
    (acc, sessionId) => {
      const summary = summaryBySession[sessionId]
      const tokens = tokensBySession[sessionId]
      const liveTotalTokens = tokens
        ? tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
        : 0

      acc.totalCost += Math.max(summary?.total_cost ?? 0, costBySession[sessionId] ?? 0)
      acc.totalTokens += Math.max(summary?.total_tokens ?? 0, liveTotalTokens)
      acc.inputTokens += Math.max(summary?.input_tokens ?? 0, tokens?.input ?? 0)
      acc.outputTokens += Math.max(summary?.output_tokens ?? 0, tokens?.output ?? 0)
      acc.cacheReadTokens += Math.max(summary?.cache_read_tokens ?? 0, tokens?.cacheRead ?? 0)
      acc.cacheWriteTokens += Math.max(summary?.cache_write_tokens ?? 0, tokens?.cacheWrite ?? 0)
      return acc
    },
    {
      totalCost: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    }
  )
  const maxTokenSlice = Math.max(
    totals.inputTokens,
    totals.outputTokens,
    totals.cacheReadTokens,
    totals.cacheWriteTokens,
    1
  )
  const tokenRows = [
    {
      label: t('contextPanel.overview.input'),
      amount: totals.inputTokens,
      tone: 'mint' as const
    },
    {
      label: t('contextPanel.overview.output'),
      amount: totals.outputTokens,
      tone: 'lavender' as const
    },
    {
      label: t('contextPanel.overview.cacheRead'),
      amount: totals.cacheReadTokens,
      tone: 'muted' as const
    },
    {
      label: t('contextPanel.overview.cacheWrite'),
      amount: totals.cacheWriteTokens,
      tone: 'muted' as const
    }
  ]

  return (
    <div className="min-h-0 flex-1 overflow-auto px-2.5 py-3" data-testid="context-panel-overview">
      <div className="space-y-2.5">
        <section className="crisp-floating-surface relative overflow-hidden rounded-xl p-3">
          <div className="pointer-events-none absolute -right-12 -top-12 h-28 w-28 rounded-full bg-tech-blue-soft blur-2xl" />
          <div className="relative min-w-0">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-steel">
                {scopeLabel} · {t('contextPanel.tabs.overview')}
              </div>
              <div className="mt-1.5 truncate text-[11px] text-muted-foreground">
                {t('contextPanel.overview.sessionCount', {
                  count: sessionIds.length,
                  scope: scopeLabel
                })}
              </div>
            </div>
          </div>

          <div className="relative mt-3 space-y-1.5">
            <OverviewHeroMetric
              label={t('contextPanel.overview.cost')}
              value={formatCost(totals.totalCost)}
              tone="cost"
            />
            <OverviewHeroMetric
              label={t('contextPanel.overview.tokens')}
              value={formatCompactNumber(totals.totalTokens)}
              tone="tokens"
            />
          </div>
        </section>

        <section className="crisp-panel-surface rounded-xl p-3">
          <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {t('contextPanel.overview.tokens')}
          </div>
          <div className="space-y-2.5">
            {tokenRows.map((row) => (
              <OverviewTokenRow
                key={row.label}
                label={row.label}
                amount={row.amount}
                value={formatCompactNumber(row.amount)}
                max={maxTokenSlice}
                tone={row.tone}
              />
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-sidebar-border bg-agent-card px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {scopeLabel}
            </div>
            <div className="text-[10px] font-medium text-muted-foreground">
              {t('contextPanel.overview.sessions')}: {formatCompactNumber(sessionIds.length)}
            </div>
          </div>
          <div className="mt-1.5 break-all font-mono text-[11px] leading-relaxed text-steel">
            {worktreePath ?? t('contextPanel.empty.noWorktree')}
          </div>
        </section>
      </div>
    </div>
  )
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
    <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="context-panel-tasks">
      <TodoCard tasks={tasks} />
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
  const cachedOverviewSessionIds = useSessionStore(
    useShallow((s) => {
      const sessions = overviewScopeId
        ? isConnectionMode
          ? (s.sessionsByConnection.get(overviewScopeId) ?? [])
          : (s.sessionsByWorktree.get(overviewScopeId) ?? [])
        : []
      const ids = sessions.map((session) => session.id)
      if (ids.length > 0) return ids
      return activeSessionId ? [activeSessionId] : []
    })
  )
  const cachedOverviewSessionIdsKey = cachedOverviewSessionIds.join('|')
  const [overviewSessionIds, setOverviewSessionIds] = useState<string[]>(cachedOverviewSessionIds)
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

    setOverviewSessionIds((current) =>
      idsEqual(current, cachedOverviewSessionIds) ? current : cachedOverviewSessionIds
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
        const ids = sessions.map((session) => session.id)
        const nextIds = ids.length > 0 ? ids : cachedOverviewSessionIds
        setOverviewSessionIds((current) => (idsEqual(current, nextIds) ? current : nextIds))
      })
      .catch(() => {
        if (cancelled) return
        setOverviewSessionIds((current) =>
          idsEqual(current, cachedOverviewSessionIds) ? current : cachedOverviewSessionIds
        )
      })

    return () => {
      cancelled = true
    }
  }, [cachedOverviewSessionIds, cachedOverviewSessionIdsKey, isConnectionMode, overviewScopeId])

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
            sessionIds={overviewSessionIds}
            worktreePath={worktreePath}
            scopeLabel={overviewScopeLabel}
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
    overviewSessionIds,
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
