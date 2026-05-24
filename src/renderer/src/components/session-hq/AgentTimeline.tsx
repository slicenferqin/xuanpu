/**
 * AgentTimeline — Vertical timeline view for agent actions.
 *
 * Replaces ThreadPane as the main message rendering container.
 * Left-side vertical line + colored icon nodes, each dispatching
 * to the appropriate Action Card based on StreamingPart type.
 *
 * Data flow:
 *   timelineMessages (durable) → extract parts → render cards
 *   streamingContent (live)    → inline streaming text at bottom
 */

import React, { useEffect, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { formatMessageTime } from '@/lib/format-time'
import type { TimelineMessage, StreamingPart, ToolUseInfo } from '@shared/lib/timeline-types'
import type { MessagePart } from '@shared/types/opencode'
import type { SessionLifecycle } from '@/stores/useSessionRuntimeStore'
import { CopyMessageButton } from '@/components/sessions/CopyMessageButton'
import { ForkMessageButton } from '@/components/sessions/ForkMessageButton'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/useI18n'
import { isTodoWriteTool } from '@/components/sessions/tools/todo-utils'
import {
  BashCard,
  FileReadCard,
  FileWriteCard,
  SearchCard,
  ThinkingCard,
  PlanCard,
  AskUserCard,
  SubAgentCard,
  TextCard,
  TodoCard
} from './cards'
import { ThreadStatusRow, type ThreadStatusRowData } from './ThreadStatusRow'
import { SystemNotificationBar } from '../sessions/SystemNotificationBar'
import { extractTaskNotifications, stripTaskNotifications } from '@/lib/content-sanitizer'
import { getMessageDisplayContent } from '@/lib/message-actions'
import type { SessionTask } from '@/lib/session-tasks'

import {
  Terminal,
  FileText,
  Pencil,
  Search,
  Brain,
  ClipboardList,
  CheckSquare,
  HelpCircle,
  Users,
  MessageSquare,
  User,
  Loader2
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Card type derivation
// ---------------------------------------------------------------------------

type CardType =
  | 'user-message'
  | 'system'
  | 'task-notification'
  | 'thinking'
  | 'bash'
  | 'file-read'
  | 'file-write'
  | 'search'
  | 'sub-agent'
  | 'plan'
  | 'ask-user'
  | 'todo'
  | 'tool-call'
  | 'text'

function isBashToolName(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower === 'bash' ||
    lower === 'execute_command' ||
    lower.includes('bash') ||
    lower.includes('shell') ||
    lower.includes('exec')
  )
}

function isXfpToolName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('mcp__xuanpu-field__') || lower.startsWith('xfp_')
}

function formatXfpToolLabel(name: string): string {
  const normalized = name
    .replace(/^mcp__xuanpu-field__/i, '')
    .replace(/^xfp_get_/i, '')
    .replace(/^xfp_/i, '')
    .replace(/_/g, ' ')
  return `XFP · ${normalized || 'field'}`
}

interface TimelineNode {
  key: string
  cardType: CardType
  part?: StreamingPart
  toolUse?: ToolUseInfo
  message: TimelineMessage
  textContent?: string
  /** File attachments for user messages (images, files) */
  attachments?: MessagePart[]
  /** True for the last node produced from a single TimelineMessage */
  isLastInMessage?: boolean
}

interface TimelineRound {
  id: string
  anchorId: string
  preview: string
  userNode: TimelineNode
  nodes: TimelineNode[]
}

function buildRoundPreview(node: TimelineNode): string {
  const displayText = getMessageDisplayContent(node.textContent ?? '')
  const compact = displayText.replace(/\s+/g, ' ').trim()
  return compact.length > 0 ? compact.slice(0, 24) : '未命名提问'
}

function groupNodesIntoRounds(nodes: TimelineNode[]): {
  preludeNodes: TimelineNode[]
  rounds: TimelineRound[]
} {
  const preludeNodes: TimelineNode[] = []
  const rounds: TimelineRound[] = []
  let currentRound: TimelineRound | null = null

  for (const node of nodes) {
    if (node.cardType === 'user-message') {
      const preview = buildRoundPreview(node)
      currentRound = {
        id: node.message.id,
        anchorId: `round-${node.message.id}`,
        preview,
        userNode: node,
        nodes: [node]
      }
      rounds.push(currentRound)
      continue
    }

    if (currentRound) {
      currentRound.nodes.push(node)
    } else {
      preludeNodes.push(node)
    }
  }

  return { preludeNodes, rounds }
}

/**
 * Explode a single TimelineMessage into 1+ timeline nodes.
 *
 * Each part that maps to a distinct card becomes its own node.
 * Text parts are collapsed into a single text node at the end.
 */
