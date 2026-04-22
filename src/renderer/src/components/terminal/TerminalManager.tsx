import { useRef, useCallback, useEffect } from 'react'
import { TerminalView, type TerminalViewHandle } from './TerminalView'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useBottomTerminalStore } from '@/stores/useBottomTerminalStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useI18n } from '@/i18n/useI18n'

interface TerminalManagerProps {
  /** The currently selected worktree ID (null if none selected) */
  selectedWorktreeId: string | null
  /** The worktree path for the selected worktree */
  worktreePath: string | null
  /** Whether the terminal tab is currently visible */
  isVisible: boolean
}

/**
 * TerminalManager renders one TerminalView per bottom-panel terminal tab.
 * Tabs are managed by useBottomTerminalStore; each tab gets its own PTY
 * keyed by `tab.id`. All tabs stay mounted (CSS hidden) to preserve PTY state.
 */
export function TerminalManager({
  selectedWorktreeId,
  worktreePath,
  isVisible
}: TerminalManagerProps): React.JSX.Element {
  const { t } = useI18n()
  const terminalRefsMap = useRef<Map<string, React.RefObject<TerminalViewHandle | null>>>(
    new Map()
  )

  const destroyTerminal = useTerminalStore((s) => s.destroyTerminal)
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const embeddedTerminalBackend = useSettingsStore((s) => s.embeddedTerminalBackend)
  const prevBackendRef = useRef(embeddedTerminalBackend)

  const ensureDefaultTab = useBottomTerminalStore((s) => s.ensureDefaultTab)
  const cleanupWorktree = useBottomTerminalStore((s) => s.cleanupWorktree)
  const clearAll = useBottomTerminalStore((s) => s.clearAll)
  const tabsByWorktree = useBottomTerminalStore((s) => s.tabsByWorktree)
  const tabsByWorktreeRef = useRef(tabsByWorktree)
  tabsByWorktreeRef.current = tabsByWorktree
  const activeTabByWorktree = useBottomTerminalStore((s) => s.activeTabByWorktree)

  // Get or create a ref for a tab's terminal
  const getTerminalRef = useCallback(
    (tabId: string): React.RefObject<TerminalViewHandle | null> => {
      let ref = terminalRefsMap.current.get(tabId)
      if (!ref) {
        ref = { current: null }
        terminalRefsMap.current.set(tabId, ref)
      }
      return ref
    },
    []
  )

  // Ensure the selected worktree has at least one terminal tab
  // NOTE: must be in useEffect — calling store actions during render violates React rules
  useEffect(() => {
    if (selectedWorktreeId && worktreePath && isVisible) {
      ensureDefaultTab(selectedWorktreeId, worktreePath)
    }
  }, [selectedWorktreeId, worktreePath, isVisible, ensureDefaultTab])

  // When backend setting changes, tear down all active terminals so they get re-created
  // with the new backend on next visibility
  useEffect(() => {
    if (prevBackendRef.current !== embeddedTerminalBackend) {
      prevBackendRef.current = embeddedTerminalBackend
      // Destroy all PTYs via existing terminal store, then clear all bottom terminal tabs
      for (const [, tabs] of tabsByWorktreeRef.current) {
        for (const tab of tabs) {
          destroyTerminal(tab.id)
        }
      }
      clearAll()
      terminalRefsMap.current.clear()
    }
  }, [embeddedTerminalBackend, destroyTerminal, clearAll])

  // Clean up terminals for worktrees that no longer exist
  useEffect(() => {
    const existingWorktreeIds = new Set<string>()
    for (const [, worktrees] of worktreesByProject) {
      for (const wt of worktrees) {
        existingWorktreeIds.add(wt.id)
      }
    }

    for (const [worktreeId] of tabsByWorktree) {
      if (!existingWorktreeIds.has(worktreeId)) {
        // Worktree was deleted/archived — clean up all its terminal tabs
        const tabs = tabsByWorktree.get(worktreeId) ?? []
        for (const tab of tabs) {
          terminalRefsMap.current.delete(tab.id)
        }
        cleanupWorktree(worktreeId)
      }
    }
  }, [worktreesByProject, tabsByWorktree, cleanupWorktree])

  // Collect all tabs across all worktrees that have been visited
  const allTabs: Array<{
    tabId: string
    worktreeId: string
    cwd: string
    isActive: boolean
  }> = []

  for (const [wId, tabs] of tabsByWorktree) {
    const activeTabId = activeTabByWorktree.get(wId)
    for (const tab of tabs) {
      allTabs.push({
        tabId: tab.id,
        worktreeId: wId,
        cwd: tab.cwd,
        isActive: wId === selectedWorktreeId && tab.id === activeTabId && isVisible
      })
    }
  }

  if (allTabs.length === 0 && !selectedWorktreeId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        {t('terminalManager.empty.selectWorktree')}
      </div>
    )
  }

  return (
    <>
      {allTabs.map(({ tabId, worktreeId, cwd, isActive }) => {
        const termRef = getTerminalRef(tabId)

        return (
          <div
            key={tabId}
            className={isActive ? 'h-full w-full' : 'hidden'}
            data-testid={`terminal-instance-${tabId}`}
          >
            <TerminalView
              ref={termRef}
              terminalId={tabId}
              worktreeId={worktreeId}
              cwd={cwd}
              isVisible={isActive}
            />
          </div>
        )
      })}
      {/* Show placeholder if selected worktree doesn't have any tabs yet */}
      {selectedWorktreeId &&
        !tabsByWorktree.has(selectedWorktreeId) &&
        !worktreePath && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            {t('terminalManager.empty.selectWorktree')}
          </div>
        )}
    </>
  )
}
