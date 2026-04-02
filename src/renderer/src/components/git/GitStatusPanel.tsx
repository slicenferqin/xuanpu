import { useState, useEffect, useCallback, useMemo, useRef, memo, forwardRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ChevronDown,
  ChevronRight,
  RefreshCw,
  GitBranch,
  ArrowUp,
  ArrowDown,
  Plus,
  Minus,
  FileDiff,
  FileCode,
  Copy,
  Loader2,
  AlertTriangle
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useGitStore, type GitFileStatus } from '@/stores/useGitStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { GitCommitForm } from './GitCommitForm'
import { GitPushPull } from './GitPushPull'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'

interface GitStatusPanelProps {
  worktreePath: string | null
  className?: string
}

// ── Virtual list item types ──────────────────────────────────

type SectionKey = 'conflicts' | 'staged' | 'modified' | 'untracked'

type VirtualGitItem =
  | { type: 'header'; section: SectionKey; title: string; count: number; isOpen: boolean; testId: string }
  | { type: 'file'; file: GitFileStatus; isStaged: boolean; section: SectionKey }

const SECTION_HEADER_HEIGHT = 28
const FILE_ITEM_HEIGHT = 26

interface FileItemProps {
  file: GitFileStatus
  onToggle: (file: GitFileStatus) => void
  onViewDiff: (file: GitFileStatus) => void
  isStaged: boolean
}

const FileItem = memo(forwardRef<HTMLDivElement, FileItemProps>(function FileItem(
  { file, onToggle, onViewDiff, isStaged },
  ref
): React.JSX.Element {
  const { t } = useI18n()
  const statusColors: Record<string, string> = {
    M: 'text-yellow-500',
    A: 'text-green-500',
    D: 'text-red-500',
    '?': 'text-gray-400',
    C: 'text-red-600 font-bold'
  }

  return (
    <div
      ref={ref}
      className="flex items-center gap-2 px-2 py-0.5 hover:bg-accent/30 group"
      data-testid={`git-file-item-${file.relativePath}`}
    >
      <Checkbox
        checked={isStaged}
        onCheckedChange={() => onToggle(file)}
        className="h-3.5 w-3.5"
        aria-label={
          isStaged
            ? t('gitStatusPanel.fileItem.unstageFile', { path: file.relativePath })
            : t('gitStatusPanel.fileItem.stageFile', { path: file.relativePath })
        }
      />
      <span className={cn('text-[10px] font-mono w-3', statusColors[file.status])}>
        {file.status}
      </span>
      <button
        type="button"
        className="text-xs truncate flex-1 text-left hover:underline cursor-pointer"
        onClick={() => onViewDiff(file)}
        title={t('gitStatusPanel.fileItem.viewChangesTitle', { path: file.relativePath })}
      >
        {file.relativePath}
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={() => onViewDiff(file)}
        title={t('gitStatusPanel.fileItem.viewChanges')}
        data-testid={`view-diff-${file.relativePath}`}
      >
        <FileDiff className="h-3 w-3 text-muted-foreground" />
      </Button>
    </div>
  )
}))

