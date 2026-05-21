import React, { useEffect, useMemo, useState } from 'react'
import { BarChart3, Files, GitPullRequest, ListTodo, Target, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'
import { useLayoutStore, type RightContextTab, type RightReviewTab } from '@/stores/useLayoutStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useGitStore } from '@/stores/useGitStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSessionRuntimeStore } from '@/stores/useSessionRuntimeStore'
import { useContextStore, type SessionContextUsage } from '@/stores/useContextStore'
import { FileTree } from '@/components/file-tree/FileTree'
import { ChangesView } from '@/components/file-tree/ChangesView'
import { BranchDiffView } from '@/components/file-tree/BranchDiffView'
import { DiffCommentsViewer } from '@/components/diff-comments/DiffCommentsViewer'
import { PrReviewViewer } from '@/components/pr-review/PrReviewViewer'
import { GoalStatusCard } from '@/components/session-hq/cards/GoalStatusCard'
import { TodoCard } from '@/components/session-hq/cards/TodoCard'
import { extractMissionTasks, type SessionTask } from '@/lib/session-tasks'
import type { UsageAnalyticsSessionSummary } from '@shared/types/usage-analytics'

interface ConnectionMemberInfo {
  worktree_path: string
  project_name: string
  worktree_branch: string
}

interface ContextPanelHostProps {
  worktreePath: string | null
  isConnectionMode?: boolean
  connectionMembers?: ConnectionMemberInfo[]
  onClose: () => void
  onFileClick: (node: { path: string; name: string; isDirectory: boolean }) => void
  className?: string
}

interface ContextMetric {
  label: string
  value: string
  muted?: string
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
  { id: 'goal', icon: Target, labelKey: 'contextPanel.tabs.goal' }
]

const REVIEW_TABS: Array<{ id: RightReviewTab; labelKey: string }> = [
  { id: 'changes', labelKey: 'fileTree.sidebar.changes' },
  { id: 'diffs', labelKey: 'fileTree.sidebar.diffs' },
  { id: 'comments', labelKey: 'fileTree.sidebar.comments' }
]
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

function MetricCard({ metric }: { metric: ContextMetric }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-sidebar-border/70 bg-sidebar-accent/25 px-3 py-2.5">
      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {metric.label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-sidebar-foreground">
        {metric.value}
      </div>
      {metric.muted && (
        <div className="mt-0.5 text-[11px] text-muted-foreground">{metric.muted}</div>
      )}
    </div>
  )
}

