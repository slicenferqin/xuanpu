import { useEffect, useCallback, useRef, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { FolderOpen } from 'lucide-react'
import { useFileTreeStore } from '@/stores/useFileTreeStore'
import { useGitStore } from '@/stores/useGitStore'
import { FileTreeHeader } from './FileTreeHeader'
import { FileTreeFilter } from './FileTreeFilter'
import { FileIcon } from './FileIcon'
import { VirtualFileTreeNode } from './FileTreeNode'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'
import { scoreMatch } from '@/lib/file-search-utils'
import type { FlatFile } from '@/lib/file-search-utils'

// File tree node structure
interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  isSymlink?: boolean
  extension: string | null
  children?: FileTreeNode[]
}

// Git file status
interface GitFileStatus {
  path: string
  relativePath: string
  status: 'M' | 'A' | 'D' | '?' | 'C' | ''
  staged: boolean
}

interface FlatNode {
  node: FileTreeNode
  depth: number
  isExpanded: boolean
}

interface FileTreeProps {
  worktreePath: string | null
  isConnectionMode?: boolean
  onClose?: () => void
  onFileClick?: (node: FileTreeNode) => void
  className?: string
  hideHeader?: boolean
  hideGitIndicators?: boolean
  hideGitContextActions?: boolean
}

// Helper to check if a node matches the filter
function matchesFilter(node: FileTreeNode, filter: string): boolean {
  return node.name.toLowerCase().includes(filter.toLowerCase())
}

// Helper to check if any descendant matches the filter
function hasMatchingDescendant(node: FileTreeNode, filter: string): boolean {
  if (!node.children) return false
  for (const child of node.children) {
    if (matchesFilter(child, filter)) return true
    if (child.isDirectory && hasMatchingDescendant(child, filter)) return true
  }
  return false
}

// Flatten tree into a list for virtual scrolling
function flattenTree(
  nodes: FileTreeNode[],
  expandedPaths: Set<string>,
  filter: string,
  depth: number = 0
): FlatNode[] {
  const result: FlatNode[] = []
  const isFiltered = filter.length > 0

  for (const node of nodes) {
    // Filter check
    if (
      isFiltered &&
      !matchesFilter(node, filter) &&
      !(node.isDirectory && hasMatchingDescendant(node, filter))
    ) {
      continue
    }

    const isExpanded = expandedPaths.has(node.path)
    result.push({ node, depth, isExpanded })

    // Include children if expanded or filtered with matching descendants
    const showChildren =
      node.isDirectory &&
      node.children &&
      (isExpanded || (isFiltered && hasMatchingDescendant(node, filter)))

    if (showChildren && node.children) {
      result.push(...flattenTree(node.children, expandedPaths, filter, depth + 1))
    }
  }

  return result
}

const ROW_HEIGHT = 24
const EMPTY_TREE: FileTreeNode[] = []
const EMPTY_GIT_STATUSES: GitFileStatus[] = []
const EMPTY_EXPANDED_PATHS = new Set<string>()