export function GitStatusPanel({
  worktreePath,
  className
}: GitStatusPanelProps): React.JSX.Element | null {
  const { t } = useI18n()
  const {
    loadFileStatuses,
    loadBranchInfo,
    stageFile,
    unstageFile,
    stageAll,
    unstageAll,
    isLoading
  } = useGitStore()

  // Subscribe directly to store state so we re-render when data changes
  const fileStatusesByWorktree = useGitStore((state) => state.fileStatusesByWorktree)
  const branchInfoByWorktree = useGitStore((state) => state.branchInfoByWorktree)

  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isFixingConflicts, setIsFixingConflicts] = useState(false)

  // Load initial data
  useEffect(() => {
    if (worktreePath) {
      loadFileStatuses(worktreePath)
      loadBranchInfo(worktreePath)
    }
  }, [worktreePath, loadFileStatuses, loadBranchInfo])

  // Get branch info directly from store state
  const branchInfo = worktreePath ? branchInfoByWorktree.get(worktreePath) : undefined

  // Get and categorize files - memoized based on the Map and worktreePath
  const { fileStatuses, stagedFiles, modifiedFiles, untrackedFiles, conflictedFiles } =
    useMemo(() => {
      const files = worktreePath ? fileStatusesByWorktree.get(worktreePath) || [] : []
      const staged: GitFileStatus[] = []
      const modified: GitFileStatus[] = []
      const untracked: GitFileStatus[] = []
      const conflicted: GitFileStatus[] = []

      for (const file of files) {
        if (file.status === 'C') {
          conflicted.push(file)
        } else if (file.staged) {
          staged.push(file)
        } else if (file.status === '?') {
          untracked.push(file)
        } else if (file.status === 'M' || file.status === 'D') {
          modified.push(file)
        }
      }

      return {
        fileStatuses: files,
        stagedFiles: staged,
        modifiedFiles: modified,
        untrackedFiles: untracked,
        conflictedFiles: conflicted
      }
    }, [worktreePath, fileStatusesByWorktree])

  const handleRefresh = useCallback(async () => {
    if (!worktreePath) return
    setIsRefreshing(true)
    try {
      await Promise.all([loadFileStatuses(worktreePath), loadBranchInfo(worktreePath)])
    } finally {
      setIsRefreshing(false)
    }
  }, [worktreePath, loadFileStatuses, loadBranchInfo])

  const handleStageAll = useCallback(async () => {
    if (!worktreePath) return
    const success = await stageAll(worktreePath)
    if (success) {
      toast.success(t('gitStatusPanel.toasts.stageAllSuccess'))
    } else {
      toast.error(t('gitStatusPanel.toasts.stageAllError'))
    }
  }, [worktreePath, stageAll, t])

  const handleUnstageAll = useCallback(async () => {
    if (!worktreePath) return
    const success = await unstageAll(worktreePath)
    if (success) {
      toast.success(t('gitStatusPanel.toasts.unstageAllSuccess'))
    } else {
      toast.error(t('gitStatusPanel.toasts.unstageAllError'))
    }
  }, [worktreePath, unstageAll, t])

  const handleToggleFile = useCallback(
    async (file: GitFileStatus) => {
      if (!worktreePath) return
      if (file.staged) {
        const success = await unstageFile(worktreePath, file.relativePath)
        if (!success) {
          toast.error(t('gitStatusPanel.toasts.unstageFileError', { path: file.relativePath }))
        }
      } else {
        const success = await stageFile(worktreePath, file.relativePath)
        if (!success) {
          toast.error(t('gitStatusPanel.toasts.stageFileError', { path: file.relativePath }))
        }
      }
    },
    [worktreePath, stageFile, unstageFile, t]
  )

  const handleViewDiff = useCallback(
    (file: GitFileStatus) => {
      if (!worktreePath) return
      const isNewFile = file.status === '?' || file.status === 'A'

      if (isNewFile) {
        const fullPath = `${worktreePath}/${file.relativePath}`
        const fileName = file.relativePath.split('/').pop() || file.relativePath
        const worktreeId = useWorktreeStore.getState().selectedWorktreeId
        if (worktreeId) {
          useFileViewerStore.getState().openFile(fullPath, fileName, worktreeId)
        }
      } else {
        useFileViewerStore.getState().setActiveDiff({
          worktreePath,
          filePath: file.relativePath,
          fileName: file.relativePath.split('/').pop() || file.relativePath,
          staged: file.staged,
          isUntracked: file.status === '?',
          isNewFile: false
        })
      }
    },
    [worktreePath]
  )

  const handleOpenSourceFile = useCallback(
    (file: GitFileStatus) => {
      if (!worktreePath) return
      const fullPath = `${worktreePath}/${file.relativePath}`
      const fileName = file.relativePath.split('/').pop() || file.relativePath
      const worktreeId = useWorktreeStore.getState().selectedWorktreeId
      if (worktreeId) {
        useFileViewerStore.getState().openFile(fullPath, fileName, worktreeId)
      }
    },
    [worktreePath]
  )

  const handleCopyPath = useCallback(
    (file: GitFileStatus) => {
      navigator.clipboard.writeText(file.relativePath)
      toast.success(t('gitStatusPanel.toasts.pathCopied'))
    },
    [t]
  )

  const hasConflicts = conflictedFiles.length > 0

  // ── Section collapse state ──────────────────────────────────
  const [collapsedSections, setCollapsedSections] = useState<Set<SectionKey>>(new Set())
  const toggleSection = useCallback((section: SectionKey) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }, [])

  // ── Build flat virtual items ──────────────────────────────────
  const virtualItems = useMemo<VirtualGitItem[]>(() => {
    const items: VirtualGitItem[] = []

    const addSection = (
      section: SectionKey,
      title: string,
      files: GitFileStatus[],
      isStaged: boolean,
      testId: string
    ): void => {
      if (files.length === 0) return
      const isOpen = !collapsedSections.has(section)
      items.push({ type: 'header', section, title, count: files.length, isOpen, testId })
      if (isOpen) {
        for (const file of files) {
          items.push({ type: 'file', file, isStaged, section })
        }
      }
    }

    addSection('conflicts', t('gitStatusPanel.sections.conflicts'), conflictedFiles, false, 'git-conflicts-section')
    addSection('staged', t('gitStatusPanel.sections.staged'), stagedFiles, true, 'git-staged-section')
    addSection('modified', t('gitStatusPanel.sections.changes'), modifiedFiles, false, 'git-modified-section')
    addSection('untracked', t('gitStatusPanel.sections.untracked'), untrackedFiles, false, 'git-untracked-section')

    return items
  }, [collapsedSections, conflictedFiles, stagedFiles, modifiedFiles, untrackedFiles, t])

  // ── Virtualizer ──────────────────────────────────────────────
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) =>
      virtualItems[index].type === 'header' ? SECTION_HEADER_HEIGHT : FILE_ITEM_HEIGHT,
    overscan: 10
  })

  const handleFixConflicts = useCallback(async () => {
    if (!worktreePath) return
    setIsFixingConflicts(true)
    try {
      const worktreeStore = useWorktreeStore.getState()
      const selectedWorktreeId = worktreeStore.selectedWorktreeId
      if (!selectedWorktreeId) {
        toast.error(t('gitStatusPanel.toasts.noWorktreeSelected'))
        return
      }

      let projectId = ''
      for (const [projId, worktrees] of worktreeStore.worktreesByProject) {
        if (worktrees.some((w) => w.id === selectedWorktreeId)) {
          projectId = projId
          break
        }
      }
      if (!projectId) {
        toast.error(t('gitStatusPanel.toasts.projectNotFound'))
        return
      }

      const branchName = branchInfo?.name || t('gitStatusPanel.unknownBranch')

      const sessionStore = useSessionStore.getState()
      const result = await sessionStore.createSession(selectedWorktreeId, projectId)
      if (!result.success || !result.session) {
        toast.error(t('gitStatusPanel.toasts.createSessionError'))
        return
      }

      await sessionStore.updateSessionName(
        result.session.id,
        t('gitStatusPanel.conflictSessionName', { branch: branchName })
      )

      sessionStore.setPendingMessage(result.session.id, t('gitStatusPanel.pendingMessage'))
    } catch (error) {
      console.error('Failed to start conflict resolution:', error)
      toast.error(t('gitStatusPanel.toasts.conflictResolutionError'))
    } finally {
      setIsFixingConflicts(false)
    }
  }, [worktreePath, branchInfo, t])

  if (!worktreePath) {
    return null
  }

  const hasChanges = fileStatuses.length > 0
  const hasUnstaged = modifiedFiles.length > 0 || untrackedFiles.length > 0
  const hasStaged = stagedFiles.length > 0

  return (
    <div
      className={cn('flex flex-col border-b', className)}
      data-testid="git-status-panel"
      role="region"
      aria-label={t('gitStatusPanel.ariaLabel')}
    >
      {/* Header with branch info */}
      <div className="flex items-center justify-between px-2 py-1.5 bg-muted/30">
        <div className="flex items-center gap-1.5 text-xs">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium" data-testid="git-branch-name">
            {branchInfo?.name || t('gitStatusPanel.loading')}
          </span>
          {branchInfo && branchInfo.tracking && (
            <span
              className="flex items-center gap-1 text-muted-foreground"
              data-testid="git-ahead-behind"
            >
              {branchInfo.ahead > 0 && (
                <span
                  className="flex items-center gap-0.5"
                  title={t('gitStatusPanel.ahead', { count: branchInfo.ahead })}
                >
                  <ArrowUp className="h-3 w-3" />
                  {branchInfo.ahead}
                </span>
              )}
              {branchInfo.behind > 0 && (
                <span
                  className="flex items-center gap-0.5"
                  title={t('gitStatusPanel.behind', { count: branchInfo.behind })}
                >
                  <ArrowDown className="h-3 w-3" />
                  {branchInfo.behind}
                </span>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {hasConflicts && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px] font-bold text-orange-500 hover:text-orange-400 hover:bg-orange-500/10"
              onClick={handleFixConflicts}
              disabled={isFixingConflicts}
              title={t('gitStatusPanel.conflictsTitle', { count: conflictedFiles.length })}
              data-testid="git-merge-conflicts-button"
            >
              {isFixingConflicts ? (
                <Loader2 className="h-3 w-3 animate-spin mr-0.5" />
              ) : (
                <AlertTriangle className="h-3 w-3 mr-0.5" />
              )}
              {t('gitStatusPanel.conflictsButton')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={cn('h-5 w-5', (isLoading || isRefreshing) && 'animate-spin')}
            onClick={handleRefresh}
            disabled={isLoading || isRefreshing}
            title={t('gitStatusPanel.refresh')}
            data-testid="git-refresh-button"
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {!hasChanges ? (
        <div className="px-2 py-3 text-xs text-muted-foreground text-center">
          {t('gitStatusPanel.noChanges')}
        </div>
      ) : (
        <div ref={scrollContainerRef} className="max-h-[200px] overflow-y-auto">
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative'
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = virtualItems[virtualRow.index]
              return (
                <div
                  key={
                    item.type === 'header'
                      ? `hdr-${item.section}`
                      : `file-${item.section}-${item.file.relativePath}`
                  }
                  data-index={virtualRow.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  {item.type === 'header' ? (
                    <div className="border-b last:border-b-0" data-testid={item.testId}>
                      <button
                        type="button"
                        className="flex items-center justify-between w-full px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50"
                        onClick={() => toggleSection(item.section)}
                      >
                        <span className="flex items-center gap-1">
                          {item.isOpen ? (
                            <ChevronDown className="h-3 w-3" />
                          ) : (
                            <ChevronRight className="h-3 w-3" />
                          )}
                          {item.title}
                          <span className="text-[10px] px-1 py-0.5 rounded bg-muted">
                            {item.count}
                          </span>
                        </span>
                        {/* Section actions */}
                        {item.section === 'staged' && hasStaged && (
                          <span onClick={(e) => e.stopPropagation()}>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 px-1.5 text-[10px]"
                              onClick={handleUnstageAll}
                              title={t('gitStatusPanel.actions.unstageAllTitle')}
                              data-testid="git-unstage-all"
                            >
                              <Minus className="h-3 w-3 mr-0.5" />
                              {t('gitStatusPanel.actions.unstageAll')}
                            </Button>
                          </span>
                        )}
                        {item.section === 'modified' && hasUnstaged && (
                          <span onClick={(e) => e.stopPropagation()}>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 px-1.5 text-[10px]"
                              onClick={handleStageAll}
                              title={t('gitStatusPanel.actions.stageAllTitle')}
                              data-testid="git-stage-all"
                            >
                              <Plus className="h-3 w-3 mr-0.5" />
                              {t('gitStatusPanel.actions.stageAll')}
                            </Button>
                          </span>
                        )}
                      </button>
                    </div>
                  ) : (
                    <ContextMenu>
                      <ContextMenuTrigger asChild>
                        <FileItem
                          file={item.file}
                          onToggle={handleToggleFile}
                          onViewDiff={handleViewDiff}
                          isStaged={item.isStaged}
                        />
                      </ContextMenuTrigger>
                      <ContextMenuContent className="w-48">
                        <ContextMenuItem onClick={() => handleOpenSourceFile(item.file)}>
                          <FileCode className="mr-2 h-4 w-4" />
                          {t('gitStatusPanel.contextMenu.openSourceFile')}
                        </ContextMenuItem>
                        <ContextMenuItem onClick={() => handleViewDiff(item.file)}>
                          <FileDiff className="mr-2 h-4 w-4" />
                          {t('gitStatusPanel.contextMenu.viewChanges')}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={() => handleCopyPath(item.file)}>
                          <Copy className="mr-2 h-4 w-4" />
                          {t('gitStatusPanel.contextMenu.copyPath')}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Commit Form - show when there are staged changes */}
      {hasStaged && <GitCommitForm worktreePath={worktreePath} />}

      {/* Push/Pull Controls */}
      <GitPushPull worktreePath={worktreePath} />
    </div>
  )
}
