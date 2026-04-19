/**
 * ComposerBar — Phase 5 + Phase 6 enhancements
 *
 * Unified message composition area driven by the Phase 5 state machine.
 * Bottom toolbar includes ModelSelector, ContextIndicator, SessionCostPill,
 * and Plan mode toggle — ported from v1 SessionView.
 */

import React, { useRef, useCallback, useState, useEffect, useMemo } from 'react'
import { ArrowUp, Square, CornerDownLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AttachmentButton } from '../sessions/AttachmentButton'
import { AttachmentPreview, type Attachment } from '../sessions/AttachmentPreview'
import { SlashCommandPopover } from '../sessions/SlashCommandPopover'
import { BUILT_IN_SLASH_COMMANDS } from '../sessions/SessionView'
import { Button } from '@/components/ui/button'
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
  /** Current session mode */
  mode?: 'build' | 'plan'
  /** Callback to toggle plan/build mode */
  onToggleMode?: () => void
  /** Pending plan (truthy means plan is ready for review) */
  pendingPlan?: unknown | null
  /** Worktree path for slash command fetching */
  worktreePath?: string | null
  /** Bumped when session.commands_available fires — triggers re-fetch of SDK commands */
  commandsVersion?: number
  containerRef?: React.RefObject<HTMLDivElement | null>
}

// ---------------------------------------------------------------------------
// Send button icon (icon-only, state-driven)
// ---------------------------------------------------------------------------