function findSessionById(state: ReturnType<typeof useSessionStore.getState>, sessionId: string) {
  for (const sessions of state.sessionsByWorktree.values()) {
    const match = sessions.find((session) => session.id === sessionId)
    if (match) return match
  }
  for (const sessions of state.sessionsByConnection.values()) {
    const match = sessions.find((session) => session.id === sessionId)
    if (match) return match
  }
  return null
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
  activeSessionId,
  worktreePath,
  usage
}: {
  activeSessionId: string | null
  worktreePath: string | null
  usage: SessionContextUsage | null
}): React.JSX.Element {
  const { t } = useI18n()
  const [summary, setSummary] = useState<UsageAnalyticsSessionSummary | null>(null)
  const activityTick = useSessionRuntimeStore((state) =>
    activeSessionId ? state.getSession(activeSessionId).lastActivityAt : 0
  )

  useEffect(() => {
    let cancelled = false

    if (!activeSessionId || !window.usageAnalyticsOps?.fetchSessionSummary) {
      setSummary(null)
      return () => {
        cancelled = true
      }
    }

    window.usageAnalyticsOps
      .fetchSessionSummary(activeSessionId)
      .then((result) => {
        if (cancelled) return
        const nextSummary = result.success && result.data ? result.data : null
        setSummary(nextSummary)
        if (nextSummary && nextSummary.total_cost > 0) {
          const store = useContextStore.getState()
          if ((store.costBySession[activeSessionId] ?? 0) < nextSummary.total_cost) {
            store.setSessionCost(activeSessionId, nextSummary.total_cost)
          }
        }
      })
      .catch(() => {
        if (!cancelled) setSummary(null)
      })

    return () => {
      cancelled = true
    }
  }, [activeSessionId, activityTick])

  if (!activeSessionId) {
    return (
      <EmptyPanel
        title={t('contextPanel.empty.noSessionTitle')}
        description={t('contextPanel.empty.noSessionDescription')}
      />
    )
  }

  const tokens = usage?.tokens
  const liveTotalTokens = tokens
    ? tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
    : 0
  const totalCost = Math.max(summary?.total_cost ?? 0, usage?.cost ?? 0)
  const totalTokens =
    summary?.total_tokens && summary.total_tokens > 0 ? summary.total_tokens : liveTotalTokens
  const inputTokens = summary?.input_tokens ?? tokens?.input ?? 0
  const outputTokens = summary?.output_tokens ?? tokens?.output ?? 0
  const cacheReadTokens = summary?.cache_read_tokens ?? tokens?.cacheRead ?? 0
  const cacheWriteTokens = summary?.cache_write_tokens ?? tokens?.cacheWrite ?? 0
  const metrics: ContextMetric[] = [
    {
      label: t('contextPanel.overview.cost'),
      value: formatCost(totalCost)
    },
    {
      label: t('contextPanel.overview.tokens'),
      value: formatCompactNumber(totalTokens),
      muted:
        usage?.limit && usage.limit > 0
          ? t('contextPanel.overview.contextLimit', {
              used: formatCompactNumber(usage.used),
              limit: formatCompactNumber(usage.limit)
            })
          : undefined
    },
    {
      label: t('contextPanel.overview.input'),
      value: formatCompactNumber(inputTokens),
      muted: `${t('contextPanel.overview.output')} ${formatCompactNumber(outputTokens)}`
    },
    {
      label: t('contextPanel.overview.cacheRead'),
      value: formatCompactNumber(cacheReadTokens),
      muted: `${t('contextPanel.overview.cacheWrite')} ${formatCompactNumber(cacheWriteTokens)}`
    }
  ]

  return (
    <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="context-panel-overview">
      <div className="grid grid-cols-2 gap-2">
        {metrics.map((metric) => (
          <MetricCard key={metric.label} metric={metric} />
        ))}
      </div>
      <div className="mt-3 rounded-lg border border-sidebar-border/70 bg-sidebar-accent/20 px-3 py-2.5">
        <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {t('contextPanel.overview.worktree')}
        </div>
        <div className="mt-1 truncate font-mono text-xs text-sidebar-foreground">
          {worktreePath ?? t('contextPanel.empty.noWorktree')}
        </div>
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

function ReviewPanel({
  worktreePath,
  isConnectionMode,
  connectionMembers
}: Pick<
  ContextPanelHostProps,
  'worktreePath' | 'isConnectionMode' | 'connectionMembers'
>): React.JSX.Element {
  const { t } = useI18n()
  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId)
  const activeReviewTab = useLayoutStore((s) => s.rightReviewTab)
  const setRightReviewTab = useLayoutStore((s) => s.setRightReviewTab)
  const hasAttachedPR = useGitStore(
    (s) => !!(selectedWorktreeId && s.attachedPR.get(selectedWorktreeId))
  )
  const effectiveReviewTab =
    !selectedWorktreeId && activeReviewTab === 'comments' ? 'changes' : activeReviewTab

  useEffect(() => {
    if (!selectedWorktreeId && activeReviewTab === 'comments') {
      setRightReviewTab('changes')
    }
  }, [activeReviewTab, selectedWorktreeId, setRightReviewTab])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="context-panel-review">
      <div className="border-b border-sidebar-border/60 px-2.5 py-2">
        <div className="inline-flex min-w-max items-center gap-1 rounded-lg bg-sidebar-accent/40 p-0.5">
          {REVIEW_TABS.map((tab) => {
            if (tab.id === 'comments' && !selectedWorktreeId) return null
            return (
              <button
                key={tab.id}
                type="button"
                className={cn(
                  'shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                  effectiveReviewTab === tab.id
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
                )}
                onClick={() => setRightReviewTab(tab.id)}
                data-testid={`context-panel-review-${tab.id}`}
              >
                {t(tab.labelKey)}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {effectiveReviewTab === 'comments' && selectedWorktreeId ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <DiffCommentsViewer
              worktreeId={selectedWorktreeId}
              worktreePath={worktreePath}
              compact={hasAttachedPR}
            />
            {hasAttachedPR && <PrReviewViewer worktreeId={selectedWorktreeId} />}
          </div>
        ) : effectiveReviewTab === 'diffs' ? (
          <BranchDiffView worktreePath={worktreePath} />
        ) : (
          <ChangesView
            worktreePath={worktreePath}
            isConnectionMode={isConnectionMode}
            connectionMembers={connectionMembers}
          />
        )}
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

export function ContextPanelHost({
  worktreePath,
  isConnectionMode,
  connectionMembers,
  onClose,
  onFileClick,
  className
}: ContextPanelHostProps): React.JSX.Element {
  const { t } = useI18n()
  const activeTab = useLayoutStore((s) => s.rightContextTab)
  const setRightContextTab = useLayoutStore((s) => s.setRightContextTab)
  const setRightReviewTab = useLayoutStore((s) => s.setRightReviewTab)
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)
  const activeSessionId = useSessionStore((s) => s.inlineConnectionSessionId ?? s.activeSessionId)
  const activeSession = useSessionStore((s) => {
    const sessionId = s.inlineConnectionSessionId ?? s.activeSessionId
    return sessionId ? findSessionById(s, sessionId) : null
  })
  const contextState = useContextStore()
  const usage = activeSessionId
    ? contextState.getContextUsage(
        activeSessionId,
        activeSession?.model_id ?? '',
        activeSession?.model_provider_id ?? undefined
      )
    : null

  useEffect(() => {
    const handler = (event: Event): void => {
      if (!vimModeEnabled) return
      const tab = (event as CustomEvent).detail?.tab
      if (tab === 'files') {
        setRightContextTab('files')
        return
      }
      if (tab === 'changes' || tab === 'diffs' || tab === 'comments') {
        setRightContextTab('review')
        setRightReviewTab(tab)
      }
    }
    window.addEventListener('hive:right-sidebar-tab', handler)
    return () => window.removeEventListener('hive:right-sidebar-tab', handler)
  }, [setRightContextTab, setRightReviewTab, vimModeEnabled])

  const content = useMemo(() => {
    switch (activeTab) {
      case 'overview':
        return (
          <OverviewPanel
            activeSessionId={activeSessionId}
            worktreePath={worktreePath}
            usage={usage}
          />
        )
      case 'review':
        return (
          <ReviewPanel
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
    }
  }, [
    activeSessionId,
    activeTab,
    connectionMembers,
    isConnectionMode,
    onClose,
    onFileClick,
    usage,
    worktreePath
  ])

  return (
    <div
      className={cn('flex h-full flex-col bg-transparent', className)}
      data-testid="context-panel-host"
    >
      <div className="flex items-center gap-2 border-b border-sidebar-border/60 px-2.5 py-2">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="inline-flex min-w-max items-center gap-1 rounded-lg bg-sidebar-accent/40 p-0.5">
            {CONTEXT_TABS.map((tab) => {
              const Icon = tab.icon
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                    activeTab === tab.id
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
                  )}
                  onClick={() => setRightContextTab(tab.id)}
                  data-testid={`context-panel-tab-${tab.id}`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(tab.labelKey)}
                </button>
              )
            })}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          aria-label={t('fileTree.sidebar.closeSidebar')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent">{content}</div>
    </div>
  )
}