function messageToNodes(message: TimelineMessage): TimelineNode[] {
  // User messages → single node, except SDK-injected <task-notification> blocks
  // (background bash completion etc.) which should render as a thin status bar
  // rather than a chat bubble.
  if (message.role === 'user') {
    const raw = message.content ?? ''
    const notifications = extractTaskNotifications(raw)
    if (notifications.length > 0) {
      const remaining = stripTaskNotifications(raw)
      const nodes: TimelineNode[] = []
      if (remaining.length > 0) {
        nodes.push({
          key: `${message.id}-user`,
          cardType: 'user-message',
          message,
          textContent: remaining,
          attachments: message.attachments
        })
      }
      nodes.push({
        key: `${message.id}-task-notification`,
        cardType: 'task-notification',
        message,
        textContent: raw,
        isLastInMessage: true
      })
      return nodes
    }

    return [
      {
        key: `${message.id}-user`,
        cardType: 'user-message',
        message,
        textContent: message.content,
        attachments: message.attachments,
        isLastInMessage: true
      }
    ]
  }

  // System messages → skip
  if (message.role === 'system') return []

  // Assistant message — break into nodes per part
  const parts = message.parts ?? []

  // If this message contains a compaction part, render a compact status instead
  // of leaking the compressed summary text into the timeline
  const hasCompaction = parts.some((p) => p.type === 'compaction')
  if (hasCompaction) {
    return [
      {
        key: `${message.id}-compaction`,
        cardType: 'system' as CardType,
        message,
        textContent: '',
        isLastInMessage: true
      }
    ]
  }

  if (parts.length === 0 && message.content.trim()) {
    return [
      {
        key: `${message.id}-text`,
        cardType: 'text',
        message,
        textContent: message.content,
        isLastInMessage: true
      }
    ]
  }

  const nodes: TimelineNode[] = []
  let collectedText = ''

  const flushText = () => {
    if (collectedText.trim()) {
      nodes.push({
        key: `${message.id}-text-${nodes.length}`,
        cardType: 'text',
        message,
        textContent: collectedText.trim()
      })
      collectedText = ''
    }
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]

    if (part.type === 'text' && part.text) {
      collectedText += part.text
      continue
    }

    // Flush any accumulated text before a non-text part
    flushText()

    if (part.type === 'reasoning' && part.reasoning) {
      nodes.push({
        key: `${message.id}-thinking-${i}`,
        cardType: 'thinking',
        part,
        message,
        textContent: part.reasoning
      })
      continue
    }

    if (part.type === 'tool_use' && part.toolUse) {
      const toolName = part.toolUse.name?.toLowerCase() ?? ''
      let cardType: CardType = 'tool-call'

      if (isBashToolName(toolName)) {
        cardType = 'bash'
      } else if (toolName === 'read' || toolName === 'readfile' || toolName === 'read_file') {
        cardType = 'file-read'
      } else if (
        toolName === 'write' ||
        toolName === 'edit' ||
        toolName === 'writefile' ||
        toolName === 'write_file' ||
        toolName === 'editfile' ||
        toolName === 'edit_file'
      ) {
        cardType = 'file-write'
      } else if (
        toolName === 'grep' ||
        toolName === 'glob' ||
        toolName === 'search' ||
        toolName === 'codebase_search'
      ) {
        cardType = 'search'
      } else if (toolName === 'agent' || toolName === 'subagent' || toolName === 'dispatch_agent') {
        cardType = 'sub-agent'
      } else if (toolName === 'exitplanmode' || toolName === 'exit_plan_mode') {
        cardType = 'plan'
      } else if (toolName === 'askuserquestion' || toolName === 'ask_user') {
        cardType = 'ask-user'
      } else if (
        isTodoWriteTool(toolName) ||
        toolName === 'taskcreate' ||
        toolName === 'task_create' ||
        toolName === 'taskupdate' ||
        toolName === 'task_update' ||
        toolName === 'todoread' ||
        toolName === 'todo_read' ||
        toolName === 'tasklist' ||
        toolName === 'task_list'
      ) {
        cardType = 'todo'
      }

      nodes.push({
        key: `${message.id}-tool-${i}`,
        cardType,
        part,
        toolUse: part.toolUse,
        message
      })
      continue
    }

    if (part.type === 'subtask' && part.subtask) {
      nodes.push({
        key: `${message.id}-subtask-${i}`,
        cardType: 'sub-agent',
        part,
        message
      })
      continue
    }

    // step_start, step_finish, compaction → skip
  }

  flushText()

  // Mark the last node so we can render a timestamp after it
  if (nodes.length > 0) {
    nodes[nodes.length - 1].isLastInMessage = true
  }

  return nodes
}

// ---------------------------------------------------------------------------
// Timeline icon config
// ---------------------------------------------------------------------------

interface IconConfig {
  icon: React.ElementType
  colorClass: string
  bgClass: string
}

