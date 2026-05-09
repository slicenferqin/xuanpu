/**
 * ComposerBar — Phase 5 + Phase 6 enhancements
 *
 * Unified message composition area driven by the Phase 5 state machine.
 * Bottom toolbar includes ModelSelector, ContextIndicator, SessionCostPill,
 * and Plan mode toggle — ported from v1 SessionView.
 */

import React, { useRef, useCallback, useState, useEffect, useMemo } from 'react'
import { ArrowUp, Square, CornerDownLeft, ListPlus, Workflow, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AttachmentButton } from '../sessions/AttachmentButton'
import { AttachmentPreview, type Attachment } from '../sessions/AttachmentPreview'
import { SlashCommandPopover } from '../sessions/SlashCommandPopover'
import { BUILT_IN_SLASH_COMMANDS } from '../sessions/SessionView'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { SessionLifecycle, InterruptItem } from '@/stores/useSessionRuntimeStore'
import { isComposingKeyboardEvent } from '@/lib/message-composer-shortcuts'
import {
  determineComposerActions,
  getActionLabel,
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
  onAction: (action: ComposerAction, content: string, attachments: Attachment[]) => Promise<boolean>
  /** Whether the session is connected and ready to accept input */
  isConnected: boolean
  /** Runtime capability gate for steer */
  supportsSteer?: boolean
  /** Max attachments allowed */
  maxAttachments?: number
  /** Current session mode */
  mode?: 'build' | 'plan'
  /** Callback to toggle plan/build mode */
  onToggleMode?: () => void
  /** Pending plan (truthy means plan is ready for review) */
  pendingPlan?: unknown | null
  /** Codex-only goal launch controls */
  supportsGoalMode?: boolean
  goalMode?: boolean
  onToggleGoalMode?: () => void
  successCriteria?: string
  onSuccessCriteriaChange?: (value: string) => void
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
    case 'queue':
      return <ListPlus className="h-4 w-4" />
    case 'reply':
      return <CornerDownLeft className="h-4 w-4" />
    default:
      return <ArrowUp className="h-4 w-4" />
  }
}

function ActionMenuIcon({ action }: { action: ComposerAction }): React.JSX.Element {
  switch (action) {
    case 'queue':
      return <ListPlus className="h-4 w-4" />
    case 'steer':
      return <Workflow className="h-4 w-4" />
    case 'stop_and_send':
      return <Square className="h-3.5 w-3.5" />
    case 'reply_interrupt':
      return <CornerDownLeft className="h-4 w-4" />
    default:
      return <ArrowUp className="h-4 w-4" />
  }
}

interface ComposerAttachmentsSectionProps {
  attachments: Attachment[]
  onRemove: (id: string) => void
}

const ComposerAttachmentsSection = React.memo(function ComposerAttachmentsSection({
  attachments,
  onRemove
}: ComposerAttachmentsSectionProps): React.JSX.Element {
  return (
    <div className="px-4 pt-3 pb-0">
      <AttachmentPreview attachments={attachments} onRemove={onRemove} />
    </div>
  )
})

interface SuccessCriteriaInputProps {
  value: string
  disabled: boolean
  onChange?: (value: string) => void
}

const SuccessCriteriaInput = React.memo(function SuccessCriteriaInput({
  value,
  disabled,
  onChange
}: SuccessCriteriaInputProps): React.JSX.Element {
  return (
    <div className="px-4 pb-1">
      <textarea
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder="Success criteria..."
        disabled={disabled}
        className={cn(
          'w-full resize-none rounded-md border border-border/60 bg-background/45 px-2.5 py-1.5',
          'text-xs placeholder:text-muted-foreground',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'min-h-[32px] max-h-[88px]'
        )}
        rows={1}
        data-testid="composer-success-criteria"
      />
    </div>
  )
})

