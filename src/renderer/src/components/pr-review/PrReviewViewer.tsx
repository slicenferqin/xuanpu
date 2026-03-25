import { useEffect, useMemo, useCallback } from 'react'
import { Loader2, RefreshCw, MessageSquareCode } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { UNKNOWN_PATH_KEY, UNKNOWN_REVIEWER_KEY, usePRReviewStore } from '@/stores/usePRReviewStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useGitStore } from '@/stores/useGitStore'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { PrReviewFileGroup } from './PrReviewFileGroup'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'
import type { PRReviewComment } from '@shared/types/git'

const EMPTY_COMMENTS: PRReviewComment[] = []

interface PrReviewViewerProps {
  worktreeId: string
}

export function PrReviewViewer({ worktreeId }: PrReviewViewerProps): React.JSX.Element {
  const { t } = useI18n()
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const projects = useProjectStore((s) => s.projects)
  const attachedPR = useGitStore((s) => s.attachedPR.get(worktreeId))

  const loading = usePRReviewStore((s) => s.loading.get(worktreeId) ?? false)
  const error = usePRReviewStore((s) => s.error.get(worktreeId) ?? null)
  const rawComments = usePRReviewStore((s) => s.comments.get(worktreeId) ?? EMPTY_COMMENTS)
  const selectedIds = usePRReviewStore((s) => s.selectedCommentIds)
  const hiddenReviewers = usePRReviewStore((s) => s.hiddenReviewers)
  const fetchComments = usePRReviewStore((s) => s.fetchComments)
  const toggleComment = usePRReviewStore((s) => s.toggleComment)
  const selectAll = usePRReviewStore((s) => s.selectAll)
  const deselectAll = usePRReviewStore((s) => s.deselectAll)
  const toggleReviewer = usePRReviewStore((s) => s.toggleReviewer)
  const attachSelectedToChat = usePRReviewStore((s) => s.attachSelectedToChat)

  // Find project path for the worktree
  const worktree = useMemo(() => {
    for (const wts of worktreesByProject.values()) {
      const wt = wts.find((w) => w.id === worktreeId)
      if (wt) return wt
    }
    return null
  }, [worktreesByProject, worktreeId])
  const project = projects.find((p) => p.id === worktree?.project_id)
  const projectPath = project?.path
  const prNumber = attachedPR?.number

  // Fetch comments on mount
  useEffect(() => {
    if (projectPath && prNumber) {
      fetchComments(worktreeId, projectPath, prNumber)
    }
  }, [worktreeId, projectPath, prNumber, fetchComments])

  const handleRefresh = (): void => {
    if (projectPath && prNumber) {
      fetchComments(worktreeId, projectPath, prNumber)
    }
  }

  // Navigate to a comment's file in the diff viewer
  const handleNavigate = useCallback(
    (comment: PRReviewComment) => {
      if (!worktree?.path || !comment.path) return
      const baseBranch = usePRReviewStore.getState().baseBranch.get(worktreeId)
      if (!baseBranch) return

      useFileViewerStore.getState().setActiveDiff({
        worktreePath: worktree.path,
        filePath: comment.path,
        fileName: comment.path.split('/').pop() || comment.path,
        staged: false,
        isUntracked: false,
        compareBranch: baseBranch,
        scrollToLine: comment.line ?? comment.originalLine ?? undefined,
        prReviewWorktreeId: worktreeId
      })
    },
    [worktreeId, worktree?.path]
  )

  // Derive filtered/grouped data — defensively wrapped so a malformed
  // comment never crashes the whole sidebar.
  const { grouped, threads, reviewers } = useMemo(() => {
    try {
      const visible =
        hiddenReviewers.size === 0
          ? rawComments
          : rawComments.filter(
              (comment) => !hiddenReviewers.has(comment.user?.login ?? UNKNOWN_REVIEWER_KEY)
            )

      const grouped = new Map<string, PRReviewComment[]>()
      for (const comment of visible) {
        const filePath = comment.path ?? UNKNOWN_PATH_KEY
        const existing = grouped.get(filePath) ?? []
        existing.push(comment)
        grouped.set(filePath, existing)
      }
      for (const [filePath, fileComments] of grouped) {
        grouped.set(
          filePath,
          fileComments.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
        )
      }

      const threads = new Map<number, PRReviewComment[]>()
      for (const comment of visible) {
        const threadId = comment.inReplyToId ?? comment.id
        const thread = threads.get(threadId) ?? []
        thread.push(comment)
        threads.set(threadId, thread)
      }
      for (const [threadId, threadComments] of threads) {
        threads.set(
          threadId,
          threadComments.sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          )
        )
      }

      const counts = new Map<string, number>()
      for (const comment of rawComments) {
        const reviewerKey = comment.user?.login ?? UNKNOWN_REVIEWER_KEY
        counts.set(reviewerKey, (counts.get(reviewerKey) ?? 0) + 1)
      }

      return {
        grouped,
        threads,
        reviewers: Array.from(counts.entries())
          .map(([login, count]) => ({ login, count }))
          .sort((a, b) => b.count - a.count)
      }
    } catch (err) {
      console.error('[PrReviewViewer] Error computing derived data:', err)
      return {
        grouped: new Map<string, PRReviewComment[]>(),
        threads: new Map<number, PRReviewComment[]>(),
        reviewers: [] as Array<{ login: string; count: number }>
      }
    }
  }, [rawComments, hiddenReviewers])

  const hasRawComments = rawComments.length > 0

  // Loading state — only when no comments loaded yet
  if (loading && !hasRawComments) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" />
        <span className="text-sm">{t('prReview.viewer.loading')}</span>
      </div>
    )
  }

  // Error state — only when no comments loaded yet
  if (error && !hasRawComments) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
        <MessageSquareCode className="h-8 w-8 text-destructive" />
        <span className="text-sm text-destructive">{error}</span>
        <Button size="sm" variant="outline" onClick={handleRefresh}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          {t('prReview.viewer.retry')}
        </Button>
      </div>
    )
  }

  // True empty state — no comments exist at all
  if (!loading && !hasRawComments) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground">
        <MessageSquareCode className="h-8 w-8" />
        <span className="text-sm">{t('prReview.viewer.empty')}</span>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar — always visible when comments exist */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-muted/30">
        {prNumber && <span className="text-xs text-muted-foreground shrink-0">#{prNumber}</span>}
        <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
          {reviewers.map(({ login, count }) => {
            const displayLogin =
              login === UNKNOWN_REVIEWER_KEY ? t('prReview.store.unknownReviewer') : login

            return (
              <button
                key={login}
                onClick={() => toggleReviewer(login)}
                className={cn(
                  'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[11px] transition-colors',
                  hiddenReviewers.has(login)
                    ? 'bg-muted/50 text-muted-foreground line-through opacity-50'
                    : 'bg-muted text-foreground'
                )}
                title={
                  hiddenReviewers.has(login)
                    ? t('prReview.viewer.reviewer.show', { login: displayLogin })
                    : t('prReview.viewer.reviewer.hide', { login: displayLogin })
                }
              >
                @{displayLogin}
                <span className="text-[10px] text-muted-foreground">{count}</span>
              </button>
            )
          })}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 shrink-0"
          onClick={handleRefresh}
          disabled={loading}
          title={t('prReview.viewer.refresh')}
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </Button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {grouped.size === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
            <MessageSquareCode className="h-6 w-6" />
            <span className="text-xs">{t('prReview.viewer.allHidden')}</span>
          </div>
        ) : (
          Array.from(grouped.entries()).map(([filePath, fileComments]) => (
            <PrReviewFileGroup
              key={filePath}
              filePath={filePath === UNKNOWN_PATH_KEY ? t('prReview.store.unknownPath') : filePath}
              comments={fileComments}
              threads={threads}
              selectedIds={selectedIds}
              onToggleSelect={toggleComment}
              onNavigate={handleNavigate}
            />
          ))
        )}
      </div>

      {/* Sticky footer — only visible when comments are selected */}
      {selectedIds.size > 0 && (
        <div className="flex flex-col gap-2 px-3 py-2.5 border-t border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t('prReview.viewer.selectedCount', { count: selectedIds.size })}
            </span>
            <span className="text-muted-foreground/40">·</span>
            <button
              onClick={() => selectAll(worktreeId)}
              className="text-xs text-violet-400 hover:text-violet-300 transition-colors"
            >
              {t('prReview.viewer.selectAll')}
            </button>
            <button
              onClick={deselectAll}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('prReview.viewer.deselect')}
            </button>
          </div>
          <Button
            size="sm"
            className="w-full h-7 text-xs bg-violet-600 hover:bg-violet-700 text-white"
            onClick={() => {
              attachSelectedToChat(worktreeId)
              // Refocus the session view so the user sees the attached comments
              useFileViewerStore.getState().setActiveFile(null)
              useFileViewerStore.getState().clearActiveDiff()
            }}
          >
            {t('prReview.viewer.addToChat')}
          </Button>
        </div>
      )}
    </div>
  )
}