const ICON_MAP: Record<CardType, IconConfig> = {
  'user-message': {
    icon: User,
    colorClass: 'text-tech-blue',
    bgClass: 'bg-tech-blue-soft'
  },
  system: { icon: MessageSquare, colorClass: 'text-steel', bgClass: 'bg-agent-card-muted' },
  'task-notification': {
    icon: MessageSquare,
    colorClass: 'text-steel',
    bgClass: 'bg-agent-card-muted'
  },
  thinking: {
    icon: Brain,
    colorClass: 'text-neon-violet',
    bgClass: 'bg-neon-violet-soft'
  },
  bash: { icon: Terminal, colorClass: 'text-neon-mint', bgClass: 'bg-neon-mint-soft' },
  'file-read': { icon: FileText, colorClass: 'text-neon-mint', bgClass: 'bg-neon-mint-soft' },
  'file-write': {
    icon: Pencil,
    colorClass: 'text-tech-blue',
    bgClass: 'bg-tech-blue-soft'
  },
  search: { icon: Search, colorClass: 'text-neon-mint', bgClass: 'bg-neon-mint-soft' },
  'sub-agent': {
    icon: Users,
    colorClass: 'text-neon-violet',
    bgClass: 'bg-neon-violet-soft'
  },
  plan: {
    icon: ClipboardList,
    colorClass: 'text-neon-violet',
    bgClass: 'bg-neon-violet-soft'
  },
  'ask-user': {
    icon: HelpCircle,
    colorClass: 'text-neon-pink',
    bgClass: 'bg-neon-pink-soft'
  },
  todo: { icon: CheckSquare, colorClass: 'text-neon-mint', bgClass: 'bg-neon-mint-soft' },
  'tool-call': {
    icon: Terminal,
    colorClass: 'text-neon-violet',
    bgClass: 'bg-neon-violet-soft'
  },
  text: { icon: MessageSquare, colorClass: 'text-ink', bgClass: 'bg-agent-card-muted' }
}

// ---------------------------------------------------------------------------
// Generic tool label helper
// ---------------------------------------------------------------------------

/** Generate a display label for generic/unrecognized tool calls */
function getGenericToolLabel(name: string, input?: Record<string, unknown>): string {
  const lower = name.toLowerCase()
  if (isXfpToolName(name)) {
    return formatXfpToolLabel(name)
  }
  if (lower === 'skill' && input?.skill) {
    return `/${input.skill as string}`
  }
  if ((lower === 'webfetch' || lower === 'web_fetch') && input?.url) {
    try {
      return new URL(input.url as string).hostname
    } catch {
      return name
    }
  }
  if ((lower === 'websearch' || lower === 'web_search') && input?.query) {
    const q = String(input.query)
    return q.length > 60 ? q.slice(0, 57) + '...' : q
  }
  return name.charAt(0).toUpperCase() + name.slice(1)
}

// ---------------------------------------------------------------------------
// Node renderer
// ---------------------------------------------------------------------------