interface ComposerToolbarProps {
  disabled: boolean
  pendingPlan?: unknown | null
  onToggleMode?: () => void
  mode: 'build' | 'plan'
  showGoalControls: boolean
  goalMode: boolean
  onToggleGoalMode?: () => void
  availableAlternatives: ComposerAction[]
  alternativesEnabled: boolean
  canSend: boolean
  onActionSelection: (action: ComposerAction) => void
  onSubmit: () => void
  buttonEnabled: boolean
  iconHint: ComposerActionSet['iconHint']
  primaryLabel: string
  onAttach: (file: Omit<Attachment, 'id'>) => void
}

const ComposerToolbar = React.memo(function ComposerToolbar({
  disabled,
  pendingPlan,
  onToggleMode,
  mode,
  showGoalControls,
  goalMode,
  onToggleGoalMode,
  availableAlternatives,
  alternativesEnabled,
  canSend,
  onActionSelection,
  onSubmit,
  buttonEnabled,
  iconHint,
  primaryLabel,
  onAttach
}: ComposerToolbarProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-3 pb-3 pt-1">
      <AttachmentButton onAttach={onAttach} disabled={disabled} />

      {/* Plan mode toggle */}
      {pendingPlan ? (
        <span className="text-xs text-muted-foreground">Review the plan above</span>
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

      {showGoalControls ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'h-7 rounded-full border px-2.5 text-xs font-medium transition-[color,background-color,border-color,box-shadow]',
            goalMode
              ? 'border-emerald-300/80 bg-emerald-500/10 text-emerald-700 shadow-[0_0_0_1px_rgba(110,231,183,0.22),0_0_12px_rgba(16,185,129,0.16)] hover:bg-emerald-500/14 hover:text-emerald-800 dark:border-emerald-400/45 dark:bg-emerald-500/12 dark:text-emerald-200 dark:shadow-[0_0_0_1px_rgba(52,211,153,0.2),0_0_14px_rgba(5,150,105,0.16)]'
              : 'border-border/70 bg-background/65 text-muted-foreground shadow-none hover:border-border hover:bg-background/85 hover:text-foreground'
          )}
          onClick={onToggleGoalMode}
          aria-pressed={goalMode}
          title="Toggle Goal Mode"
          data-testid="composer-goal-toggle"
        >
          Goal
        </Button>
      ) : null}

      <div className="flex-1" />

      {availableAlternatives.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 rounded-full border border-border/70 px-2.5"
              disabled={!alternativesEnabled}
              aria-label="More send actions"
              data-testid="composer-action-menu-trigger"
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            side="top"
            className="w-52"
            data-testid="composer-action-menu"
          >
            {availableAlternatives.map((action) => (
              <DropdownMenuItem
                key={action}
                onSelect={() => {
                  onActionSelection(action)
                }}
                disabled={!canSend && action !== 'stop_and_send'}
                data-testid={`composer-action-${action}`}
              >
                <ActionMenuIcon action={action} />
                <span>{getActionLabel(action)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Send / Stop icon button */}
      <button
        onClick={onSubmit}
        disabled={!buttonEnabled}
        className={cn(
          'h-8 w-8 rounded-full flex items-center justify-center shrink-0 transition-colors',
          iconHint === 'stop'
            ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
            : buttonEnabled
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'bg-muted text-muted-foreground cursor-not-allowed'
        )}
        aria-label={primaryLabel}
        title={primaryLabel}
        data-testid="composer-primary-action"
      >
        <SendIcon hint={iconHint} />
      </button>
    </div>
  )
})

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
  supportsSteer = false,
  maxAttachments = 10,
  mode = 'build',
  onToggleMode,
  pendingPlan,
  supportsGoalMode = false,
  goalMode = false,
  onToggleGoalMode,
  successCriteria = '',
  onSuccessCriteriaChange,
  worktreePath,
  commandsVersion = 0,
  containerRef
}: ComposerBarProps): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [content, setContent] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const contentRef = useRef('')
  const attachmentsRef = useRef<Attachment[]>([])

  // --- Draft persistence: save input on unmount/switch, restore on mount ---
  useEffect(() => {
    contentRef.current = content
  }, [content])
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  // Load draft on session change
  useEffect(() => {
    let cancelled = false
    window.db.session
      .getDraft(sessionId)
      .then((draft) => {
        if (!cancelled && draft) {
          contentRef.current = draft
          setContent(draft)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
      // Save draft when leaving this session
      const current = contentRef.current.trim()
      window.db.session.updateDraft(sessionId, current || null).catch(() => {})
    }
  }, [sessionId])
  // --- Slash commands ---
  const [slashCommands, setSlashCommands] = useState<
    { name: string; description?: string; template: string; agent?: string; builtIn?: boolean }[]
  >([])
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
    window.agentOps
      .commands(worktreePath)
      .then((result) => {
        if (mounted && result?.success && Array.isArray(result.commands)) {
          setSlashCommands(result.commands)
        }
      })
      .catch(() => {})
    return () => {
      mounted = false
    }
  }, [worktreePath, commandsVersion])
  const canSend = content.trim().length > 0 || attachments.length > 0
  // Derive available actions from the state machine
  const hasInterrupt = firstInterrupt != null
  const actionSet = useMemo(
    () =>
      determineComposerActions({
        lifecycle,
        hasInterrupt,
        hasPendingMessages: pendingCount > 0,
        hasDraftContent: canSend,
        isConnected,
        supportsSteer
      }),
    [canSend, hasInterrupt, isConnected, lifecycle, pendingCount, supportsSteer]
  )

  const isDisabled = !actionSet.inputEnabled
  const availableAlternatives = useMemo(
    () =>
      actionSet.alternatives.filter((action) => {
        if (action !== 'steer') return true
        return supportsSteer && attachments.length === 0
      }),
    [actionSet.alternatives, attachments.length, supportsSteer]
  )

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
    contentRef.current = ''
    attachmentsRef.current = []
    setContent('')
    setAttachments([])
    window.db.session.updateDraft(sessionId, null).catch(() => {})
    const ta = textareaRef.current
    if (ta) ta.style.height = 'auto'
  }, [sessionId])

  const handleActionSelection = useCallback(
    async (action: ComposerAction): Promise<void> => {
      const currentContent = contentRef.current
      const currentAttachments = attachmentsRef.current
      const hasContent = currentContent.trim().length > 0 || currentAttachments.length > 0

      if (action === 'stop_and_send' && !hasContent) {
        await onAction('stop_and_send', '', [])
        return
      }

      if (!hasContent && action !== 'reply_interrupt') return

      // Snapshot the payload and clear the input synchronously. The send IPC
      // round-trip can take hundreds of ms to a few seconds (SDK start, app
      // server boot, etc.), and waiting until it resolves leaves the user
      // staring at their own text below the optimistic bubble.
      const snapshotContent = currentContent.trim()
      const snapshotAttachments = currentAttachments
      clearInput()

      const consumed = await onAction(action, snapshotContent, snapshotAttachments)
      if (!consumed) {
        // Send failed — restore the text so the user can retry. Attachments
        // aren't restored (files have been consumed by the optimistic path).
        contentRef.current = snapshotContent
        setContent(snapshotContent)
      }
    },
    [clearInput, onAction]
  )

  const handleSubmit = useCallback(async () => {
    if (!actionSet.primary) return

    if (actionSet.primary === 'stop_and_send' && !canSend) {
      await handleActionSelection('stop_and_send')
      return
    }

    if (!canSend && actionSet.primary !== 'reply_interrupt') return

    await handleActionSelection(actionSet.primary)
  }, [actionSet.primary, canSend, handleActionSelection])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (isComposingKeyboardEvent(e.nativeEvent)) return
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void handleSubmit()
      }
    },
    [handleSubmit]
  )

  const handleAttach = useCallback(
    (file: Omit<Attachment, 'id'>) => {
      setAttachments((prev) => {
        if (prev.length >= maxAttachments) return prev
        const next = [
          ...prev,
          { ...file, id: `att-${Date.now()}-${Math.random().toString(36).slice(2)}` }
        ]
        attachmentsRef.current = next
        return next
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
    setAttachments((prev) => {
      const next = prev.filter((a) => a.id !== id)
      attachmentsRef.current = next
      return next
    })
  }, [])

  const handleContentChange = useCallback((value: string) => {
    contentRef.current = value
    setContent(value)
    const shouldShowSlash = value.startsWith('/') && !value.includes(' ')
    if (shouldShowSlash !== showSlashCommandsRef.current) {
      setShowSlashCommands(shouldShowSlash)
      showSlashCommandsRef.current = shouldShowSlash
    }
  }, [])

  const handleCommandSelect = useCallback((cmd: { name: string; template: string }) => {
    const nextContent = `/${cmd.name} `
    contentRef.current = nextContent
    setContent(nextContent)
    setShowSlashCommands(false)
    showSlashCommandsRef.current = false
    textareaRef.current?.focus()
  }, [])

  const handleCloseSlashCommands = useCallback(() => {
    setShowSlashCommands(false)
    showSlashCommandsRef.current = false
  }, [])

  const placeholder = pendingPlan
    ? 'Provide feedback on the plan...'
    : firstInterrupt
      ? 'Type your reply...'
      : actionSet.primary === 'queue'
        ? 'Type a follow-up to queue after the current run...'
        : actionSet.iconHint === 'stop'
          ? 'Type to stop and send...'
          : 'Type a message...'

  // Determine if button should be enabled
  const buttonEnabled =
    actionSet.primary != null &&
    (actionSet.iconHint === 'stop' || canSend || actionSet.primary === 'reply_interrupt')
  const alternativesEnabled =
    availableAlternatives.length > 0 && (canSend || availableAlternatives.includes('stop_and_send'))
  const showGoalControls = Boolean(supportsGoalMode && !pendingPlan && onToggleGoalMode)
  const showSuccessCriteria = showGoalControls && goalMode
  const handleToolbarActionSelection = useCallback(
    (action: ComposerAction) => {
      void handleActionSelection(action)
    },
    [handleActionSelection]
  )
  const handleToolbarSubmit = useCallback(() => {
    void handleSubmit()
  }, [handleSubmit])

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
      {showSlashCommands && (
        <SlashCommandPopover
          commands={allSlashCommands}
          filter={content}
          onSelect={handleCommandSelect}
          onClose={handleCloseSlashCommands}
          visible={showSlashCommands}
        />
      )}

      {/* Pending message indicator */}
      {pendingCount > 0 && (
        <div className="px-4 pt-3 pb-0 text-xs text-muted-foreground flex items-center gap-1.5">
          {pendingCount} message{pendingCount > 1 ? 's' : ''} queued
        </div>
      )}

      {/* Attachments preview */}
      {attachments.length > 0 && (
        <ComposerAttachmentsSection attachments={attachments} onRemove={handleRemoveAttachment} />
      )}

      {/* Textarea — seamlessly fills the card top */}
      <div className="px-4 pt-3 pb-1">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => handleContentChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
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

      {showSuccessCriteria && (
        <SuccessCriteriaInput
          value={successCriteria}
          disabled={isDisabled}
          onChange={onSuccessCriteriaChange}
        />
      )}

      {/* Bottom row: attach + plan + spacer + send */}
      <ComposerToolbar
        disabled={isDisabled}
        pendingPlan={pendingPlan}
        onToggleMode={onToggleMode}
        mode={mode}
        showGoalControls={showGoalControls}
        goalMode={goalMode}
        onToggleGoalMode={onToggleGoalMode}
        availableAlternatives={availableAlternatives}
        alternativesEnabled={alternativesEnabled}
        canSend={canSend}
        onActionSelection={handleToolbarActionSelection}
        onSubmit={handleToolbarSubmit}
        buttonEnabled={buttonEnabled}
        iconHint={actionSet.iconHint}
        primaryLabel={actionSet.primaryLabel}
        onAttach={handleAttach}
      />
    </div>
  )
}
