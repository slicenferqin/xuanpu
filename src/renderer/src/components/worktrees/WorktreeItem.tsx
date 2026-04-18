import { useCallback, useState, useRef, useEffect } from 'react'
import { fileManagerName } from '@/lib/platform'
import {
  GitBranch,
  Folder,
  Link,
  MoreHorizontal,
  Terminal,
  Code,
  Archive,
  GitBranchPlus,
  Copy,
  ExternalLink,
  Pencil,
  Figma,
  Ticket,
  Plus,
  Pin,
  PinOff,
  Unlink,
  FileText
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
} from '@/components/ui/dropdown-menu'
import {
  useWorktreeStore,
  useProjectStore,
  useConnectionStore,
  usePinnedStore,
  useHintStore,
  useVimModeStore,
  useSettingsStore
} from '@/stores'
import { HintBadge } from '@/components/ui/HintBadge'
import { useGitStore } from '@/stores/useGitStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { toast } from '@/lib/toast'
import { formatRelativeTime } from '@/lib/format-utils'
import { ArchiveConfirmDialog } from './ArchiveConfirmDialog'
import { AddAttachmentDialog } from './AddAttachmentDialog'
import { useFileViewerStore } from '@/stores/useFileViewerStore'
import { useI18n } from '@/i18n/useI18n'

interface Worktree {
  id: string
  project_id: string
  name: string
  branch_name: string
  path: string
  status: 'active' | 'archived'
  is_default: boolean
  last_message_at: number | null
  created_at: string
  last_accessed_at: string
  attachments: string // JSON array
}

interface WorktreeItemProps {
  worktree: Worktree
  projectPath: string
  index?: number
  isDragging?: boolean
  isDragOver?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onDragEnd?: () => void
}

const PRIMARY_LABEL_MAX_LENGTH = 28
const SECONDARY_LABEL_MAX_LENGTH = 18

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 1) return value.slice(0, maxLength)

  const ellipsis = '…'
  const lastSeparatorIndex = Math.max(
    value.lastIndexOf('/'),
    value.lastIndexOf('-'),
    value.lastIndexOf('_')
  )

  if (lastSeparatorIndex > 0 && lastSeparatorIndex < value.length - 1) {
    const suffixToken = value.slice(lastSeparatorIndex + 1)
    const prefixLength = maxLength - ellipsis.length - suffixToken.length

    if (prefixLength >= 4) {
      return `${value.slice(0, prefixLength)}${ellipsis}${suffixToken}`
    }
  }

  const visibleChars = maxLength - ellipsis.length
  let prefixLength = Math.ceil(visibleChars / 2)
  let suffixLength = Math.floor(visibleChars / 2)
  let prefix = value.slice(0, prefixLength)
  let suffix = value.slice(-suffixLength)

  while (/[/_-]$/.test(prefix) && prefixLength > 1) {
    prefixLength -= 1
    prefix = value.slice(0, prefixLength)
  }

  while (/^[/_-]/.test(suffix) && suffixLength > 1) {
    suffixLength -= 1
    suffix = value.slice(-suffixLength)
  }

  return `${prefix}${ellipsis}${suffix}`
}