function TimelineNodeView({
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
}: {
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
}): React.JSX.Element | null {
  const { t } = useI18n()

  switch (node.cardType) {
    case 'user-message': {
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
          <div className="max-w-[82%]">
            <div
              className="rounded-2xl border border-primary/20 bg-primary/10 px-4 py-3 text-foreground shadow-sm transition-colors hover:border-primary/30 hover:bg-primary/14"
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
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onCancelUserMessageEdit?.()}
                    >
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
              className="mt-1.5 flex items-center justify-end gap-1.5 text-xs text-muted-foreground"
              data-testid={`timeline-user-actions-${node.message.id}`}
            >
              {timestampLabel && (
                <span data-testid={`timeline-user-timestamp-${node.message.id}`}>
                  {timestampLabel}
                </span>
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

    case 'system':
      return (
        <ThreadStatusRow
          status={{
            id: node.message.id,
            kind: 'compacted',
            timestamp: Date.parse(node.message.timestamp) || Date.now()
          }}
        />
      )

    case 'task-notification':
      return <SystemNotificationBar content={node.textContent ?? ''} />

    case 'thinking':
      return <ThinkingCard content={node.textContent ?? ''} />

    case 'bash':
      return node.toolUse ? <BashCard toolUse={node.toolUse} /> : null

    case 'file-read':
      return node.toolUse ? <FileReadCard toolUse={node.toolUse} /> : null

    case 'file-write':
      return node.toolUse ? <FileWriteCard toolUse={node.toolUse} /> : null

    case 'search':
      return node.toolUse ? <SearchCard toolUse={node.toolUse} /> : null

    case 'sub-agent': {
      const subtaskData = node.part?.subtask
        ? node.part.subtask
        : node.toolUse
          ? {
              id: node.toolUse.id,
              sessionID: '',
              prompt: (node.toolUse.input?.prompt as string) ?? '',
              description:
                (node.toolUse.input?.description as string) ??
                t('sessionHq.cards.subAgent.defaultDescription'),
              agent:
                (node.toolUse.input?.subagent_type as string) ??
                t('sessionHq.cards.subAgent.agentFallback'),
              parts: [],
              status: (node.toolUse.status === 'success'
                ? 'completed'
                : node.toolUse.status === 'error'
                  ? 'error'
                  : 'running') as 'running' | 'completed' | 'error'
            }
          : null
      if (!subtaskData) return null
      const childParts = childPartsMap?.get(subtaskData.id) ?? []
      return <SubAgentCard subtask={subtaskData} childParts={childParts} />
    }

    case 'plan': {
      const toolUseId = node.toolUse?.id
      const overrideContent = toolUseId ? planContentByToolUseId?.get(toolUseId) : undefined
      const inputPlan = node.toolUse?.input?.plan as string | undefined
      const output = node.toolUse?.output as string | undefined
      const content =
        (overrideContent && overrideContent.length > 0 ? overrideContent : undefined) ??
        (inputPlan && inputPlan.length > 0 ? inputPlan : undefined) ??
        output ??
        ''
      const planStatus = node.toolUse?.status
      const verdict: 'approved' | 'rejected' | undefined =
        planStatus === 'success'
          ? 'approved'
          : planStatus === 'rejected'
            ? 'rejected'
            : undefined
      return (
        <PlanCard
          content={content}
          isPending={planStatus === 'pending' || planStatus === 'running'}
          verdict={verdict}
        />
      )
    }

    case 'ask-user':
      return (
        <AskUserCard
          question={(node.toolUse?.input?.question as string) ?? ''}
          questions={
            Array.isArray(node.toolUse?.input?.questions)
              ? (node.toolUse!.input!.questions as Array<{
                  question: string
                  options?: Array<{ label: string; description?: string }>
                  header?: string
                  multiple?: boolean
                }>)
              : undefined
          }
          isPending={node.toolUse?.status === 'pending' || node.toolUse?.status === 'running'}
          sessionId={sessionId}
          worktreePath={worktreePath}
          answer={node.toolUse?.output}
        />
      )

    case 'todo':
      return node.toolUse ? <TodoCard toolUse={node.toolUse} /> : null

    case 'tool-call': {
      // Generic tool fallback — show as a small inline card
      if (!node.toolUse) return null
      const label = getGenericToolLabel(node.toolUse.name, node.toolUse.input)
      const isSuccess = node.toolUse.status === 'success'
      const isError = node.toolUse.status === 'error'
      const isRunning = node.toolUse.status === 'running' || node.toolUse.status === 'pending'
      const isXfp = isXfpToolName(node.toolUse.name)
      return (
        <div
          className={cn(
            'crisp-subtle-shadow rounded-xl border px-3.5 py-2',
            isXfp
              ? 'border-tech-blue/25 bg-tech-blue-soft/55'
              : 'border-neon-violet/25 bg-neon-violet-soft/55'
          )}
        >
          <div className="flex items-center gap-2 text-sm">
            <span
              className={cn(
                'crisp-status-dot h-2 w-2 rounded-full',
                isXfp ? 'bg-tech-blue text-tech-blue' : 'bg-neon-violet text-neon-violet'
              )}
            />
            <span className="font-medium text-ink">{label}</span>
            <span className="text-xs text-muted-foreground">
              {isRunning
                ? t('sessionHq.timeline.genericToolStatus.running')
                : isError
                  ? t('sessionHq.timeline.genericToolStatus.error')
                  : isSuccess
                    ? t('sessionHq.timeline.genericToolStatus.done')
                    : node.toolUse.status}
            </span>
          </div>
        </div>
      )
    }

    case 'text':
      return <TextCard content={node.textContent ?? ''} />

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// AgentTimeline
// ---------------------------------------------------------------------------

export interface AgentTimelineProps {
  timelineMessages: TimelineMessage[]
  streamingContent: string
  streamingParts?: StreamingPart[]
  isStreaming: boolean
  /**
   * Timestamp (ISO string or epoch ms) of when the current streaming run
   * started. Assistant messages with timestamp >= this value are suppressed
   * from the durable timeline so they don't double-render alongside the live
   * streaming overlay (the SDK persists partial progress to DB throughout the
   * turn — without this filter the user sees their own message twice after
   * switching tabs and back during streaming).
   */
  activeRunStartedAt?: number | string | null
  lifecycle: SessionLifecycle
  ephemeralStatusRows?: ThreadStatusRowData[]
  /**
   * Live compaction marker that should appear inline at its own timestamp
   * (NOT pinned at the bottom). Once the run finishes and the compaction
   * lands in `timelineMessages` as a durable message part, the parent stops
   * passing this so the durable copy takes over.
   */
  inflightCompaction?: ThreadStatusRowData | null
  /** Suppress inline TodoCard rendering when the right context panel owns tasks. */
  suppressTodoCards?: boolean
  /** Aggregated final task list — renders one TodoCard when explicitly requested. */
  finalTodoTasks?: SessionTask[]
  /** Session ID — needed for interactive AskUserCard reply */
  sessionId?: string
  /** Worktree path — needed for interactive AskUserCard reply */
  worktreePath?: string | null
  /** Child-session parts keyed by parent tool_use id (sub-agent tool calls) */
  childPartsMap?: Map<string, StreamingPart[]>
  /**
   * Plan content resolved out-of-band (e.g. Claude Code reads the plan from
   * disk in `canUseTool(ExitPlanMode)` and ships it via plan.ready — the SDK's
   * own tool_use.input.plan is empty). Keyed by tool_use id.
   */
  planContentByToolUseId?: Map<string, string>
  onCopyUserMessage?: (message: TimelineMessage) => void
  onEditUserMessage?: (message: TimelineMessage) => void
  onForkUserMessage?: (message: TimelineMessage) => void | Promise<void>
  canEditUserMessage?: (message: TimelineMessage) => boolean
  editingMessageId?: string | null
  editingContent?: string
  onEditingContentChange?: (content: string) => void
  onSaveUserMessageEdit?: (messageId: string) => void | Promise<void>
  onCancelUserMessageEdit?: () => void
  forkingMessageId?: string | null
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>
  onScroll?: () => void
  onWheel?: () => void
  onPointerDown?: () => void
  onPointerUp?: () => void
  onPointerCancel?: () => void
  /**
   * Measured pixel height of the floating ComposerBar / dock so the scroll
   * viewport can reserve enough bottom padding. The previous static value
   * (`pb-[14.5rem]` = 232px) wasn't enough once the composer expanded
   * (attachments preview, multi-line draft, slash popover, queue dropdown),
   * causing the last few transcript nodes to render BEHIND the composer.
   */
  bottomFloatingHeight?: number
  clearScreenBottomInset?: number
  activeRoundId?: string | null
  onActiveRoundChange?: (roundId: string | null) => void
  onRoundAnchorNavigate?: (roundId: string) => void
}

export function AgentTimeline({
  timelineMessages,
  streamingContent,
  streamingParts = [],
  isStreaming,
  activeRunStartedAt,
  lifecycle: _lifecycle,
  ephemeralStatusRows = [],
  inflightCompaction = null,
  suppressTodoCards,
  finalTodoTasks,
  sessionId,
  worktreePath,
  childPartsMap,
  planContentByToolUseId,
  onCopyUserMessage,
  onEditUserMessage,
  onForkUserMessage,
  canEditUserMessage,
  editingMessageId,
  editingContent,
  onEditingContentChange,
  onSaveUserMessageEdit,
  onCancelUserMessageEdit,
  forkingMessageId,
  scrollContainerRef,
  onScroll,
  onWheel,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  bottomFloatingHeight = 0,
  clearScreenBottomInset = 0,
  activeRoundId = null,
  onActiveRoundChange,
  onRoundAnchorNavigate
}: AgentTimelineProps): React.JSX.Element {
  const { t } = useI18n()

  // Flatten messages into timeline nodes
  const nodes = useMemo(() => {
    // Compute a numeric cutoff for the active run. Assistant messages whose
    // timestamp is at or after this cutoff are part of the in-flight turn and
    // are owned by the live streaming overlay below — BUT only for plain
    // text/reasoning content. Structured parts (tool_use, plan, ask-user,
    // subtask, file) come from DB activities that the streaming overlay
    // doesn't replicate, so they must remain visible even while streaming.
    const runCutoffMs =
      isStreaming && activeRunStartedAt != null
        ? typeof activeRunStartedAt === 'number'
          ? activeRunStartedAt
          : Date.parse(activeRunStartedAt)
        : null

    const hasStructuredPart = (msg: TimelineMessage): boolean => {
      if (!msg.parts || msg.parts.length === 0) return false
      return msg.parts.some((part) => part.type !== 'text' && part.type !== 'reasoning')
    }

    const filteredMessages =
      runCutoffMs != null && Number.isFinite(runCutoffMs)
        ? timelineMessages.filter((msg) => {
            if (msg.role !== 'assistant') return true
            if (hasStructuredPart(msg)) return true
            const ts = Date.parse(msg.timestamp)
            if (!Number.isFinite(ts)) return true
            return ts < runCutoffMs
          })
        : timelineMessages

    return filteredMessages
      .flatMap((msg) => messageToNodes(msg))
      .filter((node) => {
        // Suppress inline TodoCards when the right context panel owns tasks.
        if (suppressTodoCards && node.cardType === 'todo') return false
        return true
      })
  }, [timelineMessages, suppressTodoCards, isStreaming, activeRunStartedAt])

  // Find where to splice the live `inflightCompaction` row inline by timestamp.
  // -1 → render before any nodes; >=0 → render AFTER nodes[index]. Once the
  // compaction lands as a durable message in `timelineMessages`, the parent
  // stops passing `inflightCompaction` and the durable copy renders via the
  // normal nodes path instead.
  const inflightCompactionInsertAfter = useMemo(() => {
    if (!inflightCompaction) return null
    const target = inflightCompaction.timestamp
    for (let i = nodes.length - 1; i >= 0; i--) {
      const ts = Date.parse(nodes[i].message.timestamp)
      if (Number.isFinite(ts) && ts <= target) return i
    }
    return -1
  }, [nodes, inflightCompaction])

  // Dedupe by tool_use id: if a tool_use with the same id is already committed
  // in timelineMessages, skip the streaming copy — otherwise a switch-away-and-back
  // during a turn would render the same tool card twice (once from DB-persisted
  // partial state, once from the restored streaming buffer).
  const committedToolUseIds = useMemo(() => {
    const ids = new Set<string>()
    for (const msg of timelineMessages) {
      for (const part of msg.parts ?? []) {
        if (part.type === 'tool_use' && part.toolUse?.id) {
          ids.add(part.toolUse.id)
        }
      }
    }
    return ids
  }, [timelineMessages])

  // Convert live streaming parts into timeline nodes
  const streamingNodes = useMemo(() => {
    if (streamingParts.length === 0) return []
    const placeholderMsg: TimelineMessage = {
      id: 'streaming',
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString()
    }
    const result: TimelineNode[] = []

    for (let i = 0; i < streamingParts.length; i++) {
      const sp = streamingParts[i]

      // Dedupe tool_use that's already committed to timelineMessages
      if (sp.type === 'tool_use' && sp.toolUse?.id && committedToolUseIds.has(sp.toolUse.id)) {
        continue
      }

      if (sp.type === 'text' && sp.text) {
        result.push({
          key: `stream-text-${i}`,
          cardType: 'text',
          message: placeholderMsg,
          textContent: sp.text
        })
      } else if (sp.type === 'reasoning' && sp.reasoning) {
        result.push({
          key: `stream-thinking-${i}`,
          cardType: 'thinking',
          part: sp,
          message: placeholderMsg,
          textContent: sp.reasoning
        })
      } else if (sp.type === 'tool_use' && sp.toolUse) {
        const toolName = sp.toolUse.name?.toLowerCase() ?? ''
        let cardType: CardType = 'tool-call'

        if (isBashToolName(toolName)) {
          cardType = 'bash'
        } else if (toolName === 'read' || toolName === 'readfile' || toolName === 'read_file') {
          cardType = 'file-read'
        } else if (
          toolName === 'write' ||
          toolName === 'edit' ||
          toolName === 'writefile' ||
          toolName === 'write_file' ||
          toolName === 'editfile' ||
          toolName === 'edit_file'
        ) {
          cardType = 'file-write'
        } else if (
          toolName === 'grep' ||
          toolName === 'glob' ||
          toolName === 'search' ||
          toolName === 'codebase_search'
        ) {
          cardType = 'search'
        } else if (
          toolName === 'agent' ||
          toolName === 'subagent' ||
          toolName === 'dispatch_agent'
        ) {
          cardType = 'sub-agent'
        } else if (toolName === 'exitplanmode' || toolName === 'exit_plan_mode') {
          cardType = 'plan'
        } else if (toolName === 'askuserquestion' || toolName === 'ask_user') {
          cardType = 'ask-user'
        } else if (
          toolName === 'todowrite' ||
          toolName === 'todo_write' ||
          toolName === 'taskcreate' ||
          toolName === 'task_create' ||
          toolName === 'taskupdate' ||
          toolName === 'task_update' ||
          toolName === 'todoread' ||
          toolName === 'todo_read' ||
          toolName === 'tasklist' ||
          toolName === 'task_list'
        ) {
          cardType = 'todo'
        }

        result.push({
          key: `stream-tool-${sp.toolUse.id}`,
          cardType,
          part: sp,
          toolUse: sp.toolUse,
          message: placeholderMsg
        })
      } else if (sp.type === 'subtask' && sp.subtask) {
        result.push({
          key: `stream-subtask-${sp.subtask.id}`,
          cardType: 'sub-agent',
          part: sp,
          message: placeholderMsg
        })
      }
    }
    return result.filter((node) => {
      if (suppressTodoCards && node.cardType === 'todo') return false
      return true
    })
  }, [streamingParts, suppressTodoCards, committedToolUseIds])

  const { preludeNodes, rounds } = useMemo(() => groupNodesIntoRounds(nodes), [nodes])

  useEffect(() => {
    if (isStreaming && rounds.length > 0) {
      onActiveRoundChange?.(rounds[rounds.length - 1].id)
      return
    }

    if (!activeRoundId && rounds.length > 0) {
      onActiveRoundChange?.(rounds[rounds.length - 1].id)
    }
  }, [activeRoundId, isStreaming, onActiveRoundChange, rounds])

  useEffect(() => {
    const container = scrollContainerRef?.current
    if (!container || rounds.length === 0 || !onActiveRoundChange) return

    const updateActiveRoundFromScroll = (): void => {
      const sections = Array.from(
        container.querySelectorAll<HTMLElement>('[data-round-anchor="true"]')
      )
      if (sections.length === 0) return

      const containerRect = container.getBoundingClientRect()
      const targetY = containerRect.top + Math.min(container.clientHeight * 0.28, 180)
      let bestId: string | null = null
      let bestDistance = Number.POSITIVE_INFINITY

      for (const section of sections) {
        const rect = section.getBoundingClientRect()
        const distance = Math.abs(rect.top - targetY)
        if (distance < bestDistance) {
          bestDistance = distance
          bestId = section.dataset.roundId ?? null
        }
      }

      if (bestId) {
        onActiveRoundChange(bestId)
      }
    }

    updateActiveRoundFromScroll()
    container.addEventListener('scroll', updateActiveRoundFromScroll, { passive: true })
    return () => container.removeEventListener('scroll', updateActiveRoundFromScroll)
  }, [onActiveRoundChange, rounds, scrollContainerRef])

  const safeBottomPadding = bottomFloatingHeight > 0 ? 24 : 72

  return (
    <div
      ref={scrollContainerRef}
      className="flex-1 overflow-y-auto"
      onScroll={onScroll}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      data-testid="hq-agent-timeline-scroll"
    >
      <div
        className="w-[85%] ml-[5%] py-6"
        style={{
          // SessionShell reserves real layout space for the floating composer.
          // Keep only breathing room here so the final transcript node does not
          // feel glued to that boundary.
          paddingBottom: `${safeBottomPadding}px`
        }}
      >
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            {/* Inline compaction marker inserted by timestamp. */}
            {inflightCompaction && inflightCompactionInsertAfter === -1 && (
              <ThreadStatusRow key={inflightCompaction.id} status={inflightCompaction} />
            )}

            {preludeNodes.map((node, index) => {
              const iconCfg = ICON_MAP[node.cardType]
              const Icon = iconCfg.icon
              const renderConnector = node.cardType !== 'user-message'
              const nextNode = preludeNodes[index + 1]
              const showTimestamp =
                node.cardType !== 'user-message' &&
                node.isLastInMessage &&
                (!nextNode || nextNode.cardType === 'user-message')

              if (node.cardType === 'text') {
                return (
                  <div key={node.key} className="relative pl-10 mb-4">
                    {renderConnector && (
                      <div className="absolute left-[15px] top-0 bottom-0 w-[2px] bg-border opacity-60" />
                    )}
                    <TimelineNodeView
                      node={node}
                      sessionId={sessionId}
                      worktreePath={worktreePath}
                      childPartsMap={childPartsMap}
                      planContentByToolUseId={planContentByToolUseId}
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
                    {showTimestamp && node.message.timestamp && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {formatMessageTime(node.message.timestamp)}
                      </div>
                    )}
                  </div>
                )
              }

              return (
                <div key={node.key} className="relative pl-10 mb-4">
                  {renderConnector && (
                    <div className="absolute left-[15px] top-0 bottom-0 w-[2px] bg-border opacity-60" />
                  )}
                  <div
                    className={cn(
                      'absolute left-[4px] top-2.5 w-[24px] h-[24px] rounded-full',
                      'flex items-center justify-center z-10',
                      iconCfg.bgClass,
                      iconCfg.colorClass
                    )}
                  >
                    <Icon className="h-3 w-3" />
                  </div>
                  <TimelineNodeView
                    node={node}
                    sessionId={sessionId}
                    worktreePath={worktreePath}
                    childPartsMap={childPartsMap}
                    planContentByToolUseId={planContentByToolUseId}
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
                  {showTimestamp && node.message.timestamp && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {formatMessageTime(node.message.timestamp)}
                    </div>
                  )}
                </div>
              )
            })}

            {rounds.map((round) => {
              return (
                <section
                  key={round.id}
                  id={round.anchorId}
                  data-round-anchor="true"
                  data-round-id={round.id}
                  className="mb-7 scroll-mt-8"
                >
                  {round.nodes.map((node, nodeIndex) => {
                    const iconCfg = ICON_MAP[node.cardType]
                    const Icon = iconCfg.icon
                    const renderConnector = node.cardType !== 'user-message'
                    const nextNode = round.nodes[nodeIndex + 1]
                    const showTimestamp =
                      node.cardType !== 'user-message' &&
                      node.isLastInMessage &&
                      (!nextNode || nextNode.cardType === 'user-message')

                    const globalNodeIndex = nodes.findIndex(
                      (candidate) => candidate.key === node.key
                    )
                    const compactionSuffix =
                      inflightCompaction && inflightCompactionInsertAfter === globalNodeIndex ? (
                        <ThreadStatusRow
                          key={`${inflightCompaction.id}-after-${globalNodeIndex}`}
                          status={inflightCompaction}
                        />
                      ) : null

                    if (node.cardType === 'user-message') {
                      return (
                        <React.Fragment key={node.key}>
                          <div className="mb-6">
                            <TimelineNodeView
                              node={node}
                              sessionId={sessionId}
                              worktreePath={worktreePath}
                              childPartsMap={childPartsMap}
                              planContentByToolUseId={planContentByToolUseId}
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
                          </div>
                          {compactionSuffix}
                        </React.Fragment>
                      )
                    }

                    if (node.cardType === 'text') {
                      return (
                        <React.Fragment key={node.key}>
                          <div className="relative pl-10 mb-4">
                            {renderConnector && (
                              <div className="absolute left-[15px] top-0 bottom-0 w-[2px] bg-border opacity-60" />
                            )}
                            <TimelineNodeView
                              node={node}
                              sessionId={sessionId}
                              worktreePath={worktreePath}
                              childPartsMap={childPartsMap}
                              planContentByToolUseId={planContentByToolUseId}
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
                            {showTimestamp && node.message.timestamp && (
                              <div className="mt-1 text-xs text-muted-foreground">
                                {formatMessageTime(node.message.timestamp)}
                              </div>
                            )}
                          </div>
                          {compactionSuffix}
                        </React.Fragment>
                      )
                    }

                    return (
                      <React.Fragment key={node.key}>
                        <div className="relative pl-10 mb-4">
                          {renderConnector && (
                            <div className="absolute left-[15px] top-0 bottom-0 w-[2px] bg-border opacity-60" />
                          )}
                          <div
                            className={cn(
                              'absolute left-[4px] top-2.5 w-[24px] h-[24px] rounded-full',
                              'flex items-center justify-center z-10',
                              iconCfg.bgClass,
                              iconCfg.colorClass
                            )}
                          >
                            <Icon className="h-3 w-3" />
                          </div>
                          <TimelineNodeView
                            node={node}
                            sessionId={sessionId}
                            worktreePath={worktreePath}
                            childPartsMap={childPartsMap}
                            planContentByToolUseId={planContentByToolUseId}
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
                          {showTimestamp && node.message.timestamp && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              {formatMessageTime(node.message.timestamp)}
                            </div>
                          )}
                        </div>
                        {compactionSuffix}
                      </React.Fragment>
                    )
                  })}
                </section>
              )
            })}

            {/* Final aggregated TodoCard — rendered only when a parent explicitly passes it. */}
            {finalTodoTasks && finalTodoTasks.length > 0 && (
              <div className="relative pl-10 mb-4">
                <div className="absolute left-[15px] top-0 bottom-0 w-[2px] bg-border opacity-60" />
                <div
                  className={cn(
                    'absolute left-[4px] top-2.5 w-[24px] h-[24px] rounded-full',
                    'flex items-center justify-center z-10',
                    ICON_MAP.todo.bgClass,
                    ICON_MAP.todo.colorClass
                  )}
                >
                  <CheckSquare className="h-3 w-3" />
                </div>
                <TodoCard tasks={finalTodoTasks} />
              </div>
            )}

            {/* Live streaming parts — real-time tool/text/reasoning rendering */}
            {isStreaming &&
              streamingNodes.length > 0 &&
              streamingNodes.map((node, idx) => {
                const iconCfg = ICON_MAP[node.cardType]
                const Icon = iconCfg.icon
                const isLastStreamNode = idx === streamingNodes.length - 1

                if (node.cardType === 'text') {
                  return (
                    <div key={node.key} className="relative pl-10 mb-4">
                      <div className="absolute left-[15px] top-0 bottom-0 w-[2px] bg-border opacity-60" />
                      <div
                        className={cn(
                          'absolute left-[4px] top-2.5 w-[24px] h-[24px] rounded-full',
                          'flex items-center justify-center z-10',
                          isLastStreamNode
                            ? 'bg-neon-mint-soft text-neon-mint'
                            : iconCfg.bgClass + ' ' + iconCfg.colorClass
                        )}
                      >
                        {isLastStreamNode ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Icon className="h-3 w-3" />
                        )}
                      </div>
                      <TextCard content={node.textContent ?? ''} isStreaming={isLastStreamNode} />
                    </div>
                  )
                }

                return (
                  <div key={node.key} className="relative pl-10 mb-4">
                    <div className="absolute left-[15px] top-0 bottom-0 w-[2px] bg-border opacity-60" />
                    <div
                      className={cn(
                        'absolute left-[4px] top-2.5 w-[24px] h-[24px] rounded-full',
                        'flex items-center justify-center z-10',
                        iconCfg.bgClass,
                        iconCfg.colorClass
                      )}
                    >
                      <Icon className="h-3 w-3" />
                    </div>
                    <TimelineNodeView
                      node={node}
                      sessionId={sessionId}
                      worktreePath={worktreePath}
                      childPartsMap={childPartsMap}
                      planContentByToolUseId={planContentByToolUseId}
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
                  </div>
                )
              })}

            {/* Streaming with no content yet — show pulse */}
            {isStreaming && streamingNodes.length === 0 && !streamingContent && (
              <div className="relative pl-10 mb-4">
                <div
                  className={cn(
                    'absolute left-[4px] top-2.5 w-[24px] h-[24px] rounded-full',
                    'flex items-center justify-center z-10',
                    'bg-neon-mint-soft text-neon-mint'
                  )}
                >
                  <Loader2 className="h-3 w-3 animate-spin" />
                </div>
                <div className="text-sm text-muted-foreground italic">
                  {t('sessionHq.timeline.thinking')}
                </div>
              </div>
            )}

            {ephemeralStatusRows.map((status) => (
              <ThreadStatusRow key={status.id} status={status} />
            ))}

            {clearScreenBottomInset > 0 && nodes.length > 0 && (
              <div
                aria-hidden="true"
                data-testid="timeline-clear-screen-spacer"
                style={{ height: `${clearScreenBottomInset}px` }}
              />
            )}

            {/* Empty state */}
            {nodes.length === 0 && ephemeralStatusRows.length === 0 && !isStreaming && (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                <MessageSquare className="h-10 w-10 mb-3 opacity-30" />
                <div className="text-sm font-medium">{t('sessionHq.timeline.emptyTitle')}</div>
                <div className="text-xs mt-1">{t('sessionHq.timeline.emptySubtitle')}</div>
              </div>
            )}
          </div>

          {rounds.length > 0 && (
            <aside
              className="sticky top-1/2 hidden w-10 shrink-0 -translate-y-1/2 lg:block"
              data-testid="timeline-round-anchor-rail"
            >
              <div className="flex max-h-[60vh] flex-col items-center justify-center gap-2 overflow-y-auto py-2">
                {rounds.map((round, index) => {
                  const isActive =
                    activeRoundId === round.id || (!activeRoundId && index === rounds.length - 1)
                  return (
                    <button
                      key={`rail-${round.id}`}
                      type="button"
                      onClick={() => onRoundAnchorNavigate?.(round.id)}
                      className={cn(
                        'group relative flex h-4 w-4 items-center justify-center rounded-full transition-all',
                        isActive ? 'scale-110' : 'hover:scale-105'
                      )}
                      title={round.preview}
                      aria-label={`跳转到第 ${index + 1} 轮：${round.preview}`}
                    >
                      <span
                        className={cn(
                          'block h-2.5 w-2.5 rounded-full border transition-all',
                          isActive
                            ? 'border-primary bg-primary shadow-[0_0_14px_rgba(59,130,246,0.55)]'
                            : 'border-border/80 bg-muted-foreground/30 group-hover:border-primary/55 group-hover:bg-primary/45'
                        )}
                      />
                    </button>
                  )
                })}
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  )
}
