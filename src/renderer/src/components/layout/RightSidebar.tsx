import { useMemo } from 'react'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { ResizeHandle } from './ResizeHandle'
import { ContextPanelHost } from '@/components/context-panel/ContextPanelHost'
import { BottomPanel } from './BottomPanel'
import { TerminalManager } from '@/components/terminal/TerminalManager'
import { ErrorBoundary, ErrorFallback } from '@/components/error'
import { useI18n } from '@/i18n/useI18n'

export function RightSidebar(): React.JSX.Element {
  const { t } = useI18n()
  const { rightSidebarWidth, rightSidebarCollapsed, setRightSidebarWidth, toggleRightSidebar } =
    useLayoutStore()
  const bottomPanelTab = useLayoutStore((s) => s.bottomPanelTab)
  const rightContextTab = useLayoutStore((s) => s.rightContextTab)
  const terminalDock = useLayoutStore((s) => s.terminalDock)

  const { selectedWorktreeId, worktreesByProject } = useWorktreeStore()
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId)
  const selectedConnection = useConnectionStore((s) =>
    s.selectedConnectionId ? s.connections.find((c) => c.id === s.selectedConnectionId) : null
  )
  const isConnectionMode = !!selectedConnectionId && !selectedWorktreeId

  // Get the selected worktree path by searching all projects' worktrees
  const selectedWorktreePath = useMemo(() => {
    // In connection mode, use the connection's folder path
    if (isConnectionMode && selectedConnection?.path) {
      return selectedConnection.path
    }

    if (!selectedWorktreeId) return null

    // Search through all projects' worktrees to find the selected one
    for (const [, worktrees] of worktreesByProject) {
      const worktree = worktrees.find((w) => w.id === selectedWorktreeId)
      if (worktree) {
        return worktree.path
      }
    }
    return null
  }, [selectedWorktreeId, worktreesByProject, isConnectionMode, selectedConnection?.path])

  const handleResize = (delta: number): void => {
    setRightSidebarWidth(rightSidebarWidth + delta)
  }

  const handleFileClick = (node: { path: string; name: string; isDirectory: boolean }): void => {
    // Open file in the file viewer tab
    const contextId = selectedWorktreeId || selectedConnectionId
    if (!node.isDirectory && contextId) {
      useFileViewerStore.getState().openFile(node.path, node.name, contextId)
    }
  }

  // For connections, the effective tab is always 'terminal' since setup/run are worktree-specific
  const effectiveBottomPanelTab = isConnectionMode ? 'terminal' : bottomPanelTab

  // TerminalManager is always rendered (even when sidebar is collapsed) to preserve
  // PTY state across sidebar collapse/expand and worktree switches.
  // When terminal is docked to bottom, TerminalManager lives in BottomDock instead.
  const isDockRight = terminalDock === 'right'
  const terminalPanelVisible = isDockRight && rightContextTab === 'terminal'
  const terminalManager = isDockRight ? (
    <TerminalManager
      selectedWorktreeId={selectedWorktreeId}
      worktreePath={selectedWorktreePath}
      isVisible={
        !rightSidebarCollapsed && terminalPanelVisible && effectiveBottomPanelTab === 'terminal'
      }
    />
  ) : null
  const terminalPanel = isDockRight ? (
    <BottomPanel
      terminalSlot={terminalManager}
      isConnectionMode={isConnectionMode}
      worktreePath={selectedWorktreePath}
    />
  ) : undefined

  if (rightSidebarCollapsed) {
    return (
      <div data-testid="right-sidebar-collapsed">
        {/* Keep TerminalManager alive when sidebar is collapsed so PTYs persist */}
        {isDockRight && <div className="hidden">{terminalManager}</div>}
      </div>
    )
  }

  return (
    <div className="flex flex-shrink-0" data-testid="right-sidebar-container">
      <ResizeHandle onResize={handleResize} direction="right" />
      <aside
        className="flex flex-col overflow-hidden border-l border-sidebar-border/45 bg-sidebar/70 text-sidebar-foreground backdrop-blur-sm"
        style={{ width: rightSidebarWidth }}
        data-testid="right-sidebar"
        data-width={rightSidebarWidth}
        role="complementary"
        aria-label={t('rightSidebar.ariaLabel')}
      >
        <ErrorBoundary
          componentName="ContextPanelHost"
          fallback={
            <div className="flex-1 p-2">
              <ErrorFallback compact title={t('rightSidebar.fileSidebarError')} />
            </div>
          }
        >
          <ContextPanelHost
            worktreePath={selectedWorktreePath}
            scopeId={isConnectionMode ? selectedConnectionId : selectedWorktreeId}
            isConnectionMode={isConnectionMode}
            connectionMembers={selectedConnection?.members}
            onClose={toggleRightSidebar}
            onFileClick={handleFileClick}
            terminalPanel={terminalPanel}
            className="flex-1 min-h-0"
          />
        </ErrorBoundary>
      </aside>
    </div>
  )
}
