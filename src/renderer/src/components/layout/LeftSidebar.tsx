import { useEffect, useState, useRef } from 'react'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useProjectStore, useConnectionStore, useFilterStore, useSpaceStore } from '@/stores'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { ResizeHandle } from './ResizeHandle'
import { FolderGit2, Link, Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ProjectList,
  AddProjectButton,
  SortProjectsButton,
  FilterChips
} from '@/components/projects'
import { ConnectionList } from '@/components/connections'
import { SpacesTabBar } from '@/components/spaces'
import { ProjectFilter } from '@/components/projects/ProjectFilter'
import { UsageIndicator } from './UsageIndicator'
import { PinnedList } from './PinnedList'
import { useI18n } from '@/i18n/useI18n'
import { cn } from '@/lib/utils'

export function LeftSidebar(): React.JSX.Element {
  const { leftSidebarWidth, leftSidebarCollapsed, setLeftSidebarWidth } = useLayoutStore()
  const expandAllProjects = useProjectStore((s) => s.expandAllProjects)
  const projectCount = useProjectStore((s) => s.projects.length)
  const showUsageIndicator = useSettingsStore((s) => s.showUsageIndicator)
  const [filterQuery, setFilterQuery] = useState('')
  const { t } = useI18n()

  // Filter store for language filters
  const activeLanguages = useFilterStore((s) => s.activeLanguages)
  const removeLanguage = useFilterStore((s) => s.removeLanguage)
  const clearAllFilters = useFilterStore((s) => s.clearAll)

  // Space switching
  const activeSpaceId = useSpaceStore((s) => s.activeSpaceId)

  // Connection mode state
  const connectionModeActive = useConnectionStore((s) => s.connectionModeActive)
  const connectionModeSelectedIds = useConnectionStore((s) => s.connectionModeSelectedIds)
  const connectionModeSubmitting = useConnectionStore((s) => s.connectionModeSubmitting)
  const exitConnectionMode = useConnectionStore((s) => s.exitConnectionMode)
  const finalizeConnection = useConnectionStore((s) => s.finalizeConnection)
  const connectionCount = useConnectionStore((s) => s.connections.length)
  const enterConnectionMode = useConnectionStore((s) => s.enterConnectionMode)

  const [sidebarTab, setSidebarTab] = useState<'projects' | 'connections'>('projects')

  const canFinalize = connectionModeSelectedIds.size >= 2

  // Save expanded state before connection mode expands everything
  const savedExpandedIdsRef = useRef<Set<string> | null>(null)

  // Expand all projects when entering connection mode
  useEffect(() => {
    if (connectionModeActive) {
      savedExpandedIdsRef.current = new Set(useProjectStore.getState().expandedProjectIds)
      expandAllProjects()
    } else if (savedExpandedIdsRef.current) {
      // Restore previous expanded state when exiting connection mode
      useProjectStore.setState({ expandedProjectIds: savedExpandedIdsRef.current })
      savedExpandedIdsRef.current = null
    }
  }, [connectionModeActive, expandAllProjects])

  // Clear filter when entering connection mode
  useEffect(() => {
    if (connectionModeActive) {
      setFilterQuery('')
      clearAllFilters()
    }
  }, [connectionModeActive, clearAllFilters])

  // Clear language filters on space switch
  useEffect(() => {
    clearAllFilters()
    setFilterQuery('')
  }, [activeSpaceId, clearAllFilters])

  // Escape key exits connection mode
  useEffect(() => {
    if (!connectionModeActive) return

    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        exitConnectionMode()
      }
    }

    document.addEventListener('keydown', handleEscape, true)
    return () => document.removeEventListener('keydown', handleEscape, true)
  }, [connectionModeActive, exitConnectionMode])

  // Exit connection mode if sidebar collapses
  useEffect(() => {
    if (leftSidebarCollapsed && connectionModeActive) {
      exitConnectionMode()
    }
  }, [leftSidebarCollapsed, connectionModeActive, exitConnectionMode])

  const handleResize = (delta: number): void => {
    setLeftSidebarWidth(leftSidebarWidth + delta)
  }

  const handleAddProject = async (): Promise<void> => {
    // Trigger the add project flow
    const addButton = document.querySelector(
      '[data-testid="add-project-button"]'
    ) as HTMLButtonElement
    if (addButton) {
      addButton.click()
    }
  }

  if (leftSidebarCollapsed) {
    return <div data-testid="left-sidebar-collapsed" />
  }

  return (
    <div className="flex flex-shrink-0" data-testid="left-sidebar-container">
      <aside
        className="bg-sidebar text-sidebar-foreground border-r border-sidebar-border/60 flex flex-col overflow-hidden"
        style={{ width: leftSidebarWidth }}
        data-testid="left-sidebar"
        data-width={leftSidebarWidth}
        role="navigation"
        aria-label={t('leftSidebar.ariaLabel')}
      >
        {connectionModeActive ? (
          <div className="px-4 py-3 border-b border-sidebar-border/60 flex items-center justify-between bg-muted/50">
            <div className="flex items-center gap-2 text-sm font-medium min-w-0">
              <Link className="h-4 w-4 text-primary shrink-0" />
              <span className="truncate">{t('sidebar.connectionMode.selectWorktrees')}</span>
              <span className="text-xs text-muted-foreground shrink-0">
                ({connectionModeSelectedIds.size})
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={exitConnectionMode}
                disabled={connectionModeSubmitting}
              >
                {t('sidebar.connectionMode.cancel')}
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={finalizeConnection}
                disabled={!canFinalize || connectionModeSubmitting}
              >
                {connectionModeSubmitting ? (
                  <>
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    {t('sidebar.connectionMode.connecting')}
                  </>
                ) : (
                  t('sidebar.connectionMode.connect')
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div className="px-3 pt-2 pb-0 border-b border-sidebar-border/60">
            {/* Tab row */}
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSidebarTab('projects')}
                className={cn(
                  'relative flex items-center gap-1.5 pb-2 text-xs font-medium transition-colors',
                  sidebarTab === 'projects'
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <FolderGit2 className="h-3 w-3 shrink-0" />
                {t('sidebar.projects')}
                {sidebarTab === 'projects' && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-primary" />
                )}
              </button>
              <button
                onClick={() => setSidebarTab('connections')}
                className={cn(
                  'relative flex items-center gap-1.5 pb-2 text-xs font-medium transition-colors',
                  sidebarTab === 'connections'
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Link className="h-3 w-3 shrink-0" />
                {t('connectionList.title')}
                {connectionCount > 0 && (
                  <span className="text-[10px] tabular-nums text-muted-foreground">{connectionCount}</span>
                )}
                {sidebarTab === 'connections' && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-primary" />
                )}
              </button>
              <div className="flex-1" />
              {sidebarTab === 'connections' && (
                <button
                  onClick={() => enterConnectionMode()}
                  className="flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors mb-1.5"
                  title="New connection"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {/* Action buttons — only for projects tab */}
            {sidebarTab === 'projects' && (
              <div className="flex items-center gap-1 pb-1.5">
                <SortProjectsButton />
                <AddProjectButton />
              </div>
            )}
          </div>
        )}
        {!connectionModeActive && sidebarTab === 'projects' && projectCount > 1 && (
          <div className="px-4 py-3 border-b border-sidebar-border/70">
            <ProjectFilter value={filterQuery} onChange={setFilterQuery} />
          </div>
        )}
        {sidebarTab === 'projects' && activeLanguages.length > 0 && (
          <div className="px-4 py-2 border-b border-sidebar-border/70">
            <FilterChips languages={activeLanguages} onRemove={removeLanguage} />
          </div>
        )}
        <div className="flex-1 overflow-auto px-3 py-3" data-testid="sidebar-scroll-container">
          {sidebarTab === 'projects' || connectionModeActive ? (
            <>
              <PinnedList />
              <ProjectList
                onAddProject={handleAddProject}
                filterQuery={filterQuery}
                activeLanguages={activeLanguages}
              />
            </>
          ) : (
            <ConnectionList />
          )}
        </div>
        {!connectionModeActive &&
          (showUsageIndicator ? (
            <div className="border-t border-sidebar-border/70">
              <UsageIndicator />
            </div>
          ) : (
            <div className="border-t border-sidebar-border/70 px-2 py-2">
              <SpacesTabBar />
            </div>
          ))}
      </aside>
      <ResizeHandle onResize={handleResize} direction="left" />
    </div>
  )
}
