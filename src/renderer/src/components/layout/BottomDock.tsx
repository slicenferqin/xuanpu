/**
 * BottomDock — Full-width bottom panel for terminal when docked to bottom.
 *
 * Rendered by AppLayout when `terminalDock === 'bottom'`. Creates its own
 * TerminalManager instance. PTY processes persist in main process across
 * dock switches — xterm.js reconnects automatically.
 */

import { useCallback, useMemo, useRef } from 'react'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { ResizeHandle } from './ResizeHandle'
import { BottomPanel } from './BottomPanel'
import { TerminalManager } from '@/components/terminal/TerminalManager'

export function BottomDock(): React.JSX.Element {
  const bottomDockHeight = useLayoutStore((s) => s.bottomDockHeight)
  const setBottomDockHeight = useLayoutStore((s) => s.setBottomDockHeight)
  const bottomPanelTab = useLayoutStore((s) => s.bottomPanelTab)
  const dockRef = useRef<HTMLDivElement>(null)

  const { selectedWorktreeId, worktreesByProject } = useWorktreeStore()
  const selectedConnectionId = useConnectionStore((s) => s.selectedConnectionId)
  const selectedConnection = useConnectionStore((s) =>
    s.selectedConnectionId ? s.connections.find((c) => c.id === s.selectedConnectionId) : null
  )
  const isConnectionMode = !!selectedConnectionId && !selectedWorktreeId

  const selectedWorktreePath = useMemo(() => {
    if (isConnectionMode && selectedConnection?.path) return selectedConnection.path
    if (!selectedWorktreeId) return null
    for (const [, worktrees] of worktreesByProject) {
      const wt = worktrees.find((w) => w.id === selectedWorktreeId)
      if (wt) return wt.path
    }
    return null
  }, [selectedWorktreeId, worktreesByProject, isConnectionMode, selectedConnection?.path])

  const effectiveTab = isConnectionMode ? 'terminal' : bottomPanelTab

  const handleResize = useCallback(
    (delta: number) => {
      // direction="up" → delta is negative when dragging up (= increase height)
      setBottomDockHeight(bottomDockHeight - delta)
    },
    [bottomDockHeight, setBottomDockHeight]
  )

  const terminalManager = (
    <TerminalManager
      selectedWorktreeId={selectedWorktreeId}
      worktreePath={selectedWorktreePath}
      isVisible={effectiveTab === 'terminal'}
    />
  )

  return (
    <div
      ref={dockRef}
      className="flex flex-col shrink-0 border-t border-border/60 bg-sidebar"
      style={{ height: bottomDockHeight }}
      data-testid="bottom-dock"
    >
      <ResizeHandle
        onResize={handleResize}
        direction="up"
        className="h-px border-0 bg-sidebar-border/60 hover:bg-primary/20 active:bg-primary/30"
      />
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <BottomPanel
          terminalSlot={terminalManager}
          isConnectionMode={isConnectionMode}
          worktreePath={selectedWorktreePath}
        />
      </div>
    </div>
  )
}