export function WorktreeItem({
  worktree,
  projectPath,
  isDragging,
  isDragOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd
}: WorktreeItemProps): React.JSX.Element {
  const { selectedWorktreeId, selectWorktree, archiveWorktree, unbranchWorktree } =
    useWorktreeStore()
  const selectProject = useProjectStore((s) => s.selectProject)

  const archivingWorktreeIds = useWorktreeStore((s) => s.archivingWorktreeIds)
  const isArchiving = archivingWorktreeIds.has(worktree.id)
  const worktreeStatus = useWorktreeStatusStore((state) => state.getWorktreeStatus(worktree.id))
  const lastMessageTime = useWorktreeStatusStore(
    (state) => state.lastMessageTimeByWorktree[worktree.id] ?? null
  )
  // Show last activity time: prefer last message time, fallback to last_accessed_at
  const displayTime = lastMessageTime
    ?? (worktree.last_accessed_at ? new Date(worktree.last_accessed_at).getTime() : null)
  const liveBranch = useGitStore((s) => s.branchInfoByWorktree.get(worktree.path))
  const activeBranchName = liveBranch?.name ?? worktree.branch_name
  const displayName = liveBranch?.name ?? worktree.name
  const displayNamePreview = truncateMiddle(displayName, PRIMARY_LABEL_MAX_LENGTH)
  const isSelected = selectedWorktreeId === worktree.id

  // Connection mode state
  const connectionModeActive = useConnectionStore((s) => s.connectionModeActive)
  const connectionModeSourceId = useConnectionStore((s) => s.connectionModeSourceWorktreeId)
  const connectionModeSelectedIds = useConnectionStore((s) => s.connectionModeSelectedIds)
  const toggleConnectionModeWorktree = useConnectionStore((s) => s.toggleConnectionModeWorktree)
  const enterConnectionMode = useConnectionStore((s) => s.enterConnectionMode)

  // Pinned state
  const isPinned = usePinnedStore((s) => s.pinnedWorktreeIds.has(worktree.id))
  const pinWorktree = usePinnedStore((s) => s.pinWorktree)
  const unpinWorktree = usePinnedStore((s) => s.unpinWorktree)

  const hint = useHintStore((s) => s.hintMap.get(worktree.id))
  const hintMode = useHintStore((s) => s.mode)
  const hintPendingChar = useHintStore((s) => s.pendingChar)
  const hintActionMode = useHintStore((s) => s.actionMode)
  const inputFocused = useHintStore((s) => s.inputFocused)
  const vimMode = useVimModeStore((s) => s.mode)
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)
  const { t } = useI18n()

  const handleTogglePin = useCallback(async (): Promise<void> => {
    if (isPinned) {
      await unpinWorktree(worktree.id)
    } else {
      await pinWorktree(worktree.id)
    }
  }, [isPinned, worktree.id, pinWorktree, unpinWorktree])

  const handleEditContext = useCallback(() => {
    useFileViewerStore.getState().openContextEditor(worktree.id)
  }, [worktree.id])

  const isInConnectionMode = connectionModeActive
  const isSource = connectionModeSourceId === worktree.id
  const isChecked = connectionModeSelectedIds.has(worktree.id)
  const hasNamedBranch = Boolean(worktree.branch_name)

  const worktreeLabel =
    worktree.is_default || !activeBranchName || displayName === activeBranchName
      ? displayName
      : `${displayName} - ${activeBranchName}`

  const secondaryBranchLabel =
    activeBranchName && displayName !== activeBranchName
      ? truncateMiddle(activeBranchName, SECONDARY_LABEL_MAX_LENGTH)
      : null

  const worktreeMetaLabel = worktree.is_default
    ? t('pinned.meta.default')
    : secondaryBranchLabel
      ? `${t('pinned.meta.branch')} · ${secondaryBranchLabel}`
      : activeBranchName
        ? t('pinned.meta.branch')
        : t('pinned.menu.detachedHead')

  const renderWorktreeName = (): React.JSX.Element => (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="block cursor-default truncate text-[13px] font-medium leading-5"
          data-testid="worktree-primary-name"
        >
          {displayNamePreview}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8} className="max-w-[32rem] px-3.5 py-2.5 text-sm">
        <div className="space-y-1.5">
          <div className="font-medium leading-none">{worktreeLabel}</div>
          <div className="font-mono text-xs leading-relaxed text-background/80 break-all">
            {worktree.path}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )

  // Auto-refresh relative time every 60 seconds
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!displayTime) return
    const timer = setInterval(() => setTick((n) => n + 1), 60000)
    return () => clearInterval(timer)
  }, [displayTime])

  // Archive confirmation state
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
  const [archiveConfirmFiles, setArchiveConfirmFiles] = useState<
    Array<{ path: string; additions: number; deletions: number; binary: boolean }>
  >([])

  // Attachment state
  const [addAttachmentOpen, setAddAttachmentOpen] = useState(false)
  const [attachments, setAttachments] = useState<
    Array<{ id: string; type: 'jira' | 'figma'; url: string; label: string; created_at: string }>
  >([])

  // Parse attachments from worktree data
  useEffect(() => {
    try {
      setAttachments(JSON.parse(worktree.attachments || '[]'))
    } catch {
      setAttachments([])
    }
  }, [worktree.attachments])

  const handleOpenAttachment = useCallback(async (url: string): Promise<void> => {
    await window.systemOps.openInChrome(url)
  }, [])

  const handleDetachAttachment = useCallback(
    async (attachmentId: string): Promise<void> => {
      const result = await window.db.worktree.removeAttachment(worktree.id, attachmentId)
      if (result.success) {
        setAttachments((prev) => prev.filter((a) => a.id !== attachmentId))
        toast.success(t('pinned.toasts.attachmentRemoved'))
      } else {
        toast.error(
          result.error
            ? `${t('pinned.toasts.attachmentRemoveError')}: ${result.error}`
            : t('pinned.toasts.attachmentRemoveError')
        )
      }
    },
    [worktree.id, t]
  )

  const handleAttachmentAdded = useCallback((): void => {
    // Reload worktree data to get fresh attachments
    window.db.worktree.get(worktree.id).then((w) => {
      if (w) {
        try {
          setAttachments(JSON.parse(w.attachments || '[]'))
        } catch {
          // ignore
        }
      }
    })
  }, [worktree.id])

  // Branch rename state
  const [isRenamingBranch, setIsRenamingBranch] = useState(false)
  const [branchNameInput, setBranchNameInput] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intentionalCloseRef = useRef(false)
  const renameStartTimeRef = useRef<number>(0)

  // Auto-focus the rename input when it appears (deferred to run after menu closes)
  useEffect(() => {
    if (isRenamingBranch) {
      // Focus function
      const focusInput = () => {
        if (renameInputRef.current && document.activeElement !== renameInputRef.current) {
          renameInputRef.current.focus()
          renameInputRef.current.select()
        }
      }

      // Use requestAnimationFrame to focus after menu closes
      requestAnimationFrame(focusInput)
    }
  }, [isRenamingBranch])

  // Cleanup blur timer on unmount
  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
    }
  }, [])

  const startBranchRename = useCallback((): void => {
    if (!hasNamedBranch) return

    intentionalCloseRef.current = false
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current) // Clear any pending blur timer
    renameStartTimeRef.current = Date.now() // Record time before setting state
    setBranchNameInput(worktree.branch_name)
    setIsRenamingBranch(true)
  }, [hasNamedBranch, worktree.branch_name])

  const handleBranchRename = useCallback(async (): Promise<void> => {
    intentionalCloseRef.current = true
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
    const trimmed = branchNameInput.trim()
    if (!trimmed || trimmed === worktree.branch_name) {
      setIsRenamingBranch(false)
      return
    }

    // Canonicalize for safety
    const newBranch = trimmed
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9\-/.]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/, '')

    if (!newBranch) {
      toast.error(t('pinned.toasts.invalidBranchName'))
      setIsRenamingBranch(false)
      return
    }

    const result = await window.worktreeOps.renameBranch(
      worktree.id,
      worktree.path,
      worktree.branch_name,
      newBranch
    )

    if (result.success) {
      useWorktreeStore.getState().updateWorktreeBranch(worktree.id, newBranch)
      toast.success(t('pinned.toasts.branchRenamed', { branch: newBranch }))
    } else {
      toast.error(result.error || t('pinned.toasts.branchRenameError'))
    }
    setIsRenamingBranch(false)
  }, [branchNameInput, worktree.id, worktree.path, worktree.branch_name, t])

  const handleClick = (): void => {
    if (isInConnectionMode) {
      toggleConnectionModeWorktree(worktree.id)
      return
    }
    selectWorktree(worktree.id)
    selectProject(worktree.project_id)
    useWorktreeStatusStore.getState().clearWorktreeUnread(worktree.id)
  }

  const handleOpenInTerminal = useCallback(async (): Promise<void> => {
    const result = await window.worktreeOps.openInTerminal(worktree.path)
    if (result.success) {
      toast.success(t('pinned.toasts.openedInTerminal'))
    } else {
      toast.error(result.error || t('pinned.toasts.openInTerminalError'), {
        retry: handleOpenInTerminal,
        description: t('pinned.toasts.openInTerminalDescription')
      })
    }
  }, [worktree.path, t])

  const handleOpenInEditor = useCallback(async (): Promise<void> => {
    const result = await window.worktreeOps.openInEditor(worktree.path)
    if (result.success) {
      toast.success(t('pinned.toasts.openedInEditor'))
    } else {
      toast.error(result.error || t('pinned.toasts.openInEditorError'), {
        retry: handleOpenInEditor,
        description: t('pinned.toasts.openInEditorDescription')
      })
    }
  }, [worktree.path, t])

  const handleOpenInFinder = async (): Promise<void> => {
    await window.projectOps.showInFolder(worktree.path)
  }

  const handleCopyPath = async (): Promise<void> => {
    await window.projectOps.copyToClipboard(worktree.path)
    toast.success(t('pinned.toasts.pathCopied'))
  }

  const doArchive = useCallback(async (): Promise<void> => {
    const result = await archiveWorktree(
      worktree.id,
      worktree.path,
      worktree.branch_name,
      projectPath
    )
    if (result.success) {
      toast.success(t('pinned.toasts.archiveSuccess', { name: worktree.name }))
    } else {
      toast.error(
        t('pinned.toasts.archiveError', {
          error: result.error || t('pinned.toasts.unknownError')
        }),
        {
          retry: doArchive
        }
      )
    }
  }, [archiveWorktree, worktree, projectPath, t])

  const handleArchive = useCallback(async (): Promise<void> => {
    try {
      const result = await window.gitOps.getDiffStat(worktree.path)
      if (result.success && result.files && result.files.length > 0) {
        setArchiveConfirmFiles(result.files)
        setArchiveConfirmOpen(true)
        return
      }
    } catch {
      // If we can't check, proceed without confirmation
    }
    doArchive()
  }, [worktree.path, doArchive])

  const handleArchiveConfirm = useCallback((): void => {
    setArchiveConfirmOpen(false)
    setArchiveConfirmFiles([])
    doArchive()
  }, [doArchive])

  const handleArchiveCancel = useCallback((): void => {
    setArchiveConfirmOpen(false)
    setArchiveConfirmFiles([])
  }, [])

  const handleUnbranch = useCallback(async (): Promise<void> => {
    const result = await unbranchWorktree(
      worktree.id,
      worktree.path,
      worktree.branch_name,
      projectPath
    )
    if (result.success) {
      if (hasNamedBranch) {
        toast.success(t('pinned.toasts.unbranchSuccess', { name: worktree.name }))
      } else {
        toast.success(t('pinned.toasts.removeWorktreeSuccess', { name: worktree.name }))
      }
    } else {
      toast.error(
        t('pinned.toasts.unbranchError', {
          error: result.error || t('pinned.toasts.unknownError')
        }),
        {
          retry: handleUnbranch
        }
      )
    }
  }, [hasNamedBranch, unbranchWorktree, worktree, projectPath, t])

  const handleDuplicate = useCallback(async (): Promise<void> => {
    if (!hasNamedBranch) {
      toast.error(t('pinned.toasts.detachedCannotDuplicate'))
      return
    }

    const project = useProjectStore.getState().projects.find((p) => p.id === worktree.project_id)
    if (!project) return
    const result = await useWorktreeStore
      .getState()
      .duplicateWorktree(
        project.id,
        project.path,
        project.name,
        worktree.branch_name,
        worktree.path
      )
    if (result.success) {
      toast.success(
        t('pinned.toasts.duplicatedTo', {
          name: result.worktree?.name || t('pinned.toasts.newBranch')
        })
      )
    } else {
      toast.error(result.error || t('pinned.toasts.duplicateError'))
    }
  }, [hasNamedBranch, worktree, t])

  // --- Connection mode rendering (simplified, no menus) ---
  if (isInConnectionMode) {
    return (
      <>
        <div
          className={cn(
            'group flex items-start gap-2 pl-8 pr-1.5 py-2 rounded-lg cursor-pointer transition-colors',
            isChecked ? 'bg-accent/30' : 'hover:bg-accent/50',
            isSource && isChecked && 'bg-accent/20',
            isArchiving && 'opacity-50 pointer-events-none'
          )}
          onClick={handleClick}
          data-testid={`worktree-item-${worktree.id}`}
        >
          {/* Checkbox instead of status icons */}
          <Checkbox
            checked={isChecked}
            onCheckedChange={() => toggleConnectionModeWorktree(worktree.id)}
            disabled={isSource}
            className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', isSource && 'opacity-70')}
            onClick={(e) => e.stopPropagation()}
            data-testid={`connection-mode-checkbox-${worktree.id}`}
          />

          {/* Worktree Name + Meta Line */}
          <div className="flex-1 min-w-0">
            {renderWorktreeName()}
            <div className="mt-0.5 flex items-center gap-2 pr-1">
              <span
                className="min-w-0 truncate text-[11px] text-muted-foreground/75"
                data-testid="worktree-meta-type"
              >
                {worktreeMetaLabel}
              </span>
              <span className="flex-1" />
              {displayTime && (
                <span
                  className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0"
                  title={new Date(displayTime).toLocaleString()}
                  data-testid="worktree-last-message-time"
                >
                  {formatRelativeTime(displayTime)}
                </span>
              )}
            </div>
          </div>
        </div>

        <ArchiveConfirmDialog
          open={archiveConfirmOpen}
          worktreeName={worktree.name}
          files={archiveConfirmFiles}
          onCancel={handleArchiveCancel}
          onConfirm={handleArchiveConfirm}
        />
      </>
    )
  }

  // --- Normal rendering (with menus, drag, etc.) ---
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group flex items-start gap-2.5 pl-6 pr-2 py-2 rounded-lg cursor-pointer transition-colors',
            isSelected
              ? 'bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-sidebar-border/60 shadow-sm'
              : 'hover:bg-sidebar-accent/70',
            isArchiving && 'opacity-50 pointer-events-none',
            isDragging && 'opacity-50',
            isDragOver && 'border-t-2 border-primary'
          )}
          draggable={!worktree.is_default && !isRenamingBranch}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onDragEnd={onDragEnd}
          onClick={handleClick}
          data-selected={isSelected ? 'true' : 'false'}
          data-testid={`worktree-item-${worktree.id}`}
        >
          {worktree.is_default ? (
            <Folder className="mt-0.5 h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <GitBranch className="mt-0.5 h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}

          {/* Worktree Name / Inline Rename Input + Meta Line */}
          <div className="flex-1 min-w-0">
            {isRenamingBranch ? (
              <input
                ref={renameInputRef}
                autoFocus
                value={branchNameInput}
                onChange={(e) => setBranchNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleBranchRename()
                  }
                  if (e.key === 'Escape') {
                    intentionalCloseRef.current = true
                    if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
                    setIsRenamingBranch(false)
                  }
                }}
                onBlur={() => {
                  // Skip scheduling timer if we're intentionally closing via Escape/Enter
                  if (intentionalCloseRef.current) {
                    intentionalCloseRef.current = false
                    return
                  }

                  // Ignore blur events that happen too soon after starting rename (menu closing)
                  const timeSinceStart = Date.now() - renameStartTimeRef.current
                  if (timeSinceStart < 500) {
                    // Always refocus during the first 500ms (menu closing period)
                    // User can press Escape to cancel if needed
                    setTimeout(() => {
                      if (
                        renameInputRef.current &&
                        document.activeElement !== renameInputRef.current
                      ) {
                        renameInputRef.current.focus()
                        renameInputRef.current.select()
                      }
                    }, 0)
                    return
                  }

                  // Delay blur to allow for normal focus changes
                  if (blurTimerRef.current) clearTimeout(blurTimerRef.current)
                  blurTimerRef.current = setTimeout(() => {
                    blurTimerRef.current = null
                    // Only close if the input is still not focused
                    if (document.activeElement !== renameInputRef.current) {
                      setIsRenamingBranch(false)
                    }
                  }, 100)
                }}
                onClick={(e) => e.stopPropagation()}
                className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full focus:outline-none focus:ring-1 focus:ring-ring"
                data-testid="branch-rename-input"
              />
            ) : (
              renderWorktreeName()
            )}
            <div className="mt-0.5 flex items-center gap-2 pr-1">
              <span
                className="min-w-0 truncate text-[11px] text-muted-foreground/75"
                data-testid="worktree-meta-type"
              >
                {worktreeMetaLabel}
              </span>
              <span className="flex-1" />
              {displayTime && (
                <span
                  className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0"
                  title={new Date(displayTime).toLocaleString()}
                  data-testid="worktree-last-message-time"
                >
                  {formatRelativeTime(displayTime)}
                </span>
              )}
            </div>
          </div>

          {/* Hint Badge (visible when filter is active and search field is focused) */}
          {hint && (inputFocused || (vimModeEnabled && vimMode === 'normal')) && (
            <HintBadge
              code={hint}
              mode={hintMode}
              pendingChar={hintPendingChar}
              actionMode={hintActionMode}
            />
          )}

          {/* Unread dot badge */}
          {worktreeStatus === 'unread' && (
            <span className="mt-1.5 h-2 w-2 rounded-full bg-primary shrink-0" />
          )}

          {/* More Options Dropdown (visible on hover and selection) */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'mt-0.5 h-6 w-6 rounded-md p-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground',
                  isSelected && 'opacity-100',
                  'hover:bg-sidebar-accent hover:text-foreground'
                )}
                onClick={(e) => e.stopPropagation()}
                data-testid={`worktree-actions-${worktree.id}`}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-52" align="end">
              {attachments.length > 0 && (
                <>
                  {attachments.map((attachment) => (
                    <DropdownMenuSub key={attachment.id}>
                      <DropdownMenuSubTrigger>
                        {attachment.type === 'jira' ? (
                          <Ticket className="h-4 w-4 mr-2 text-blue-500" />
                        ) : (
                          <Figma className="h-4 w-4 mr-2 text-purple-500" />
                        )}
                        {attachment.label}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-40">
                        <DropdownMenuItem onClick={() => handleOpenAttachment(attachment.url)}>
                          <ExternalLink className="h-4 w-4 mr-2" />
                          {t('pinned.menu.open')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleDetachAttachment(attachment.id)}
                          className="text-destructive focus:text-destructive focus:bg-destructive/10"
                        >
                          <Unlink className="h-4 w-4 mr-2" />
                          {t('pinned.menu.detach')}
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ))}
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onClick={() => setAddAttachmentOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                {t('pinned.menu.addAttachment')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleEditContext}>
                <FileText className="h-4 w-4 mr-2" />
                {t('pinned.menu.editContext')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleOpenInTerminal}>
                <Terminal className="h-4 w-4 mr-2" />
                {t('pinned.menu.openInTerminal')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleOpenInEditor}>
                <Code className="h-4 w-4 mr-2" />
                {t('pinned.menu.openInEditor')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleOpenInFinder}>
                <ExternalLink className="h-4 w-4 mr-2" />
                {t('pinned.menu.openInFileManager', { manager: fileManagerName() })}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleCopyPath}>
                <Copy className="h-4 w-4 mr-2" />
                {t('pinned.menu.copyPath')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleTogglePin}>
                {isPinned ? <PinOff className="h-4 w-4 mr-2" /> : <Pin className="h-4 w-4 mr-2" />}
                {isPinned ? t('pinned.menu.unpin') : t('pinned.menu.pin')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => enterConnectionMode(worktree.id)}>
                <Link className="h-4 w-4 mr-2" />
                {t('pinned.menu.connectTo')}
              </DropdownMenuItem>
              {!worktree.is_default && (
                <>
                  {hasNamedBranch ? (
                    <>
                      <DropdownMenuItem onClick={startBranchRename}>
                        <Pencil className="h-4 w-4 mr-2" />
                        {t('pinned.menu.renameBranch')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={handleDuplicate}>
                        <GitBranchPlus className="h-4 w-4 mr-2" />
                        {t('pinned.menu.duplicate')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={handleUnbranch}>
                        <GitBranchPlus className="h-4 w-4 mr-2" />
                        {t('pinned.menu.unbranch')}
                        <span className="ml-auto text-xs text-muted-foreground">
                          {t('pinned.menu.keepBranch')}
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={handleArchive}
                        className="text-destructive focus:text-destructive focus:bg-destructive/10"
                      >
                        <Archive className="h-4 w-4 mr-2" />
                        {t('pinned.menu.archive')}
                        <span className="ml-auto text-xs text-muted-foreground">
                          {t('pinned.menu.deleteBranch')}
                        </span>
                      </DropdownMenuItem>
                    </>
                  ) : (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={handleUnbranch}
                        className="text-destructive focus:text-destructive focus:bg-destructive/10"
                      >
                        <Archive className="h-4 w-4 mr-2" />
                        {t('pinned.menu.removeWorktree')}
                        <span className="ml-auto text-xs text-muted-foreground">
                          {t('pinned.menu.detachedHead')}
                        </span>
                      </DropdownMenuItem>
                    </>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>

      <ArchiveConfirmDialog
        open={archiveConfirmOpen}
        worktreeName={worktree.name}
        files={archiveConfirmFiles}
        onCancel={handleArchiveCancel}
        onConfirm={handleArchiveConfirm}
      />

      {/* Context Menu (right-click) */}
      <ContextMenuContent className="w-52">
        {attachments.length > 0 && (
          <>
            {attachments.map((attachment) => (
              <ContextMenuSub key={attachment.id}>
                <ContextMenuSubTrigger>
                  {attachment.type === 'jira' ? (
                    <Ticket className="h-4 w-4 mr-2 text-blue-500" />
                  ) : (
                    <Figma className="h-4 w-4 mr-2 text-purple-500" />
                  )}
                  {attachment.label}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-40">
                  <ContextMenuItem onClick={() => handleOpenAttachment(attachment.url)}>
                    <ExternalLink className="h-4 w-4 mr-2" />
                    {t('pinned.menu.open')}
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() => handleDetachAttachment(attachment.id)}
                    className="text-destructive focus:text-destructive focus:bg-destructive/10"
                  >
                    <Unlink className="h-4 w-4 mr-2" />
                    {t('pinned.menu.detach')}
                  </ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuSub>
            ))}
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onClick={() => setAddAttachmentOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          {t('pinned.menu.addAttachment')}
        </ContextMenuItem>
        <ContextMenuItem onClick={handleEditContext}>
          <FileText className="h-4 w-4 mr-2" />
          {t('pinned.menu.editContext')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleOpenInTerminal}>
          <Terminal className="h-4 w-4 mr-2" />
          {t('pinned.menu.openInTerminal')}
        </ContextMenuItem>
        <ContextMenuItem onClick={handleOpenInEditor}>
          <Code className="h-4 w-4 mr-2" />
          {t('pinned.menu.openInEditor')}
        </ContextMenuItem>
        <ContextMenuItem onClick={handleOpenInFinder}>
          <ExternalLink className="h-4 w-4 mr-2" />
          {t('pinned.menu.openInFileManager', { manager: fileManagerName() })}
        </ContextMenuItem>
        <ContextMenuItem onClick={handleCopyPath}>
          <Copy className="h-4 w-4 mr-2" />
          {t('pinned.menu.copyPath')}
        </ContextMenuItem>
        <ContextMenuItem onClick={handleTogglePin}>
          {isPinned ? <PinOff className="h-4 w-4 mr-2" /> : <Pin className="h-4 w-4 mr-2" />}
          {isPinned ? t('pinned.menu.unpin') : t('pinned.menu.pin')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => enterConnectionMode(worktree.id)}>
          <Link className="h-4 w-4 mr-2" />
          {t('pinned.menu.connectTo')}
        </ContextMenuItem>
        {!worktree.is_default && (
          <>
            {hasNamedBranch ? (
              <>
                <ContextMenuItem onClick={startBranchRename}>
                  <Pencil className="h-4 w-4 mr-2" />
                  {t('pinned.menu.renameBranch')}
                </ContextMenuItem>
                <ContextMenuItem onClick={handleDuplicate}>
                  <GitBranchPlus className="h-4 w-4 mr-2" />
                  {t('pinned.menu.duplicate')}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={handleUnbranch}>
                  <GitBranchPlus className="h-4 w-4 mr-2" />
                  {t('pinned.menu.unbranch')}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {t('pinned.menu.keepBranch')}
                  </span>
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={handleArchive}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Archive className="h-4 w-4 mr-2" />
                  {t('pinned.menu.archive')}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {t('pinned.menu.deleteBranch')}
                  </span>
                </ContextMenuItem>
              </>
            ) : (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onClick={handleUnbranch}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Archive className="h-4 w-4 mr-2" />
                  {t('pinned.menu.removeWorktree')}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {t('pinned.menu.detachedHead')}
                  </span>
                </ContextMenuItem>
              </>
            )}
          </>
        )}
      </ContextMenuContent>

      <AddAttachmentDialog
        open={addAttachmentOpen}
        onOpenChange={setAddAttachmentOpen}
        worktreeId={worktree.id}
        onAttachmentAdded={handleAttachmentAdded}
      />
    </ContextMenu>
  )
}
