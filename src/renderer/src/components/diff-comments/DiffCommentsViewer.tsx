import { useEffect, useMemo } from 'react'
import { MessageSquare, Paperclip, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useDiffCommentStore } from '@/stores/useDiffCommentStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n/useI18n'
import type { DiffComment } from '@shared/types/git'

const EMPTY_DIFF_COMMENTS: DiffComment[] = []

interface DiffCommentsViewerProps {
  worktreeId: string
  worktreePath: string | null
  compact?: boolean
}

export function DiffCommentsViewer({
  worktreeId,
  worktreePath,
  compact = false
}: DiffCommentsViewerProps): React.JSX.Element {
  const { t } = useI18n()
  const comments = useDiffCommentStore(
    (s) => s.worktreeComments.get(worktreeId) ?? EMPTY_DIFF_COMMENTS
  )
  const loading = useDiffCommentStore((s) => s.loadingKeys.has(`${worktreeId}\u0000*`))
  const loadWorktreeComments = useDiffCommentStore((s) => s.loadWorktreeComments)
  const attachComment = useDiffCommentStore((s) => s.attachComment)
  const deleteComment = useDiffCommentStore((s) => s.deleteComment)

  useEffect(() => {
    loadWorktreeComments(worktreeId)
  }, [worktreeId, loadWorktreeComments])

  const grouped = useMemo(() => {
    const next = new Map<string, DiffComment[]>()
    for (const comment of comments) {
      const fileComments = next.get(comment.filePath) ?? []
      fileComments.push(comment)
      next.set(comment.filePath, fileComments)
    }
    return Array.from(next.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [comments])

  const handleNavigate = (comment: DiffComment): void => {
    if (!worktreePath) return
    useFileViewerStore.getState().setActiveDiff({
      worktreePath,
      worktreeId,
      filePath: comment.filePath,
      fileName: comment.filePath.split('/').pop() || comment.filePath,
      staged: comment.staged,
      isUntracked: false,
      compareBranch: comment.compareBranch ?? undefined,
      scrollToLine: comment.lineNumber
    })
  }

  return (
    <div className={cn('flex min-h-0 flex-col', compact ? 'border-b border-border' : 'flex-1')}>
      <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-2 py-1.5">
        <MessageSquare className="h-3.5 w-3.5 text-emerald-400" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {t('diffComments.sidebar.title')}
        </span>
        <span className="text-[11px] text-muted-foreground">{comments.length}</span>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          disabled={loading}
          onClick={() => loadWorktreeComments(worktreeId)}
          title={t('diffComments.sidebar.refresh')}
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </Button>
      </div>

      {comments.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-3 py-8 text-muted-foreground">
          <MessageSquare className="h-6 w-6" />
          <span className="text-xs">{t('diffComments.sidebar.empty')}</span>
        </div>
      ) : (
        <div className={cn('overflow-y-auto', compact ? 'max-h-52' : 'flex-1')}>
          {grouped.map(([filePath, fileComments]) => (
            <div key={filePath} className="border-b border-border last:border-b-0">
              <div className="px-3 py-1.5 font-mono text-[11px] text-foreground">{filePath}</div>
              <div className="space-y-px px-1 pb-1.5">
                {fileComments.map((comment) => (
                  <div
                    key={comment.id}
                    role="button"
                    tabIndex={0}
                    className="group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/40"
                    onClick={() => handleNavigate(comment)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        handleNavigate(comment)
                      }
                    }}
                  >
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      :{comment.lineNumber}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-muted-foreground">{comment.body}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        className="rounded p-1 text-muted-foreground hover:text-foreground"
                        title={t('diffComments.attachToChat')}
                        onClick={(event) => {
                          event.stopPropagation()
                          attachComment(comment)
                          toast.success(t('diffComments.toasts.attached'))
                        }}
                      >
                        <Paperclip className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        className="rounded p-1 text-muted-foreground hover:text-destructive"
                        title={t('diffComments.delete')}
                        onClick={(event) => {
                          event.stopPropagation()
                          deleteComment(comment.id)
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
