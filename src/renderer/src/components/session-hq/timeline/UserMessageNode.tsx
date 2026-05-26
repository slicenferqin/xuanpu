import type React from 'react'
import type { TimelineMessage } from '@shared/lib/timeline-types'
import type { MessagePart } from '@shared/types/opencode'
import { CopyMessageButton } from '@/components/sessions/CopyMessageButton'
import { ForkMessageButton } from '@/components/sessions/ForkMessageButton'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/useI18n'
import { formatMessageTime } from '@/lib/format-time'
import { getMessageDisplayContent } from '@/lib/message-actions'
import type { TimelineNode } from '@/lib/session-timeline/view-model'
import { cn } from '@/lib/utils'
import { FileText, Pencil } from 'lucide-react'

interface UserMessageNodeProps {
  node: TimelineNode
  canEditUserMessage?: (message: TimelineMessage) => boolean
  editingMessageId?: string | null
  editingContent?: string
  onEditingContentChange?: (content: string) => void
  onSaveUserMessageEdit?: (messageId: string) => void | Promise<void>
  onCancelUserMessageEdit?: () => void
  onCopyUserMessage?: (message: TimelineMessage) => void
  onEditUserMessage?: (message: TimelineMessage) => void
  onForkUserMessage?: (message: TimelineMessage) => void | Promise<void>
  forkingMessageId?: string | null
}

export function UserMessageNode({
  node,
  canEditUserMessage,
  editingMessageId,
  editingContent,
  onEditingContentChange,
  onSaveUserMessageEdit,
  onCancelUserMessageEdit,
  onCopyUserMessage,
  onEditUserMessage,
  onForkUserMessage,
  forkingMessageId
}: UserMessageNodeProps): React.JSX.Element {
  const { t } = useI18n()
  type FilePart = Extract<MessagePart, { type: 'file' }>

  const images = (node.attachments?.filter(
    (a) => a.type === 'file' && a.mime.startsWith('image/')
  ) ?? []) as FilePart[]
  const files = (node.attachments?.filter(
    (a) => a.type === 'file' && !a.mime.startsWith('image/')
  ) ?? []) as FilePart[]
  const displayText = getMessageDisplayContent(node.textContent ?? '')
  const isEditing = editingMessageId === node.message.id
  const canEdit = canEditUserMessage?.(node.message) ?? false
  const timestampLabel = node.message.timestamp ? formatMessageTime(node.message.timestamp) : ''

  return (
    <div className="group/user-message flex justify-end">
      <div className="relative flex max-w-[82%] min-w-0 flex-col items-end pb-8">
        <div
          className={cn(
            'max-w-full rounded-2xl border border-primary/20 bg-primary/10 px-4 py-3 text-foreground shadow-sm transition-colors hover:border-primary/30 hover:bg-primary/14',
            isEditing ? 'w-[min(42rem,82vw)]' : 'w-fit'
          )}
          data-testid={`timeline-user-bubble-${node.message.id}`}
        >
          {node.message.steered === true && (
            <div className="mb-2">
              <span className="inline-flex items-center rounded-md bg-neon-violet-soft px-2 py-0.5 text-[10px] font-semibold text-neon-violet">
                {t('sessionHq.timeline.steered')}
              </span>
            </div>
          )}
          {node.message.deliveryStatus === 'queued' && (
            <div className="mb-2">
              <span className="inline-flex items-center rounded-md bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                {t('queuedMessageBubble.badge')}
              </span>
            </div>
          )}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((img, i) => (
                <img
                  key={i}
                  src={img.url}
                  alt={img.filename ?? 'attachment'}
                  className="max-h-48 max-w-[280px] rounded-lg border border-border/50 object-contain"
                />
              ))}
            </div>
          )}
          {files.length > 0 && (
            <div className={cn('flex flex-wrap gap-2', images.length > 0 && 'mt-2')}>
              {files.map((f, i) => (
                <div
                  key={i}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2.5 py-1.5 text-xs text-muted-foreground"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  {f.filename ?? 'file'}
                </div>
              ))}
            </div>
          )}
          {isEditing ? (
            <div className={cn((images.length > 0 || files.length > 0) && 'mt-2')}>
              <textarea
                value={editingContent ?? ''}
                onChange={(e) => onEditingContentChange?.(e.target.value)}
                className="min-h-[96px] w-full resize-y rounded-lg border border-border/70 bg-background/55 px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring/20"
                autoFocus
                data-testid="timeline-user-edit-textarea"
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={onCancelUserMessageEdit}>
                  {t('editMessageButton.cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={!editingContent?.trim()}
                  onClick={() => {
                    void onSaveUserMessageEdit?.(node.message.id)
                  }}
                >
                  {t('editMessageButton.save')}
                </Button>
              </div>
            </div>
          ) : displayText ? (
            <div
              className={cn(
                'crisp-readable text-sm text-foreground whitespace-pre-wrap break-words',
                (images.length > 0 || files.length > 0) && 'mt-2'
              )}
            >
              {displayText}
            </div>
          ) : null}
        </div>
        <div
          className="absolute right-0 bottom-0 flex items-center justify-end gap-1.5 text-xs text-muted-foreground"
          data-testid={`timeline-user-actions-${node.message.id}`}
        >
          {timestampLabel && (
            <span data-testid={`timeline-user-timestamp-${node.message.id}`}>{timestampLabel}</span>
          )}
          {!isEditing && (
            <>
              <CopyMessageButton
                content={displayText}
                className="h-7 w-7 rounded-full bg-transparent opacity-0 group-hover/user-message:opacity-100"
                showOnHoverClassName=""
                unstyled
                onCopy={() => onCopyUserMessage?.(node.message)}
              />
              {canEdit && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 rounded-full p-0 opacity-0 transition-opacity group-hover/user-message:opacity-100"
                  aria-label={t('editMessageButton.ariaLabel')}
                  data-testid="edit-message-button"
                  onClick={() => onEditUserMessage?.(node.message)}
                >
                  <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              )}
              {onForkUserMessage && (
                <ForkMessageButton
                  onFork={() => onForkUserMessage(node.message)}
                  isForking={forkingMessageId === node.message.id}
                  disabled={forkingMessageId !== null && forkingMessageId !== node.message.id}
                  className="h-7 w-7 rounded-full bg-transparent opacity-0 group-hover/user-message:opacity-100"
                  showOnHoverClassName=""
                  unstyled
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
