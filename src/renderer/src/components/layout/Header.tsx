import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isMac } from '@/lib/platform'
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Settings,
  AlertTriangle,
  Loader2,
  Zap
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useGitStore } from '@/stores/useGitStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useVimModeStore } from '@/stores/useVimModeStore'
import { useContextStore } from '@/stores/useContextStore'
import { useSessionRuntimeStore, type SessionLifecycle } from '@/stores/useSessionRuntimeStore'
import { ModelSelector } from '@/components/sessions/ModelSelector'
import { SessionTabs } from '@/components/sessions/SessionTabs'
import { BudgetBar } from '@/components/sessions/budget-bar'
import { ErrorBoundary } from '@/components/error'

import { usePRDetection } from '@/hooks/usePRDetection'
import appLogo from '@/assets/icon.png'
import { useI18n } from '@/i18n/useI18n'

type ConflictFixFlow =
  | {
      phase: 'starting'
      worktreePath: string
    }
  | {
      phase: 'running'
      worktreePath: string
      sessionId: string
      seenBusy: boolean
    }
  | {
      phase: 'refreshing'
      worktreePath: string
    }

function isConflictFixActiveStatus(status: string | null): boolean {
  return (
    status === 'working' ||
    status === 'planning' ||
    status === 'answering' ||
    status === 'command_approval' ||
    status === 'permission'
  )
}

type HeaderSessionGlanceSession = {
  id: string
  name: string | null
  agent_sdk: string
  model_id: string | null
  model_provider_id: string | null
}

type HeaderContextMeter = {
  percent: number | null
  used: number
  limit: number | null
  isRefreshing: boolean
}

const HEADER_PROVIDER_LABELS: Record<string, string> = {
  'claude-code': 'Claude',
  opencode: 'OpenCode',
  codex: 'Codex'
}

const HEADER_LIFECYCLE_DOT: Record<SessionLifecycle, string> = {
  idle: 'bg-muted-foreground/45',
  busy: 'bg-neon-mint crisp-status-dot animate-pulse',
  retry: 'bg-neon-violet crisp-status-dot animate-pulse',
  error: 'bg-neon-pink crisp-status-dot',
  materializing: 'bg-tech-blue crisp-status-dot animate-pulse'
}

function getHeaderProviderLabel(sdk: string, t: ReturnType<typeof useI18n>['t']): string {
  if (sdk === 'terminal') return t('bottomPanel.tabs.terminal')
  return HEADER_PROVIDER_LABELS[sdk] ?? sdk
}

function getHeaderLifecycleLabel(
  lifecycle: SessionLifecycle,
  t: ReturnType<typeof useI18n>['t']
): string {
  return t(`sessionHq.header.lifecycle.${lifecycle}`)
}

function formatHeaderTokens(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(Math.round(value))
}

function formatHeaderCost(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null
  return `$${value.toFixed(4)}`
}

