/**
 * ComposerBar — Phase 5
 *
 * Unified message composition area driven by the Phase 5 state machine.
 * Uses `determineComposerActions()` to derive button labels, icons, and
 * enabled/disabled states from the session lifecycle + interrupt state.
 *
 * Three-state model:
 *   idle / error       → Send
 *   busy / materializing → Stop+Send (primary)  |  Queue / Steer (alternatives)
 *   retry              → Queue (primary) | Stop+Send (alt)
 *   interrupt pending  → Reply to interrupt
 *
 * Reuses: AttachmentButton, AttachmentPreview from the sessions/ directory.
 */

import React, { useRef, useCallback, useState, useEffect } from 'react'
import { Send, Square, ListPlus, MessageCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AttachmentButton } from '../sessions/AttachmentButton'
import { AttachmentPreview, type Attachment } from '../sessions/AttachmentPreview'
import type { SessionLifecycle, InterruptItem } from '@/stores/useSessionRuntimeStore'
import { isComposingKeyboardEvent } from '@/lib/message-composer-shortcuts'
import {
  determineComposerActions,
  type ComposerAction,
  type ComposerActionSet
} from '@/lib/session-send-actions'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ComposerBarProps {
  sessionId: string
  lifecycle: SessionLifecycle
  pendingCount: number
  firstInterrupt: InterruptItem | null
  /** Called when user executes the primary action with content */
  onAction: (action: ComposerAction, content: string, attachments: Attachment[]) => void
  /** Whether the session is connected and ready to accept input */
  isConnected: boolean
  /** Max attachments allowed */
  maxAttachments?: number
}

// ---------------------------------------------------------------------------
// Icon for action
// ---------------------------------------------------------------------------

function ActionIcon({ hint }: { hint: ComposerActionSet['iconHint'] }): React.JSX.Element {
  switch (hint) {
    case 'send':
      return <Send className="h-3.5 w-3.5 mr-1.5" />
    case 'stop':
      return <Square className="h-3.5 w-3.5 mr-1.5" />
    case 'queue':
      return <ListPlus className="h-3.5 w-3.5 mr-1.5" />
    case 'reply':
      return <MessageCircle className="h-3.5 w-3.5 mr-1.5" />
    case 'disabled':
    default:
      return <Send className="h-3.5 w-3.5 mr-1.5 opacity-40" />
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ComposerBar({
  sessionId,
  lifecycle,
  pendingCount,
  firstInterrupt,
  onAction,
  isConnected,
  maxAttachments = 10
}: ComposerBarProps): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [content, setContent] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])

  // Derive available actions from the state machine
  const actionSet = determineComposerActions({
    lifecycle,
    hasInterrupt: firstInterrupt != null,
    hasPendingMessages: pendingCount > 0,
    isConnected
  })

  const canSend = content.trim().length > 0 || attachments.length > 0
  const isDisabled = !actionSet.inputEnabled

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }, [content])

  // Focus on mount / session change
  useEffect(() => {
    textareaRef.current?.focus()
  }, [sessionId])

  const clearInput = useCallback(() => {
    setContent('')
    setAttachments([])
    const ta = textareaRef.current
    if (ta) ta.style.height = 'auto'
  }, [])

  const handleSubmit = useCallback(() => {
    if (!actionSet.primary) return

    // Stop actions don't need content
    if (actionSet.primary === 'stop_and_send' && !canSend) {
      onAction('stop_and_send', '', [])
      return
    }

    if (!canSend && actionSet.primary !== 'reply_interrupt') return

    onAction(actionSet.primary, content.trim(), attachments)
    clearInput()
  }, [actionSet.primary, canSend, content, attachments, onAction, clearInput])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (isComposingKeyboardEvent(e.nativeEvent)) return
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  const handleAddAttachment = useCallback(
    (newAttachments: Attachment[]) => {
      setAttachments((prev) => {
        const combined = [...prev, ...newAttachments]
        return combined.slice(0, maxAttachments)
      })
    },
    [maxAttachments]
  )

  const handleRemoveAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  // Determine button variant
  const buttonVariant =
    actionSet.iconHint === 'stop' ? 'destructive' : 'default'

  // Determine if button should be enabled
  const buttonEnabled =
    actionSet.primary != null &&
    (actionSet.iconHint === 'stop' || canSend || actionSet.primary === 'reply_interrupt')

  return (
    <div className="border-t border-border bg-background px-4 py-3 shrink-0">
      {/* Pending message indicator */}
      {pendingCount > 0 && (
        <div className="mb-2 text-xs text-muted-foreground flex items-center gap-1.5">
          <ListPlus className="h-3 w-3" />
          {pendingCount} message{pendingCount > 1 ? 's' : ''} queued
        </div>
      )}

      {/* Attachments preview */}
      {attachments.length > 0 && (
        <div className="mb-2">
          <AttachmentPreview
            attachments={attachments}
            onRemove={handleRemoveAttachment}
          />
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-2">
        {/* Attachment button */}
        <AttachmentButton
          onAddAttachments={handleAddAttachment}
          attachmentCount={attachments.length}
          maxAttachments={maxAttachments}
          disabled={isDisabled}
        />

        {/* Text input */}
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              firstInterrupt
                ? 'Type your reply...'
                : actionSet.iconHint === 'stop'
                  ? 'Type to stop and send...'
                  : 'Type a message...'
            }
            disabled={isDisabled}
            className={cn(
              'w-full resize-none rounded-lg border border-input bg-background px-3 py-2',
              'text-sm placeholder:text-muted-foreground',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'min-h-[36px] max-h-[200px]'
            )}
            rows={1}
          />
        </div>

        {/* Primary action button */}
        <Button
          size="sm"
          variant={buttonVariant}
          onClick={handleSubmit}
          disabled={!buttonEnabled}
          className="shrink-0 h-9 px-3"
        >
          <ActionIcon hint={actionSet.iconHint} />
          {actionSet.primaryLabel}
        </Button>
      </div>
    </div>
  )
}
