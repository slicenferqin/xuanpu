import type React from 'react'
import type { TimelineMessage, StreamingPart } from '@shared/lib/timeline-types'
import { ToolNodeRenderer } from '@/components/session-hq/timeline/ToolNodeRenderer'
import { UserMessageNode } from '@/components/session-hq/timeline/UserMessageNode'
import type { TimelineNode } from '@/lib/session-timeline/view-model'

export interface TimelineNodeRendererProps {
  node: TimelineNode
  sessionId?: string
  worktreePath?: string | null
  childPartsMap?: Map<string, StreamingPart[]>
  planContentByToolUseId?: Map<string, string>
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

export function TimelineNodeRenderer({
  node,
  sessionId,
  worktreePath,
  childPartsMap,
  planContentByToolUseId,
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
}: TimelineNodeRendererProps): React.JSX.Element | null {
  if (node.cardType === 'user-message') {
    return (
      <UserMessageNode
        node={node}
        canEditUserMessage={canEditUserMessage}
        editingMessageId={editingMessageId}
        editingContent={editingContent}
        onEditingContentChange={onEditingContentChange}
        onSaveUserMessageEdit={onSaveUserMessageEdit}
        onCancelUserMessageEdit={onCancelUserMessageEdit}
        onCopyUserMessage={onCopyUserMessage}
        onEditUserMessage={onEditUserMessage}
        onForkUserMessage={onForkUserMessage}
        forkingMessageId={forkingMessageId}
      />
    )
  }

  return (
    <ToolNodeRenderer
      node={node}
      sessionId={sessionId}
      worktreePath={worktreePath}
      childPartsMap={childPartsMap}
      planContentByToolUseId={planContentByToolUseId}
    />
  )
}