function safeTokenValue(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

function getHeaderContextPercent(used: number, limit: number | undefined, percent: number | null) {
  if (typeof percent === 'number' && Number.isFinite(percent)) return clampPercent(percent)
  if (typeof limit === 'number' && limit > 0 && used > 0) return clampPercent((used / limit) * 100)
  return null
}

function getHeaderContextTitle(
  context: HeaderContextMeter,
  t: ReturnType<typeof useI18n>['t']
): string {
  const usedLabel = formatHeaderTokens(context.used) ?? '0'
  const limitLabel = context.limit ? formatHeaderTokens(context.limit) : null
  const percentLabel = context.percent == null ? null : `${context.percent}%`
  const parts = [
    t('sessionHq.header.context'),
    percentLabel,
    limitLabel && `${usedLabel}/${limitLabel}`
  ]
    .filter(Boolean)
    .join(' · ')
  return context.isRefreshing ? `${parts} · ${t('sessionHq.header.compressingContext')}` : parts
}

function HeaderSessionGlance({
  session,
  lifecycle,
  totalCost,
  context
}: {
  session: HeaderSessionGlanceSession
  lifecycle: SessionLifecycle
  totalCost: number
  context: HeaderContextMeter | null
}): React.JSX.Element {
  const { t } = useI18n()
  const sessionTitle = session.name || t('sessionTabs.common.untitled')
  const providerLabel = getHeaderProviderLabel(session.agent_sdk, t)
  const lifecycleLabel = getHeaderLifecycleLabel(lifecycle, t)
  const costLabel = formatHeaderCost(totalCost)
  const contextFillPercent =
    context?.percent ?? (context && (context.used > 0 || context.isRefreshing) ? 18 : 0)

  return (
    <div
      className="crisp-panel-surface crisp-subtle-shadow hidden h-8 min-w-0 shrink-0 items-center gap-2 rounded-lg bg-agent-card/90 px-2 text-[11px] text-muted-foreground backdrop-blur-md lg:flex"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      data-testid="header-session-glance"
      title={`${sessionTitle} · ${providerLabel} · ${lifecycleLabel}`}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', HEADER_LIFECYCLE_DOT[lifecycle])} />
      <span className="shrink-0 font-medium text-foreground/85">{providerLabel}</span>
      {session.agent_sdk !== 'terminal' && (
        <ModelSelector sessionId={session.id} compact showProviderPrefix={false} />
      )}
      <span className="shrink-0 rounded-full bg-background/55 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        {lifecycleLabel}
      </span>
      {context && (
        <div
          className="flex h-6 w-16 shrink-0 items-center rounded-full border border-border/60 bg-agent-card px-1.5"
          title={getHeaderContextTitle(context, t)}
          data-testid="header-context-meter"
          aria-label={getHeaderContextTitle(context, t)}
        >
          <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className={cn(
                'block h-full rounded-full bg-neon-mint transition-[width] duration-300',
                context.percent == null && 'bg-muted-foreground/35',
                context.isRefreshing && 'animate-pulse'
              )}
              style={{ width: `${contextFillPercent}%` }}
              data-testid="header-context-meter-fill"
            />
          </span>
        </div>
      )}
      {session.agent_sdk === 'xuanpu-agent' && <BudgetBar sessionId={session.id} />}
      {costLabel && (
        <span
          className="shrink-0 rounded-full border border-neon-pink/20 bg-neon-pink-soft px-1.5 py-0.5 font-mono text-[10px] text-neon-pink dark:bg-neon-pink-soft/40"
          title={t('sessionView.costPill.title')}
          data-testid="header-cost-pill"
        >
          {costLabel}
        </span>
      )}
    </div>
  )
}

function HeaderSessionGlanceFallback({
  session,
  lifecycle
}: {
  session: HeaderSessionGlanceSession
  lifecycle: SessionLifecycle
}): React.JSX.Element {
  const { t } = useI18n()
  const sessionTitle = session.name || t('sessionTabs.common.untitled')
  const providerLabel = getHeaderProviderLabel(session.agent_sdk, t)
  const lifecycleLabel = getHeaderLifecycleLabel(lifecycle, t)

  return (
    <div
      className="crisp-panel-surface hidden h-8 min-w-0 shrink-0 items-center gap-2 rounded-lg bg-agent-card/90 px-2 text-[11px] text-muted-foreground lg:flex"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      data-testid="header-session-glance-fallback"
      title={`${sessionTitle} · ${providerLabel} · ${lifecycleLabel}`}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', HEADER_LIFECYCLE_DOT[lifecycle])} />
      <span className="shrink-0 font-medium text-foreground/85">{providerLabel}</span>
      <span className="shrink-0 rounded-full bg-background/55 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        {lifecycleLabel}
      </span>
    </div>
  )
}

export function Header(): React.JSX.Element {
  const { leftSidebarCollapsed, rightSidebarCollapsed, toggleLeftSidebar, toggleRightSidebar } =
    useLayoutStore()
  const openSettings = useSettingsStore((s) => s.openSettings)
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId)
  const projects = useProjectStore((s) => s.projects)
  const { selectedWorktreeId, worktreesByProject } = useWorktreeStore()
  const createSession = useSessionStore((s) => s.createSession)
  const updateSessionName = useSessionStore((s) => s.updateSessionName)
  const setPendingMessage = useSessionStore((s) => s.setPendingMessage)
  const setActiveSession = useSessionStore((s) => s.setActiveSession)
  const vimMode = useVimModeStore((s) => s.mode)
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)
  const keepAwakeEnabled = useSettingsStore((s) => s.keepAwakeEnabled)
  const sessionStatuses = useWorktreeStatusStore((s) => s.sessionStatuses)
  const getWorktreeStatus = useWorktreeStatusStore((s) => s.getWorktreeStatus)
  const getConnectionStatus = useWorktreeStatusStore((s) => s.getConnectionStatus)
  const activeHeaderSession = useSessionStore(
    useShallow((state) => {
      const activeId = state.inlineConnectionSessionId ?? state.activeSessionId
      if (!activeId) return null

      const sessionsByWorktree =
        state.sessionsByWorktree instanceof Map ? state.sessionsByWorktree : new Map()
      const sessionsByConnection =
        state.sessionsByConnection instanceof Map ? state.sessionsByConnection : new Map()

      for (const sessions of sessionsByWorktree.values()) {
        const match = sessions.find((session) => session.id === activeId)
        if (match) {
          return {
            id: match.id,
            name: match.name,
            agent_sdk: match.agent_sdk,
            model_id: match.model_id,
            model_provider_id: match.model_provider_id
          }
        }
      }

      for (const sessions of sessionsByConnection.values()) {
        const match = sessions.find((session) => session.id === activeId)
        if (match) {
          return {
            id: match.id,
            name: match.name,
            agent_sdk: match.agent_sdk,
            model_id: match.model_id,
            model_provider_id: match.model_provider_id
          }
        }
      }

      return null
    })
  )
  const activeHeaderLifecycle = useSessionRuntimeStore((state) =>
    activeHeaderSession ? (state.sessions.get(activeHeaderSession.id)?.lifecycle ?? 'idle') : 'idle'
  )
  const activeHeaderUsage = useContextStore(
    useShallow((state) => {
      if (!activeHeaderSession) {
        return {
          totalCost: 0,
          contextUsed: 0,
          contextLimit: null,
          contextPercent: null,
          contextRefreshing: false,
          hasContext: false
        }
      }

      const tokens = state.tokensBySession[activeHeaderSession.id]
      const fallbackUsedTokens = tokens
        ? safeTokenValue(tokens.input) +
          safeTokenValue(tokens.output) +
          safeTokenValue(tokens.reasoning) +
          safeTokenValue(tokens.cacheRead) +
          safeTokenValue(tokens.cacheWrite)
        : 0
      const usage = state.getContextUsage(
        activeHeaderSession.id,
        activeHeaderSession.model_id ?? '',
        activeHeaderSession.model_provider_id ?? undefined
      )
      const used = usage.used > 0 ? usage.used : fallbackUsedTokens
      const limit = typeof usage.limit === 'number' && usage.limit > 0 ? usage.limit : null
      const percent = getHeaderContextPercent(used, limit ?? undefined, usage.percent)

      return {
        totalCost: state.costBySession[activeHeaderSession.id] ?? 0,
        contextUsed: used,
        contextLimit: limit,
        contextPercent: percent,
        contextRefreshing: usage.isRefreshing,
        hasContext: used > 0 || percent != null || usage.isRefreshing
      }
    })
  )
  const activeHeaderContext = activeHeaderUsage.hasContext
    ? {
        percent: activeHeaderUsage.contextPercent,
        used: activeHeaderUsage.contextUsed,
        limit: activeHeaderUsage.contextLimit,
        isRefreshing: activeHeaderUsage.contextRefreshing
      }
    : null
  const [conflictFixFlow, setConflictFixFlow] = useState<ConflictFixFlow | null>(null)
  const { t } = useI18n()

  // Monitor PR session stream events for PR URL detection
  usePRDetection(selectedWorktreeId)

  const selectedProject = projects.find((p) => p.id === selectedProjectId)
  const selectedWorktree = (() => {
    if (!selectedWorktreeId) return null
    for (const worktrees of worktreesByProject.values()) {
      const wt = worktrees.find((w) => w.id === selectedWorktreeId)
      if (wt) return wt
    }
    return null
  })()

  // Connection mode detection
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId)
  const selectedConnection = useConnectionStore((s) =>
    selectedConnectionId
      ? s.connections.find((connection) => connection.id === selectedConnectionId)
      : null
  )
  const isConnectionMode = !!selectedConnectionId && !selectedWorktreeId
  const connectionProjects =
    selectedConnection?.members
      .map((member) => member.project_name)
      .filter((name, index, names) => name && names.indexOf(name) === index)
      .join(' + ') ?? ''
  const isKeepAwakeActive = useMemo(() => {
    if (!Object.values(sessionStatuses).some(Boolean)) {
      return false
    }

    for (const worktrees of worktreesByProject.values()) {
      for (const worktree of worktrees) {
        const status = getWorktreeStatus(worktree.id)
        if (status === 'planning' || status === 'working') {
          return true
        }
      }
    }

    if (selectedConnectionId) {
      const status = getConnectionStatus(selectedConnectionId)
      if (status === 'planning' || status === 'working') {
        return true
      }
    }

    return false
  }, [
    worktreesByProject,
    selectedConnectionId,
    sessionStatuses,
    getConnectionStatus,
    getWorktreeStatus
  ])

  const hasConflicts = useGitStore(
    (state) =>
      (selectedWorktree?.path ? state.conflictsByWorktree[selectedWorktree.path] : false) ?? false
  )

  const conflictFixSessionStatus = useWorktreeStatusStore((state) =>
    conflictFixFlow?.phase === 'running'
      ? (state.sessionStatuses[conflictFixFlow.sessionId]?.status ?? null)
      : null
  )

  // Clear conflict fix flow as soon as conflicts are resolved
  useEffect(() => {
    if (!hasConflicts && conflictFixFlow) {
      setConflictFixFlow(null)
    }
  }, [hasConflicts, conflictFixFlow])

  useEffect(() => {
    if (!conflictFixFlow || conflictFixFlow.phase !== 'running') return

    const isBusy = isConflictFixActiveStatus(conflictFixSessionStatus)

    if (isBusy && !conflictFixFlow.seenBusy) {
      setConflictFixFlow((prev) =>
        prev && prev.phase === 'running' ? { ...prev, seenBusy: true } : prev
      )
      return
    }

    const shouldFinalize =
      (conflictFixFlow.seenBusy && !isBusy) ||
      (!conflictFixFlow.seenBusy && conflictFixSessionStatus === 'completed')

    if (!shouldFinalize) return

    let cancelled = false
    const finishConflictRun = async (): Promise<void> => {
      setConflictFixFlow((prev) =>
        prev && prev.phase === 'running'
          ? { phase: 'refreshing', worktreePath: prev.worktreePath }
          : prev
      )

      try {
        await useGitStore.getState().refreshStatuses(conflictFixFlow.worktreePath)
      } finally {
        if (!cancelled) {
          setConflictFixFlow((prev) =>
            prev?.worktreePath === conflictFixFlow.worktreePath ? null : prev
          )
        }
      }
    }

    void finishConflictRun()

    return () => {
      cancelled = true
    }
  }, [conflictFixFlow, conflictFixSessionStatus])

  const handleFixConflicts = async () => {
    if (!selectedWorktreeId || !selectedProjectId || !selectedWorktree?.path) return

    setConflictFixFlow({
      phase: 'starting',
      worktreePath: selectedWorktree.path
    })

    const { success, session } = await createSession(selectedWorktreeId, selectedProjectId)
    if (!success || !session) {
      setConflictFixFlow(null)
      return
    }

    const branchName = selectedWorktree?.branch_name || t('gitStatusPanel.unknownBranch')
    await updateSessionName(session.id, t('header.sessionNames.conflicts', { branch: branchName }))
    setPendingMessage(session.id, 'Fix merge conflicts')
    setActiveSession(session.id)

    setConflictFixFlow({
      phase: 'running',
      worktreePath: selectedWorktree.path,
      sessionId: session.id,
      seenBusy: false
    })
  }

  const isFixConflictsLoading =
    !!selectedWorktree?.path &&
    !!conflictFixFlow &&
    conflictFixFlow.worktreePath === selectedWorktree.path

  const showFixConflictsButton = hasConflicts || isFixConflictsLoading
  const showTopbarTabs = Boolean(selectedWorktreeId || selectedConnectionId)

  return (
    <header
      className="relative h-10 border-b border-border/45 bg-background/75 backdrop-blur-xl flex items-center gap-2 px-3 flex-shrink-0 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      data-testid="header"
    >
      {/* Spacer for macOS traffic lights */}
      {isMac() && <div className="w-[70px] flex-shrink-0" />}
      <Button
        onClick={toggleLeftSidebar}
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:bg-muted/55 hover:text-foreground"
        title={
          leftSidebarCollapsed ? t('header.controls.showSidebar') : t('header.controls.hideSidebar')
        }
        data-testid="left-sidebar-toggle"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {leftSidebarCollapsed ? (
          <PanelLeftOpen className="h-3.5 w-3.5" />
        ) : (
          <PanelLeftClose className="h-3.5 w-3.5" />
        )}
      </Button>
      <div
        className={cn(
          'crisp-panel-surface flex h-7 min-w-0 items-center gap-2.5 rounded-lg bg-agent-card/85 px-2.5',
          showTopbarTabs ? 'max-w-[190px]' : 'max-w-[360px] flex-1'
        )}
      >
        <img
          src={appLogo}
          alt="Xuanpu"
          className="h-[18px] w-[18px] shrink-0 rounded-[5px]"
          draggable={false}
        />
        {isConnectionMode && selectedConnection ? (
          <div className="flex min-w-0 items-baseline gap-1.5" data-testid="header-connection-info">
            <div className="truncate text-xs font-semibold">{selectedConnection.name}</div>
            {connectionProjects && !showTopbarTabs && (
              <div className="truncate text-[10px] text-muted-foreground">
                ({connectionProjects})
              </div>
            )}
          </div>
        ) : selectedProject ? (
          <div className="flex min-w-0 items-baseline gap-1.5" data-testid="header-project-info">
            <div className="truncate text-xs font-semibold">{selectedProject.name}</div>
            {!showTopbarTabs &&
              selectedWorktree?.branch_name &&
              selectedWorktree.branch_name !== '(no-worktree)' &&
              selectedWorktree.branch_name !== selectedProject.name && (
                <div className="truncate text-[10px] text-muted-foreground">
                  ({selectedWorktree.branch_name})
                </div>
              )}
          </div>
        ) : (
          <span className="truncate text-xs font-semibold">Xuanpu</span>
        )}
      </div>
      {showTopbarTabs && (
        <div
          className="min-w-[180px] flex-1"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <SessionTabs variant="topbar" />
        </div>
      )}
      <div
        className="ml-auto flex min-w-0 items-center gap-2"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {/*
         * Session glance is intentionally right-aligned in the merged topbar:
         * tabs own the main horizontal span while provider/model/cost remain
         * compact low-frequency widgets.
         */}
        {vimModeEnabled && (
          <span
            className={cn(
              'text-[9px] font-mono px-1.5 py-0.5 rounded-md border select-none',
              vimMode === 'normal'
                ? 'text-muted-foreground bg-muted/50 border-border/50'
                : 'text-primary bg-primary/10 border-primary/30'
            )}
            data-testid="vim-mode-pill"
          >
            {vimMode === 'normal' ? 'NORMAL' : 'INSERT'}
          </span>
        )}
        {activeHeaderSession && (
          <ErrorBoundary
            componentName="HeaderSessionGlance"
            fallback={
              <HeaderSessionGlanceFallback
                session={activeHeaderSession}
                lifecycle={activeHeaderLifecycle}
              />
            }
          >
            <HeaderSessionGlance
              session={activeHeaderSession}
              lifecycle={activeHeaderLifecycle}
              totalCost={activeHeaderUsage.totalCost}
              context={activeHeaderContext}
            />
          </ErrorBoundary>
        )}
      </div>
      {!isConnectionMode && showFixConflictsButton && (
        <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <Button
            size="sm"
            variant="destructive"
            className="h-7 text-xs font-semibold"
            onClick={handleFixConflicts}
            disabled={isFixConflictsLoading}
            data-testid="fix-conflicts-button"
          >
            {isFixConflictsLoading ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5 mr-1" />
            )}
            {isFixConflictsLoading
              ? t('header.controls.fixingConflicts')
              : t('header.controls.fixConflicts')}
          </Button>
        </div>
      )}
      <div
        className="flex items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/55"
          onClick={() => openSettings()}
          title={t('header.controls.settingsTitle')}
          data-testid="settings-toggle"
        >
          <Settings className="h-3.5 w-3.5" />
        </Button>
        {keepAwakeEnabled && (
          <div
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground',
              isKeepAwakeActive && 'text-neon-mint'
            )}
            title={t(
              isKeepAwakeActive
                ? 'header.controls.keepAwakeActiveTitle'
                : 'header.controls.keepAwakeIdleTitle'
            )}
            data-testid="keep-awake-indicator"
          >
            <Zap className="h-3.5 w-3.5" />
          </div>
        )}
        <Button
          onClick={toggleRightSidebar}
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/55"
          title={
            rightSidebarCollapsed
              ? t('header.controls.showSidebar')
              : t('header.controls.hideSidebar')
          }
          data-testid="right-sidebar-toggle"
        >
          {rightSidebarCollapsed ? (
            <PanelRightOpen className="h-3.5 w-3.5" />
          ) : (
            <PanelRightClose className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </header>
  )
}
