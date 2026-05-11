import { useCallback } from 'react'
import {
  AlignJustify,
  ChevronDown,
  ChevronUp,
  Columns2,
  Copy,
  ListCollapse,
  MessageSquarePlus,
  X
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/useI18n'
import { cn } from '@/lib/utils'

export type MonacoDiffViewMode = 'split' | 'inline' | 'hunk'

interface MonacoDiffToolbarProps {
  fileName: string
  staged: boolean
  isUntracked: boolean
  compareBranch?: string
  viewMode: MonacoDiffViewMode
  onViewModeChange: (viewMode: MonacoDiffViewMode) => void
  commentCount?: number
  onAddComment?: () => void
  onPrevHunk: () => void
  onNextHunk: () => void
  onCopy: () => void
  onClose: () => void
}

export function MonacoDiffToolbar({
  fileName,
  staged,
  isUntracked,
  compareBranch,
  viewMode,
  onViewModeChange,
  commentCount = 0,
  onAddComment,
  onPrevHunk,
  onNextHunk,
  onCopy,
  onClose
}: MonacoDiffToolbarProps): React.JSX.Element {
  const { t } = useI18n()
  const statusLabel = compareBranch
    ? t('diffUi.status.compareBranch', { branch: compareBranch })
    : staged
      ? t('diffUi.status.staged')
      : isUntracked
        ? t('diffUi.status.newFile')
        : t('diffUi.status.unstaged')

  const handleCopy = useCallback(async () => {
    onCopy()
    toast.success(t('diffUi.toasts.diffCopied'))
  }, [onCopy, t])

  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/30 shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium truncate" data-testid="monaco-diff-filename">
          {fileName}
        </span>
        <span className="text-xs text-muted-foreground shrink-0">{statusLabel}</span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {/* Hunk navigation */}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onPrevHunk}
          title={t('diffUi.actions.previousChange')}
          data-testid="monaco-diff-prev-hunk"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onNextHunk}
          title={t('diffUi.actions.nextChange')}
          data-testid="monaco-diff-next-hunk"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>

        <div className="w-px h-4 bg-border mx-1" />

        <div
          className="flex items-center rounded-md border border-border/60 bg-background/70 p-0.5"
          role="group"
          aria-label={t('diffUi.actions.viewModeGroup')}
          data-testid="monaco-diff-view-mode-group"
        >
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-5 w-5 rounded-[5px]',
              viewMode === 'split' && 'bg-accent text-accent-foreground'
            )}
            onClick={() => onViewModeChange('split')}
            title={t('diffUi.actions.switchToSideBySideView')}
            aria-label={t('diffUi.actions.switchToSideBySideView')}
            data-testid="monaco-diff-view-split"
          >
            <Columns2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-5 w-5 rounded-[5px]',
              viewMode === 'inline' && 'bg-accent text-accent-foreground'
            )}
            onClick={() => onViewModeChange('inline')}
            title={t('diffUi.actions.switchToInlineView')}
            aria-label={t('diffUi.actions.switchToInlineView')}
            data-testid="monaco-diff-view-inline"
          >
            <AlignJustify className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-5 w-5 rounded-[5px]',
              viewMode === 'hunk' && 'bg-accent text-accent-foreground'
            )}
            onClick={() => onViewModeChange('hunk')}
            title={t('diffUi.actions.switchToHunkView')}
            aria-label={t('diffUi.actions.switchToHunkView')}
            data-testid="monaco-diff-view-hunk"
          >
            <ListCollapse className="h-3.5 w-3.5" />
          </Button>
        </div>

        {onAddComment && (
          <Button
            variant="ghost"
            size="icon"
            className="relative h-6 w-6"
            onClick={onAddComment}
            title={t('diffComments.addAtCurrentLine')}
            aria-label={t('diffComments.addAtCurrentLine')}
            data-testid="monaco-diff-add-comment"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            {commentCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 min-w-3 rounded-full bg-emerald-500 px-0.5 text-[8px] leading-3 text-white">
                {commentCount}
              </span>
            )}
          </Button>
        )}

        {/* Copy */}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={handleCopy}
          title={t('diffUi.actions.copyToClipboard')}
          data-testid="monaco-diff-copy-button"
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>

        <div className="w-px h-4 bg-border mx-1" />

        {/* Close */}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onClose}
          title={t('diffUi.actions.closeWithEsc')}
          data-testid="monaco-diff-close-button"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