function SendIcon({ hint }: { hint: ComposerActionSet['iconHint'] }): React.JSX.Element {
  switch (hint) {
    case 'stop':
      return <Square className="h-3.5 w-3.5" />
    case 'reply':
      return <CornerDownLeft className="h-4 w-4" />
    default:
      return <ArrowUp className="h-4 w-4" />
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
  maxAttachments = 10,
  mode = 'build',
  onToggleMode,
  pendingPlan,
  worktreePath,
  commandsVersion = 0,
  containerRef
}: ComposerBarProps): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [content, setContent] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])

  // --- Draft persistence: save input on unmount/switch, restore on mount ---
  const contentRef = useRef(content)
  useEffect(() => { contentRef.current = content }, [content])

  // Load draft on session change
  useEffect(() => {
    let cancelled = false
    window.db.session.getDraft(sessionId).then((draft) => {
      if (!cancelled && draft) setContent(draft)
    }).catch(() => {})
    return () => {
      cancelled = true
      // Save draft when leaving this session
      const current = contentRef.current.trim()
      window.db.session.updateDraft(sessionId, current || null).catch(() => {})
    }
  }, [sessionId])
  // --- Slash commands ---
  const [slashCommands, setSlashCommands] = useState<{ name: string; description?: string; template: string; agent?: string; builtIn?: boolean }[]>([])
  const [showSlashCommands, setShowSlashCommands] = useState(false)
  const showSlashCommandsRef = useRef(false)

  const allSlashCommands = useMemo(() => {
    const seen = new Set<string>()
    const ordered = [...BUILT_IN_SLASH_COMMANDS, ...slashCommands]
    return ordered.filter((c) => {
      const key = c.name.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [slashCommands])

  // Fetch slash commands on mount and when commands become available
  useEffect(() => {
    let mounted = true
    if (!worktreePath || !window.agentOps?.commands) return
    window.agentOps.commands(worktreePath).then((result) => {
      if (mounted && result?.success && Array.isArray(result.commands)) {
        setSlashCommands(result.commands)
      }
    }).catch(() => {})
    return () => { mounted = false }
  }, [worktreePath, commandsVersion])
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
    window.db.session.updateDraft(sessionId, null).catch(() => {})
    const ta = textareaRef.current
    if (ta) ta.style.height = 'auto'
  }, [sessionId])

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

  const handleAttach = useCallback(
    (file: Omit<Attachment, 'id'>) => {
      setAttachments((prev) => {
        if (prev.length >= maxAttachments) return prev
        return [...prev, { ...file, id: `att-${Date.now()}-${Math.random().toString(36).slice(2)}` }]
      })
    },
    [maxAttachments]
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          const file = item.getAsFile()
          if (!file) continue
          const reader = new FileReader()
          reader.onload = () => {
            handleAttach({
              kind: 'data',
              name: file.name || 'pasted-image.png',
              mime: file.type,
              dataUrl: reader.result as string
            })
          }
          reader.readAsDataURL(file)
        }
      }
    },
    [handleAttach]
  )

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const handleContentChange = useCallback((value: string) => {
    setContent(value)
    const shouldShowSlash = value.startsWith('/') && !value.includes(' ')
    if (shouldShowSlash !== showSlashCommandsRef.current) {
      setShowSlashCommands(shouldShowSlash)
      showSlashCommandsRef.current = shouldShowSlash
    }
  }, [])

  const handleCommandSelect = useCallback((cmd: { name: string; template: string }) => {
    setContent(`/${cmd.name} `)
    setShowSlashCommands(false)
    showSlashCommandsRef.current = false
    textareaRef.current?.focus()
  }, [])

  // Determine if button should be enabled
  const buttonEnabled =
    actionSet.primary != null &&
    (actionSet.iconHint === 'stop' || canSend || actionSet.primary === 'reply_interrupt')

  return (
    <div
      ref={containerRef}
      className={cn(
        'absolute bottom-16 z-20',
        'w-[85%] ml-[5%]',
        'rounded-2xl border border-border/50',
        'bg-background/70 backdrop-blur-xl',
        'shadow-lg shadow-black/5 dark:shadow-black/20'
      )}
    >
      {/* Slash command popover — floats above the card */}
      <SlashCommandPopover
        commands={allSlashCommands}
        filter={content}
        onSelect={handleCommandSelect}
        onClose={() => { setShowSlashCommands(false); showSlashCommandsRef.current = false }}
        visible={showSlashCommands}
      />

      {/* Pending message indicator */}
      {pendingCount > 0 && (
        <div className="px-4 pt-3 pb-0 text-xs text-muted-foreground flex items-center gap-1.5">
          {pendingCount} message{pendingCount > 1 ? 's' : ''} queued
        </div>
      )}

      {/* Attachments preview */}
      {attachments.length > 0 && (
        <div className="px-4 pt-3 pb-0">
          <AttachmentPreview
            attachments={attachments}
            onRemove={handleRemoveAttachment}
          />
        </div>
      )}

      {/* Textarea — seamlessly fills the card top */}
      <div className="px-4 pt-3 pb-1">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => handleContentChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={
            pendingPlan
              ? 'Provide feedback on the plan...'
              : firstInterrupt
                ? 'Type your reply...'
                : actionSet.iconHint === 'stop'
                  ? 'Type to stop and send...'
                  : 'Type a message...'
          }
          disabled={isDisabled}
          className={cn(
            'w-full resize-none bg-transparent border-0 outline-none',
            'text-sm placeholder:text-muted-foreground',
            'focus-visible:outline-none focus-visible:ring-0',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'min-h-[36px] max-h-[200px]'
          )}
          rows={1}
        />
      </div>

      {/* Bottom row: attach + plan + spacer + send */}
      <div className="flex items-center gap-2 px-3 pb-3 pt-1">
        <AttachmentButton
          onAttach={handleAttach}
          disabled={isDisabled}
        />

        {/* Plan mode toggle */}
        {pendingPlan ? (
          <span className="text-xs text-muted-foreground">
            Review the plan above
          </span>
        ) : onToggleMode ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              'h-7 rounded-full border px-2.5 text-xs font-medium transition-[color,background-color,border-color,box-shadow]',
              mode === 'plan'
                ? 'border-violet-300/80 bg-violet-500/10 text-violet-700 shadow-[0_0_0_1px_rgba(196,181,253,0.26),0_0_14px_rgba(167,139,250,0.18)] hover:bg-violet-500/14 hover:text-violet-800 dark:border-violet-400/45 dark:bg-violet-500/12 dark:text-violet-200 dark:shadow-[0_0_0_1px_rgba(167,139,250,0.22),0_0_16px_rgba(139,92,246,0.18)]'
                : 'border-border/70 bg-background/65 text-muted-foreground shadow-none hover:border-border hover:bg-background/85 hover:text-foreground'
            )}
            onClick={onToggleMode}
            title="Toggle Plan Mode (Tab)"
          >
            Plan
          </Button>
        ) : null}

        <div className="flex-1" />

        {/* Send / Stop icon button */}
        <button
          onClick={handleSubmit}
          disabled={!buttonEnabled}
          className={cn(
            'h-8 w-8 rounded-full flex items-center justify-center shrink-0 transition-colors',
            actionSet.iconHint === 'stop'
              ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
              : buttonEnabled
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-muted text-muted-foreground cursor-not-allowed'
          )}
          aria-label={actionSet.primaryLabel}
          title={actionSet.primaryLabel}
        >
          <SendIcon hint={actionSet.iconHint} />
        </button>
      </div>
    </div>
  )
}
