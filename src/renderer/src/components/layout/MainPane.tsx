import { useCallback, useEffect, useMemo, useState, lazy, Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import { SessionTabs } from '@/components/sessions'
import { FileViewer } from '@/components/file-viewer'
import { InlineDiffViewer, ImageDiffView } from '@/components/diff'
import { isImageFile } from '@shared/types/file-utils'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useI18n } from '@/i18n/useI18n'
import onboardingBg from '@/assets/onboarding-bg.png'
import onboardingBgDark from '@/assets/onboarding-bg-dark.png'

const SessionView = lazy(() =>
  import('@/components/sessions/SessionView').then((m) => ({
    default: m.SessionView
  }))
)
const SessionTerminalView = lazy(() =>
  import('@/components/sessions/SessionTerminalView').then((m) => ({
    default: m.SessionTerminalView
  }))
)
const MonacoDiffView = lazy(() => import('@/components/diff/MonacoDiffView'))
const WorktreeContextEditor = lazy(() =>
  import('@/components/worktrees/WorktreeContextEditor').then((m) => ({
    default: m.WorktreeContextEditor
  }))
)
interface MainPaneProps {
  children?: React.ReactNode
}

export function MainPane({ children }: MainPaneProps): React.JSX.Element {
  const { t } = useI18n()
  const selectedWorktreeId = useWorktreeStore((state) => state.selectedWorktreeId)
  const selectedConnectionId = useConnectionStore((state) => state.selectedConnectionId)
  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const isLoading = useSessionStore((state) => state.isLoading)
  const inlineConnectionSessionId = useSessionStore((state) => state.inlineConnectionSessionId)
  const activeFilePath = useFileViewerStore((state) => state.activeFilePath)
  const activeDiff = useFileViewerStore((state) => state.activeDiff)
  const contextEditorWorktreeId = useFileViewerStore((state) => state.contextEditorWorktreeId)
  const closedTerminalSessionIds = useSessionStore((state) => state.closedTerminalSessionIds)
  const ghosttyOverlaySuppressed = useLayoutStore((state) => state.ghosttyOverlaySuppressed)

  // Subscribe to session maps so terminal list stays reactive
  const sessionsByWorktree = useSessionStore((state) => state.sessionsByWorktree)
  const sessionsByConnection = useSessionStore((state) => state.sessionsByConnection)

  // Look up the runtime_id for a given session ID
  const getAgentRuntime = useCallback((sid: string | null): string | null => {
    if (!sid) return null
    const state = useSessionStore.getState()
    for (const sessions of state.sessionsByWorktree.values()) {
      const found = sessions.find((s) => s.id === sid)
      if (found) return found.runtime_id
    }
    for (const sessions of state.sessionsByConnection.values()) {
      const found = sessions.find((s) => s.id === sid)
      if (found) return found.runtime_id
    }
    return null
  }, [])

  // Collect all terminal-type sessions in the current scope.
  const terminalSessions = useMemo(() => {
    const terminals: string[] = []

    if (selectedWorktreeId) {
      const sessions = sessionsByWorktree.get(selectedWorktreeId) || []
      for (const s of sessions) {
        if (s.runtime_id === 'terminal') terminals.push(s.id)
      }
    }

    if (selectedConnectionId) {
      const sessions = sessionsByConnection.get(selectedConnectionId) || []
      for (const s of sessions) {
        if (s.runtime_id === 'terminal') terminals.push(s.id)
      }
    }

    return terminals
  }, [selectedWorktreeId, selectedConnectionId, sessionsByWorktree, sessionsByConnection])

  // Keep terminal views mounted once discovered so transient session-map churn
  // does not reset terminal UI state.
  const [mountedTerminalSessionIds, setMountedTerminalSessionIds] = useState<string[]>(() =>
    Array.from(new Set(terminalSessions))
  )

  useEffect(() => {
    setMountedTerminalSessionIds((current) => {
      const merged = [...current]
      let changed = false

      for (const sessionId of terminalSessions) {
        if (!merged.includes(sessionId)) {
          merged.push(sessionId)
          changed = true
        }
      }

      return changed ? merged : current
    })
  }, [terminalSessions])

  // Prune terminals that were explicitly closed (tab close).
  // This is the ONLY path that removes from mountedTerminalSessionIds.
  useEffect(() => {
    if (closedTerminalSessionIds.size === 0) return

    setMountedTerminalSessionIds((current) => {
      const filtered = current.filter((id) => !closedTerminalSessionIds.has(id))
      return filtered.length === current.length ? current : filtered
    })

    // Acknowledge so the signal set doesn't grow forever
    useSessionStore.getState().acknowledgeClosedTerminals(closedTerminalSessionIds)
  }, [closedTerminalSessionIds])

  // Determine which terminal session is currently visible (if any).
  // A terminal is visible when it's the active session AND no diff/file/loading overlay is on top.
  const visibleTerminalId = useMemo(() => {
    if (ghosttyOverlaySuppressed) {
      return null
    }

    // Inline connection terminal takes priority
    if (inlineConnectionSessionId && getAgentRuntime(inlineConnectionSessionId) === 'terminal') {
      if (!activeDiff && !(activeFilePath && !activeFilePath.startsWith('diff:'))) {
        return inlineConnectionSessionId
      }
    }

    // Regular active session
    if (activeSessionId && getAgentRuntime(activeSessionId) === 'terminal') {
      if (!activeDiff && !(activeFilePath && !activeFilePath.startsWith('diff:'))) {
        if (!inlineConnectionSessionId) {
          return activeSessionId
        }
      }
    }

    return null
  }, [
    activeSessionId,
    inlineConnectionSessionId,
    activeDiff,
    activeFilePath,
    getAgentRuntime,
    ghosttyOverlaySuppressed
  ])

  const handleCloseDiff = useCallback(() => {
    const filePath = useFileViewerStore.getState().activeFilePath
    if (filePath?.startsWith('diff:')) {
      useFileViewerStore.getState().closeDiffTab(filePath)
    } else {
      useFileViewerStore.getState().clearActiveDiff()
    }
  }, [])

  // Determine what to show in the main content area
  const renderContent = () => {
    if (children) {
      return children
    }

    // No worktree or connection selected - show welcome message
    if (!selectedWorktreeId && !selectedConnectionId) {
      return (
        <div className="relative flex-1 flex items-center justify-center text-muted-foreground">
          <img
            src={onboardingBg}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-30 dark:hidden"
          />
          <img
            src={onboardingBgDark}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 hidden h-full w-full object-cover opacity-40 dark:block"
          />
          <div className="relative text-center">
            <p className="text-lg font-medium">{t('mainPane.welcomeTitle')}</p>
            <p className="text-sm mt-2">{t('mainPane.welcomeDescription')}</p>
          </div>
        </div>
      )
    }

    // Loading sessions (including auto-start)
    if (isLoading) {
      return (
        <div className="flex-1 flex items-center justify-center" data-testid="session-loading">
          <div className="text-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground mt-2">{t('mainPane.loadingSessions')}</p>
          </div>
        </div>
      )
    }

    // Diff viewer is active
    if (activeDiff) {
      // Image files get their own viewer (binary diffs don't work in text editors)
      if (isImageFile(activeDiff.filePath)) {
        return (
          <ImageDiffView
            worktreePath={activeDiff.worktreePath}
            filePath={activeDiff.filePath}
            fileName={activeDiff.fileName}
            staged={activeDiff.staged}
            isUntracked={activeDiff.isUntracked}
            isNewFile={activeDiff.isNewFile}
            compareBranch={activeDiff.compareBranch}
            onClose={handleCloseDiff}
          />
        )
      }
      // New/untracked files use the syntax highlighter view (but not in branch mode —
      // branch diffs always use Monaco since we have an empty original to compare against)
      if ((activeDiff.isNewFile || activeDiff.isUntracked) && !activeDiff.compareBranch) {
        return (
          <InlineDiffViewer
            worktreePath={activeDiff.worktreePath}
            filePath={activeDiff.filePath}
            fileName={activeDiff.fileName}
            staged={activeDiff.staged}
            isUntracked={activeDiff.isUntracked}
            isNewFile={activeDiff.isNewFile}
            onClose={handleCloseDiff}
          />
        )
      }
      // Tracked files (and branch diffs) use Monaco DiffEditor with per-hunk actions
      return (
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <MonacoDiffView
            key={`${activeDiff.filePath}|${activeDiff.compareBranch ?? ''}|${activeDiff.staged}|${activeDiff.prReviewWorktreeId ?? ''}`}
            worktreePath={activeDiff.worktreePath}
            filePath={activeDiff.filePath}
            fileName={activeDiff.fileName}
            staged={activeDiff.staged}
            isUntracked={activeDiff.isUntracked}
            isNewFile={activeDiff.isNewFile}
            compareBranch={activeDiff.compareBranch}
            scrollToLine={activeDiff.scrollToLine}
            scrollTrigger={activeDiff.scrollTrigger}
            prReviewWorktreeId={activeDiff.prReviewWorktreeId}
            onClose={handleCloseDiff}
          />
        </Suspense>
      )
    }

    // Context editor is active
    if (contextEditorWorktreeId && activeFilePath?.startsWith('context:')) {
      return (
        <Suspense
          fallback={
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <WorktreeContextEditor worktreeId={contextEditorWorktreeId} />
        </Suspense>
      )
    }

    // File viewer tab is active - render FileViewer (skip diff tab keys)
    if (activeFilePath && !activeFilePath.startsWith('diff:')) {
      return <FileViewer filePath={activeFilePath} />
    }

    // Inline connection session view (sticky tab clicked in worktree mode)
    if (inlineConnectionSessionId) {
      // Terminal sessions are handled by the always-mounted section below
      if (getAgentRuntime(inlineConnectionSessionId) === 'terminal') {
        return null
      }
      return (
        <Suspense fallback={<div className="flex-1 flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}>
          <SessionView key={inlineConnectionSessionId} sessionId={inlineConnectionSessionId} />
        </Suspense>
      )
    }

    // Worktree or connection selected but no session - show create session prompt
    if (!activeSessionId) {
      return (
        <div className="relative flex-1 flex items-center justify-center text-muted-foreground">
          <img
            src={onboardingBg}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-30 dark:hidden"
          />
          <img
            src={onboardingBgDark}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 hidden h-full w-full object-cover opacity-40 dark:block"
          />
          <div className="relative text-center">
            <p className="text-lg font-medium">{t('mainPane.noActiveSessionTitle')}</p>
            <p className="text-sm mt-2">{t('mainPane.noActiveSessionDescription')}</p>
          </div>
        </div>
      )
    }

    // Session is active - dispatch based on agent SDK
    // Terminal sessions are handled by the always-mounted section below
    if (getAgentRuntime(activeSessionId) === 'terminal') {
      return null
    }
    return (
      <Suspense fallback={<div className="flex-1 flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}>
        <SessionView key={activeSessionId} sessionId={activeSessionId} />
      </Suspense>
    )
  }

  return (
    <main
      className="flex-1 flex flex-col min-w-0 bg-background overflow-hidden"
      data-testid="main-pane"
    >
      {(selectedWorktreeId || selectedConnectionId) && <SessionTabs />}
      {renderContent()}
      {/* Always-mounted terminal sessions — kept alive to preserve PTY state across tab switches */}
      {mountedTerminalSessionIds.map((sessionId) => {
        const isActive = visibleTerminalId === sessionId
        return (
          <div key={sessionId} className={isActive ? 'flex-1 flex flex-col min-h-0' : 'hidden'}>
            <Suspense fallback={<div className="flex-1 flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}>
              <SessionTerminalView sessionId={sessionId} isVisible={isActive} />
            </Suspense>
          </div>
        )
      })}
    </main>
  )
}