export function FileTree({
  worktreePath,
  isConnectionMode,
  onClose,
  onFileClick,
  className,
  hideHeader,
  hideGitIndicators,
  hideGitContextActions
}: FileTreeProps): React.JSX.Element {
  const { t } = useI18n()
  const isLoading = useFileTreeStore((state) => state.isLoading)
  const error = useFileTreeStore((state) => state.error)
  const fileTreeByWorktree = useFileTreeStore((state) => state.fileTreeByWorktree)
  const expandedPathsByWorktree = useFileTreeStore((state) => state.expandedPathsByWorktree)
  const filterByWorktree = useFileTreeStore((state) => state.filterByWorktree)
  const loadFileTree = useFileTreeStore((state) => state.loadFileTree)
  const toggleExpanded = useFileTreeStore((state) => state.toggleExpanded)
  const collapseAll = useFileTreeStore((state) => state.collapseAll)
  const setFilter = useFileTreeStore((state) => state.setFilter)
  const startWatching = useFileTreeStore((state) => state.startWatching)
  const stopWatching = useFileTreeStore((state) => state.stopWatching)
  const fileIndexByWorktree = useFileTreeStore((state) => state.fileIndexByWorktree)
  const loadFileIndex = useFileTreeStore((state) => state.loadFileIndex)

  const fileStatusesByWorktree = useGitStore((state) => state.fileStatusesByWorktree)
  const loadFileStatuses = useGitStore((state) => state.loadFileStatuses)

  const currentWorktreeRef = useRef<string | null>(null)
  const parentRef = useRef<HTMLDivElement>(null)

  // Load file tree, git statuses, and start watching when worktree changes
  useEffect(() => {
    if (!worktreePath) return

    // If switching worktrees, stop watching the previous one
    if (currentWorktreeRef.current && currentWorktreeRef.current !== worktreePath) {
      stopWatching(currentWorktreeRef.current)
    }

    currentWorktreeRef.current = worktreePath

    // Load file tree
    loadFileTree(worktreePath)

    // Load git statuses (skip for connection paths — no .git directory)
    if (!isConnectionMode) loadFileStatuses(worktreePath)

    // Start watching (store handles onChange subscription internally)
    startWatching(worktreePath)
  }, [worktreePath, isConnectionMode, loadFileTree, loadFileStatuses, startWatching, stopWatching])

  // Cleanup watching on unmount
  useEffect(() => {
    return () => {
      if (currentWorktreeRef.current) {
        stopWatching(currentWorktreeRef.current)
      }
    }
  }, [stopWatching])

  const tree = worktreePath ? (fileTreeByWorktree.get(worktreePath) ?? EMPTY_TREE) : EMPTY_TREE
  const expandedPaths = worktreePath
    ? (expandedPathsByWorktree.get(worktreePath) ?? EMPTY_EXPANDED_PATHS)
    : EMPTY_EXPANDED_PATHS
  const filter = worktreePath ? (filterByWorktree.get(worktreePath) ?? '') : ''
  const gitStatuses = worktreePath
    ? (fileStatusesByWorktree.get(worktreePath) ?? EMPTY_GIT_STATUSES)
    : EMPTY_GIT_STATUSES

  // Build a Map for fast git status lookup
  const gitStatusMap = useMemo(() => {
    const map = new Map<string, GitFileStatus>()
    for (const status of gitStatuses) {
      map.set(status.relativePath, status)
    }
    return map
  }, [gitStatuses])

  // ── Flat search mode: when filter ≥2 chars, use full file index ──
  const isSearchMode = filter.length >= 2
  const flatIndex = worktreePath ? fileIndexByWorktree.get(worktreePath) : undefined

  // Load flat file index on-demand when search mode activates
  useEffect(() => {
    if (isSearchMode && worktreePath && !flatIndex) {
      loadFileIndex(worktreePath)
    }
  }, [isSearchMode, worktreePath, flatIndex, loadFileIndex])

  const MAX_FLAT_RESULTS = 100

  const flatSearchResults = useMemo(() => {
    if (!isSearchMode || !flatIndex) return null
    return flatIndex
      .map((file) => ({ ...file, score: scoreMatch(filter, file) }))
      .filter((file) => file.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_FLAT_RESULTS)
  }, [isSearchMode, flatIndex, filter])

  const handleFlatFileClick = useCallback(
    (file: FlatFile) => {
      onFileClick?.({
        name: file.name,
        path: file.path,
        relativePath: file.relativePath,
        isDirectory: false,
        extension: file.extension
      })
    },
    [onFileClick]
  )

  // Flatten tree for virtual scrolling
  const flatNodes = useMemo(
    () => flattenTree(tree, expandedPaths, filter),
    [tree, expandedPaths, filter]
  )

  // Virtual scrolling
  const displayCount =
    flatSearchResults !== null ? flatSearchResults.length : flatNodes.length
  const virtualizer = useVirtualizer({
    count: displayCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10
  })

  const handleToggle = useCallback(
    (path: string) => {
      if (worktreePath) {
        toggleExpanded(worktreePath, path)
      }
    },
    [worktreePath, toggleExpanded]
  )

  const handleCollapseAll = useCallback(() => {
    if (worktreePath) {
      collapseAll(worktreePath)
    }
  }, [worktreePath, collapseAll])

  const handleFilterChange = useCallback(
    (value: string) => {
      if (worktreePath) {
        setFilter(worktreePath, value)
      }
    },
    [worktreePath, setFilter]
  )

  const handleRefresh = useCallback(() => {
    if (worktreePath) {
      loadFileTree(worktreePath)
      if (!isConnectionMode) loadFileStatuses(worktreePath)
    }
  }, [worktreePath, isConnectionMode, loadFileTree, loadFileStatuses])

  const headerElement = !hideHeader ? (
    <FileTreeHeader
      filter={filter}
      isLoading={isLoading}
      onFilterChange={handleFilterChange}
      onRefresh={handleRefresh}
      onCollapseAll={handleCollapseAll}
      onClose={onClose}
    />
  ) : (
    <div className="p-2 border-b">
      <FileTreeFilter value={filter} onChange={handleFilterChange} />
    </div>
  )

  // No worktree selected
  if (!worktreePath) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        {!hideHeader ? (
          <FileTreeHeader
            filter=""
            isLoading={false}
            onFilterChange={() => {}}
            onRefresh={() => {}}
            onCollapseAll={() => {}}
            onClose={onClose}
          />
        ) : (
          <div className="p-2 border-b">
            <FileTreeFilter value="" onChange={() => {}} />
          </div>
        )}
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-muted-foreground">
            <FolderOpen className="h-10 w-10 mx-auto mb-3 opacity-50" />
            <p className="text-sm">{t('fileTree.empty.noWorktreeTitle')}</p>
            <p className="text-xs mt-1 opacity-75">{t('fileTree.empty.noWorktreeHint')}</p>
          </div>
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        {headerElement}
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-destructive">
            <p className="text-sm font-medium">{t('fileTree.empty.errorTitle')}</p>
            <p className="text-xs mt-1 opacity-75">{error}</p>
          </div>
        </div>
      </div>
    )
  }

  // Loading state
  if (isLoading && tree.length === 0) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        {headerElement}
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-muted-foreground">
            <div
              className="h-6 w-6 mx-auto mb-3 border-2 border-current border-t-transparent rounded-full animate-spin"
              aria-label={t('fileTree.empty.loadingAria')}
            />
            <p className="text-sm">{t('fileTree.empty.loading')}</p>
          </div>
        </div>
      </div>
    )
  }

  // Empty state
  if (tree.length === 0) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        {headerElement}
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-muted-foreground">
            <FolderOpen className="h-10 w-10 mx-auto mb-3 opacity-50" />
            <p className="text-sm">{t('fileTree.empty.noFiles')}</p>
          </div>
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        <FileTreeHeader
          filter={filter}
          isLoading={isLoading}
          onFilterChange={handleFilterChange}
          onRefresh={handleRefresh}
          onCollapseAll={handleCollapseAll}
          onClose={onClose}
        />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-destructive">
            <p className="text-sm font-medium">{t('fileTree.empty.errorTitle')}</p>
            <p className="text-xs mt-1 opacity-75">{error}</p>
          </div>
        </div>
      </div>
    )
  }

  // Loading state
  if (isLoading && tree.length === 0) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        <FileTreeHeader
          filter={filter}
          isLoading={isLoading}
          onFilterChange={handleFilterChange}
          onRefresh={handleRefresh}
          onCollapseAll={handleCollapseAll}
          onClose={onClose}
        />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-muted-foreground">
            <div
              className="h-6 w-6 mx-auto mb-3 border-2 border-current border-t-transparent rounded-full animate-spin"
              aria-label={t('fileTree.empty.loadingAria')}
            />
            <p className="text-sm">{t('fileTree.empty.loading')}</p>
          </div>
        </div>
      </div>
    )
  }

  // Empty state
  if (tree.length === 0) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        <FileTreeHeader
          filter={filter}
          isLoading={isLoading}
          onFilterChange={handleFilterChange}
          onRefresh={handleRefresh}
          onCollapseAll={handleCollapseAll}
          onClose={onClose}
        />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center text-muted-foreground">
            <FolderOpen className="h-10 w-10 mx-auto mb-3 opacity-50" />
            <p className="text-sm">{t('fileTree.empty.noFiles')}</p>
          </div>
        </div>
      </div>
    )
  }

  const isFiltered = filter.length > 0

  return (
    <div className={cn('flex flex-col h-full', className)} data-testid="file-tree">
      {headerElement}
      <div
        ref={parentRef}
        className="flex-1 overflow-auto py-1"
        role={flatSearchResults !== null ? 'listbox' : 'tree'}
        aria-label={t('fileTree.ariaLabel')}
        data-testid="file-tree-content"
      >
        {flatSearchResults !== null ? (
          // ── Flat search results mode ──
          flatSearchResults.length === 0 ? (
            <div className="flex items-center justify-center p-4 text-sm text-muted-foreground">
              {t('fileTree.empty.noFiles')}
            </div>
          ) : (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative'
              }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const file = flatSearchResults[virtualRow.index]
                return (
                  <div
                    key={file.path}
                    role="option"
                    className="absolute top-0 left-0 w-full flex items-center gap-2 px-3 cursor-pointer text-xs hover:bg-sidebar-accent/50 rounded-sm"
                    style={{
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`
                    }}
                    onClick={() => handleFlatFileClick(file)}
                  >
                    <FileIcon
                      name={file.name}
                      extension={file.extension}
                      isDirectory={false}
                      className="flex-shrink-0"
                    />
                    <div className="flex flex-col min-w-0 leading-tight">
                      <span className="truncate font-medium">{file.name}</span>
                      <span className="truncate text-[10px] text-muted-foreground">
                        {file.relativePath}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )
        ) : (
          // ── Normal tree mode ──
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative'
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const { node, depth, isExpanded } = flatNodes[virtualRow.index]
              return (
                <div
                  key={node.path}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  <VirtualFileTreeNode
                    node={node}
                    depth={depth}
                    isExpanded={isExpanded}
                    isFiltered={isFiltered}
                    filter={filter}
                    onToggle={handleToggle}
                    onFileClick={onFileClick}
                    worktreePath={worktreePath}
                    gitStatusMap={gitStatusMap}
                    hideGitIndicators={hideGitIndicators}
                    hideGitContextActions={hideGitContextActions}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
