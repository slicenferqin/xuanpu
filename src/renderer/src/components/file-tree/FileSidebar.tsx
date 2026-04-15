import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useGitStore } from '@/stores/useGitStore'
import { FileTree } from './FileTree'
import { ChangesView } from './ChangesView'
import { BranchDiffView } from './BranchDiffView'
import { PrReviewViewer } from '@/components/pr-review/PrReviewViewer'
import { useI18n } from '@/i18n/useI18n'

interface ConnectionMemberInfo {
  worktree_path: string
  project_name: string
  worktree_branch: string
}

interface FileSidebarProps {
  worktreePath: string | null
  isConnectionMode?: boolean
  connectionMembers?: ConnectionMemberInfo[]
  onClose: () => void
  onFileClick: (node: { path: string; name: string; isDirectory: boolean }) => void
  className?: string
}

export function FileSidebar({
  worktreePath,
  isConnectionMode,
  connectionMembers,
  onClose,
  onFileClick,
  className
}: FileSidebarProps): React.JSX.Element {
  const { t, supportsFirstCharHint } = useI18n()
  const [activeTab, setActiveTab] = useState<'changes' | 'files' | 'diffs' | 'comments'>('changes')
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)
  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId)
  const hasAttachedPR = useGitStore(
    (s) => !!(selectedWorktreeId && s.attachedPR.get(selectedWorktreeId))
  )

  useEffect(() => {
    const handler = (e: Event): void => {
      if (!vimModeEnabled) return
      const tab = (e as CustomEvent).detail?.tab
      if (tab === 'changes' || tab === 'files' || tab === 'diffs' || tab === 'comments') {
        setActiveTab(tab)
      }
    }
    window.addEventListener('hive:right-sidebar-tab', handler)
    return () => window.removeEventListener('hive:right-sidebar-tab', handler)
  }, [vimModeEnabled])

  // Switch away from comments tab if PR is detached
  useEffect(() => {
    if (!hasAttachedPR && activeTab === 'comments') {
      setActiveTab('changes')
    }
  }, [hasAttachedPR, activeTab])

  return (
    <div className={cn('flex h-full flex-col bg-transparent', className)}>
      <div className="flex items-center gap-2 border-b border-sidebar-border/60 px-2.5 py-2">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="inline-flex min-w-max items-center gap-1 rounded-lg bg-sidebar-accent/40 p-0.5">
            <button
              className={cn(
                'shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                activeTab === 'changes'
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
              )}
              onClick={() => setActiveTab('changes')}
            >
              {vimModeEnabled && supportsFirstCharHint ? (
                <>
                  <span className="text-primary">C</span>hanges
                </>
              ) : (
                t('fileTree.sidebar.changes')
              )}
            </button>
            <button
              className={cn(
                'shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                activeTab === 'files'
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
              )}
              onClick={() => setActiveTab('files')}
            >
              {vimModeEnabled && supportsFirstCharHint ? (
                <>
                  <span className="text-primary">F</span>iles
                </>
              ) : (
                t('fileTree.sidebar.files')
              )}
            </button>
            <button
              className={cn(
                'shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                activeTab === 'diffs'
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
              )}
              onClick={() => setActiveTab('diffs')}
            >
              {vimModeEnabled && supportsFirstCharHint ? (
                <>
                  <span className="text-primary">D</span>iffs
                </>
              ) : (
                t('fileTree.sidebar.diffs')
              )}
            </button>
            {hasAttachedPR && (
              <button
                className={cn(
                  'shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                  activeTab === 'comments'
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
                )}
                onClick={() => setActiveTab('comments')}
              >
                {vimModeEnabled && supportsFirstCharHint ? (
                  <>
                    C<span className="text-primary">o</span>mments
                  </>
                ) : (
                  t('fileTree.sidebar.comments')
                )}
              </button>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="ml-auto rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
          aria-label={t('fileTree.sidebar.closeSidebar')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex flex-1 min-h-0 flex-col overflow-hidden bg-transparent">
        {activeTab === 'comments' && selectedWorktreeId ? (
          <PrReviewViewer worktreeId={selectedWorktreeId} />
        ) : activeTab === 'changes' ? (
          <ChangesView
            worktreePath={worktreePath}
            isConnectionMode={isConnectionMode}
            connectionMembers={connectionMembers}
          />
        ) : activeTab === 'diffs' ? (
          <BranchDiffView worktreePath={worktreePath} />
        ) : (
          <FileTree
            worktreePath={worktreePath}
            isConnectionMode={isConnectionMode}
            onClose={onClose}
            onFileClick={onFileClick}
            hideHeader
            hideGitIndicators
            hideGitContextActions
          />
        )}
      </div>
    </div>
  )
}
