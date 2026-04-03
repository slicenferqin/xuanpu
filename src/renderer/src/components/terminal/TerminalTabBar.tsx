import { useState, useRef, useEffect, useCallback } from 'react'
import { Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useBottomTerminalStore } from '@/stores/useBottomTerminalStore'
import { useTerminalStore } from '@/stores/useTerminalStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useI18n } from '@/i18n/useI18n'

interface TerminalTabBarProps {
  worktreeId: string
  worktreeCwd: string
}

function StatusDot({ tabId }: { tabId: string }): React.JSX.Element {
  const status = useTerminalStore((s) => s.terminals.get(tabId)?.status ?? 'creating')

  return (
    <span
      className={cn(
        'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
        status === 'running' && 'bg-green-500',
        status === 'creating' && 'bg-yellow-500 animate-pulse',
        status === 'exited' && 'bg-red-500'
      )}
    />
  )
}

export function TerminalTabBar({
  worktreeId,
  worktreeCwd
}: TerminalTabBarProps): React.JSX.Element {
  const tabs = useBottomTerminalStore((s) => s.getTabsForWorktree(worktreeId))
  const activeTabId = useBottomTerminalStore((s) => s.getActiveTabId(worktreeId))
  const { createTab, closeTab, closeOtherTabs, setActiveTab, renameTab } =
    useBottomTerminalStore()

  const { t } = useI18n()

  const pushGhosttySuppression = useLayoutStore((s) => s.pushGhosttySuppression)
  const popGhosttySuppression = useLayoutStore((s) => s.popGhosttySuppression)

  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  // Focus the rename input when editing starts
  useEffect(() => {
    if (editingTabId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingTabId])

  // Clean up ghostty suppression on unmount
  useEffect(() => {
    return () => {
      popGhosttySuppression('terminal-tab-context')
    }
  }, [popGhosttySuppression])

  const handleCreateTab = useCallback(async () => {
    // Try to inherit cwd from active terminal
    let cwd = worktreeCwd
    if (activeTabId) {
      try {
        const resolved = await window.terminalOps.getCwd(activeTabId)
        if (resolved) cwd = resolved
      } catch {
        // Fallback to worktree root
      }
    }
    createTab(worktreeId, cwd)
  }, [worktreeId, worktreeCwd, activeTabId, createTab])

  const handleMiddleClick = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      if (e.button === 1) {
        e.preventDefault()
        closeTab(tabId)
      }
    },
    [closeTab]
  )

  const startRename = useCallback((tabId: string, currentLabel: string) => {
    setEditingTabId(tabId)
    setEditName(currentLabel)
  }, [])

  const commitRename = useCallback(() => {
    if (editingTabId && editName.trim()) {
      renameTab(editingTabId, editName.trim())
    }
    setEditingTabId(null)
  }, [editingTabId, editName, renameTab])

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commitRename()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setEditingTabId(null)
      }
      e.stopPropagation()
    },
    [commitRename]
  )

  if (!tabs.length) return <></>

  return (
    <div className="flex items-center gap-0.5 border-b border-border/40 bg-background/30 px-1 py-0.5">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId
        const isEditing = editingTabId === tab.id

        return (
          <ContextMenu
            key={tab.id}
            onOpenChange={(open) => {
              if (open) pushGhosttySuppression('terminal-tab-context')
              else popGhosttySuppression('terminal-tab-context')
            }}
          >
            <ContextMenuTrigger asChild>
              <button
                className={cn(
                  'group relative flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors',
                  isActive
                    ? 'bg-background/90 text-foreground'
                    : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
                )}
                onClick={() => setActiveTab(worktreeId, tab.id)}
                onAuxClick={(e) => handleMiddleClick(e, tab.id)}
                onDoubleClick={() => startRename(tab.id, tab.label)}
              >
                <StatusDot tabId={tab.id} />
                {isEditing ? (
                  <input
                    ref={editInputRef}
                    className="w-16 bg-transparent text-[11px] outline-none border-b border-primary"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={handleRenameKeyDown}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="max-w-[100px] truncate">{tab.label}</span>
                )}
                <span
                  className={cn(
                    'ml-0.5 rounded p-0.5 opacity-0 transition-opacity hover:bg-foreground/10',
                    isActive ? 'group-hover:opacity-100' : 'group-hover:opacity-60'
                  )}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.id)
                  }}
                >
                  <X className="h-2.5 w-2.5" />
                </span>
                {isActive && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
                )}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => startRename(tab.id, tab.label)}>
                {t('terminalTabBar.rename')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => closeTab(tab.id)}>
                {t('terminalTabBar.close')}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => closeOtherTabs(tab.id)}
                disabled={tabs.length <= 1}
              >
                {t('terminalTabBar.closeOthers')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
      <button
        className="flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
        onClick={handleCreateTab}
        title={t('terminalTabBar.newTerminal')}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
