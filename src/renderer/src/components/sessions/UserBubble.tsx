import { cn } from '@/lib/utils'
import type { MessagePart } from '@shared/types/opencode'
import { Pencil, Check, X } from 'lucide-react'

interface UserBubbleProps {
  content: string
  timestamp?: string
  isPlanMode?: boolean
  isAskMode?: boolean
  isSteered?: boolean
  attachments?: MessagePart[]
  isEditing?: boolean
  isLastUserMessage?: boolean
  canEdit?: boolean
  onEditClick?: () => void
  onEditSave?: () => void
  onEditCancel?: () => void
  editingContent?: string
  onEditingContentChange?: (content: string) => void
}

export function UserBubble({
  content,
  isPlanMode,
  isAskMode,
  isSteered,
  attachments,
  isEditing,
  canEdit,
  onEditClick,
  onEditSave,
  onEditCancel,
  editingContent,
  onEditingContentChange
}: UserBubbleProps): React.JSX.Element {
  const imageAttachments =
    attachments?.filter(
      (a): a is Extract<MessagePart, { type: 'file' }> =>
        a.type === 'file' && a.mime.startsWith('image/')
    ) ?? []

  return (
    <div className="flex justify-end px-6 py-4 group/userbubble" data-testid="message-user">
      <div className="relative max-w-[80%]">
        {canEdit && !isEditing && (
          <button
            onClick={onEditClick}
            className="absolute -left-8 top-3 opacity-0 group-hover/userbubble:opacity-100 transition-opacity p-1 hover:bg-muted rounded"
            title="Edit message"
          >
            <Pencil className="h-4 w-4 text-muted-foreground" />
          </button>
        )}
        <div
          className={cn(
            'rounded-2xl px-4 py-3',
            isPlanMode
              ? 'bg-purple-500/10 text-foreground'
              : isAskMode
                ? 'bg-amber-500/10 text-foreground'
                : 'bg-primary/10 text-foreground'
          )}
        >
          {isPlanMode && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold bg-purple-500/15 text-purple-400 mb-1"
              data-testid="plan-mode-badge"
            >
              PLAN
            </span>
          )}
          {isAskMode && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold bg-amber-500/15 text-amber-400 mb-1"
              data-testid="ask-mode-badge"
            >
              ASK
            </span>
          )}
          {isSteered && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold bg-sky-500/15 text-sky-500 mb-1"
              data-testid="steered-mode-badge"
            >
              STEERED
            </span>
          )}
          {imageAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2" data-testid="user-message-images">
              {imageAttachments.map((att, i) => (
                <img
                  key={i}
                  src={att.url}
                  alt={att.filename ?? 'image'}
                  className="max-h-48 max-w-full rounded-lg border border-border/50 object-contain"
                />
              ))}
            </div>
          )}
          {isEditing ? (
            <>
              <textarea
                value={editingContent}
                onChange={(e) => onEditingContentChange?.(e.target.value)}
                className="w-full min-h-[80px] text-sm bg-background/50 border border-border rounded px-2 py-1 resize-y"
                autoFocus
              />
              <div className="flex gap-2 mt-2">
                <button
                  onClick={onEditSave}
                  disabled={!editingContent?.trim()}
                  className="flex items-center gap-1 px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Check className="h-3 w-3" />
                  Save
                </button>
                <button
                  onClick={onEditCancel}
                  className="flex items-center gap-1 px-3 py-1 text-xs bg-muted text-muted-foreground rounded hover:bg-muted/80"
                >
                  <X className="h-3 w-3" />
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <p className="text-sm whitespace-pre-wrap leading-relaxed">{content}</p>
          )}
        </div>
      </div>
    </div>
  )
}
