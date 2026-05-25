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
import { useQuestionStore, type QuestionRequest } from '@/stores/useQuestionStore'

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

// Stable module-level empty array so the useQuestionStore selector never
// returns a fresh reference (which would force every TimelineNodeView to
// re-render on every store mutation).
const EMPTY_QUESTIONS: readonly QuestionRequest[] = Object.freeze([])

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// ---------------------------------------------------------------------------
// Fisheye rail — macOS Dock-style local zoom
// ---------------------------------------------------------------------------

/**
 * Peak spacing expansion multiplier at the hovered dot.
 * 3× means the center dot and its immediate neighbors spread to three times
 * their natural spacing, while dots at the far end compress to compensate —
 * exactly how the macOS Dock works.
 */
const FISHEYE_MAX_EXPANSION = 3.0

/**
 * Compute fisheye positions for ALL round anchor dots in one pass.
 *
 * Each dot's "virtual spacing" is scaled by a cosine bell centred on hoverY.
 * Positions are then renormalised so the total span always equals railHeight,
 * producing the neighbour-push effect: hovering near dot i spreads dots
 * i-1, i, i+1 apart while dots far away compress to make room.
 *
 * When hoverY is null (no hover), returns evenly distributed positions.
 */
function computeFisheyeLayout(
  roundCount: number,
  railHeight: number,
  hoverY: number | null
): { topPercents: number[]; expansions: number[] } {
  if (roundCount <= 0) return { topPercents: [], expansions: [] }
  if (roundCount === 1) return { topPercents: [50], expansions: [1] }

  const N = roundCount
  // Natural dot spacing for dots anchored at 0 … railHeight (both ends inclusive)
  const naturalSpacing = railHeight / (N - 1)
  // Influence radius ≈ 28% of rail height, clamped so it stays meaningful on both
  // very short rails (< 240 px) and very tall rails (> 500 px)
  const R = clamp(railHeight * 0.28, 64, 140)

  // Per-dot expansion factor from cosine bell: 1 at R away, FISHEYE_MAX_EXPANSION at centre
  const expansions = Array.from({ length: N }, (_, i) => {
    if (hoverY === null) return 1.0
    const naturalY = (i / (N - 1)) * railHeight
    const d = Math.abs(naturalY - hoverY)
    if (d >= R) return 1.0
    const bell = 0.5 * (1 + Math.cos((Math.PI * d) / R))
    return 1.0 + bell * (FISHEYE_MAX_EXPANSION - 1.0)
  })

  if (hoverY === null) {
    // Fast path: natural positions, no recomputation needed
    const topPercents = Array.from({ length: N }, (_, i) => (i / (N - 1)) * 100)
    return { topPercents, expansions }
  }

  // Inter-dot spacing = naturalSpacing × mean(adjacent expansion factors).
  // This is the Dock formula: spacing between two neighbours scales with the
  // average of their local expansion, so the crowd effect is smooth.
  const expandedY: number[] = new Array(N).fill(0)
  for (let i = 1; i < N; i++) {
    const avgExpansion = (expansions[i - 1] + expansions[i]) / 2
    expandedY[i] = expandedY[i - 1] + naturalSpacing * avgExpansion
  }
  const totalExpanded = expandedY[N - 1] || 1

  // Scale cumulative positions back to [0, 100]% so the rail stays fixed-height
  const topPercents = expandedY.map((y) => (y / totalExpanded) * 100)

  return { topPercents, expansions }
}

/**
 * Visual style for a single dot, given its precomputed position + expansion.
 *
 * Size grows from a tiny pill at rest to a wider capsule at peak hover,
 * keeping the Dock metaphor: the "icon" under the cursor is prominently
 * enlarged while distant icons stay small.
 */
function getRailDotStyle({
  topPercent,
  expansion,
  active,
  hovering
}: {
  topPercent: number
  expansion: number
  active: boolean
  /** Whether the cursor is anywhere on the rail right now. */
  hovering: boolean
}): React.CSSProperties {
  const t = clamp((expansion - 1) / (FISHEYE_MAX_EXPANSION - 1), 0, 1)
  // Pill: 4 × 4 px at rest → 22 × 12 px at peak hover
  const w = 4 + t * 18
  const h = 4 + t * 8

  // Opacity contract for the Floating Shuttle Rail:
  //   active   → always visible; 0.75 at rest, 1.0 at peak hover expansion
  //   inactive + hovering → ghost dots materialise, brighter near the cursor
  //   inactive + not hovering → completely transparent (rail is "empty" at rest)
  let opacity: number
  if (active) {
    opacity = clamp(0.75 + t * 0.25, 0.75, 1)
  } else if (hovering) {
    opacity = clamp(0.35 + t * 0.50, 0.35, 0.85)
  } else {
    opacity = 0
  }

  return {
    top: `${topPercent}%`,
    width: `${w}px`,
    height: `${h}px`,
    opacity,
    transform: 'translate(-50%, -50%)',
    zIndex: Math.round(10 + t * 30)
  }
}

function getRoundRailIndexFromY(y: number, railHeight: number, roundCount: number): number {
  if (roundCount <= 1) return 0
  return clamp(Math.round((y / railHeight) * (roundCount - 1)), 0, roundCount - 1)
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

  // Bug 2 cross-validation: subscribe to the question store so an ask-user
  // card stays in 'pending' state whenever the runtime still believes the
  // question is unanswered, even if `toolUse.status` has been advanced to
  // 'success' (e.g. by Codex emitting a tool-completed event after the user
  // switched sessions). Without this, switching back to the session shows the
  // card as "Answered" while the composer is still blocked waiting for input.
  const pendingQuestions = useQuestionStore((s) =>
    sessionId ? (s.pendingBySession.get(sessionId) ?? EMPTY_QUESTIONS) : EMPTY_QUESTIONS
  )

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
        planStatus === 'success' ? 'approved' : planStatus === 'rejected' ? 'rejected' : undefined
      return (
        <PlanCard
          content={content}
          isPending={planStatus === 'pending' || planStatus === 'running'}
          verdict={verdict}
        />
      )
    }

    case 'ask-user': {
      const askToolUseId = node.toolUse?.id
      // Cross-validate against the runtime question store: even if
      // toolUse.status says the question was resolved, keep the card in
      // pending mode while useQuestionStore still has a matching unanswered
      // question for this session (Bug 2). Match by tool callID first, then
      // by question id, since either side could be the stable identifier
      // depending on which agent runtime produced the request.
      const stillPendingForThisCard =
        !!askToolUseId &&
        pendingQuestions.some((q) => q.tool?.callID === askToolUseId || q.id === askToolUseId)
      const askStatus = node.toolUse?.status
      const isPending =
        askStatus === 'pending' || askStatus === 'running' || stillPendingForThisCard
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
          isPending={isPending}
          sessionId={sessionId}
          worktreePath={worktreePath}
          answer={node.toolUse?.output}
        />
      )
    }

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
  /**
   * Optional ref forwarded from SessionShell so it can measure the content div
   * height for computing the clear-screen spacer height.
   */
  contentHeightRef?: React.RefObject<HTMLDivElement | null>
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
  /**
   * Physical spacer height (px). Used when a new round starts (clear screen) to
   * push content to the viewport top. Must be passed to useSessionSmartScroll so
   * getDistanceFromBottom correctly accounts for the inflated scrollHeight.
   */
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
  contentHeightRef,
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
  const internalScrollContainerRef = React.useRef<HTMLDivElement | null>(null)
  const effectiveScrollContainerRef = scrollContainerRef ?? internalScrollContainerRef
  const internalTimelineContentRef = React.useRef<HTMLDivElement | null>(null)
  const timelineContentRef = contentHeightRef ?? internalTimelineContentRef
  const [timelineViewportHeight, setTimelineViewportHeight] = React.useState(0)
  const [timelineContentHeight, setTimelineContentHeight] = React.useState(0)

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

  // 压缩 marker 始终渲染在已落库的 rounds 末尾、streaming 节点之前——
  // 时间戳定位（旧的 inflightCompactionInsertAfter）在客户端 Date.now()
  // 比节点时间戳更早时会落到 -1，把 marker 抛到时间线最上面，反复出现错位。
  // 当 message.part.type === 'compaction' 已落库时，SessionShell 不再传
  // inflightCompaction，下一轮自然走 nodes 通路。
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
  const [roundRailHoverY, setRoundRailHoverY] = React.useState<number | null>(null)
  const [roundRailHeight, setRoundRailHeight] = React.useState(336)

  // Precompute fisheye layout once per hover / size / count change instead of
  // recomputing inside every dot's render call. O(n) per state change, shared.
  const fisheyeLayout = useMemo(
    () => computeFisheyeLayout(rounds.length, roundRailHeight, roundRailHoverY),
    [rounds.length, roundRailHeight, roundRailHoverY]
  )

  // Scroll-edge gradient masks (Step 4 — visual boundary feedback)
  const [showTopGradient, setShowTopGradient] = React.useState(false)
  const [showBottomGradient, setShowBottomGradient] = React.useState(false)

  React.useEffect(() => {
    const el = effectiveScrollContainerRef.current
    if (!el) return

    const update = (): void => {
      setShowTopGradient(el.scrollTop > 16)
      setShowBottomGradient(el.scrollHeight - el.scrollTop - el.clientHeight > 16)
    }

    update()
    el.addEventListener('scroll', update, { passive: true })

    const obs =
      typeof ResizeObserver !== 'undefined'
        ? (() => {
            const o = new ResizeObserver(update)
            o.observe(el)
            return o
          })()
        : null

    return () => {
      el.removeEventListener('scroll', update)
      obs?.disconnect()
    }
  }, [effectiveScrollContainerRef])

  React.useLayoutEffect(() => {
    const element = effectiveScrollContainerRef.current
    if (!element) return

    const updateRailHeight = (): void => {
      const nextHeight = Math.round(element.clientHeight)
      if (nextHeight > 0) {
        setRoundRailHeight(nextHeight)
      }
    }

    updateRailHeight()

    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(updateRailHeight)
    observer.observe(element)
    return () => observer.disconnect()
  }, [effectiveScrollContainerRef])

  // Measure viewport and content heights so the clear-screen spacer can be
  // sized to push content to the viewport top without a fixed spacer height.
  // This uses requestAnimationFrame batching to avoid layout thrashing on
  // content changes that cascade (content change → spacer height changes →
  // scrollHeight changes → ResizeObserver fires again).
  React.useLayoutEffect(() => {
    const scrollElement = effectiveScrollContainerRef.current
    const contentElement = timelineContentRef.current
    if (!scrollElement || !contentElement) return

    let frame: number | null = null
    const updateTimelineMetrics = (): void => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }

      frame = requestAnimationFrame(() => {
        frame = null
        const nextViewportHeight = Math.round(scrollElement.clientHeight)
        const nextContentHeight = Math.round(contentElement.getBoundingClientRect().height)

        setTimelineViewportHeight((current) =>
          current === nextViewportHeight ? current : nextViewportHeight
        )
        setTimelineContentHeight((current) =>
          current === nextContentHeight ? current : nextContentHeight
        )
      })
    }

    updateTimelineMetrics()

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        if (frame !== null) {
          cancelAnimationFrame(frame)
        }
      }
    }

    const observer = new ResizeObserver(updateTimelineMetrics)
    observer.observe(scrollElement)
    observer.observe(contentElement)

    return () => {
      observer.disconnect()
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [
    effectiveScrollContainerRef,
    nodes.length,
    streamingNodes.length,
    ephemeralStatusRows.length,
    finalTodoTasks?.length,
    clearScreenBottomInset,
    isStreaming
  ])

  const handleRoundRailPointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect()
      if (rect.height <= 0) return
      if (!Number.isFinite(event.clientY)) return
      setRoundRailHeight(rect.height)
      setRoundRailHoverY(clamp(event.clientY - rect.top, 0, rect.height))
    },
    []
  )

  const handleRoundRailPointerLeave = React.useCallback(() => {
    setRoundRailHoverY(null)
  }, [])

  const handleRoundRailClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!onRoundAnchorNavigate || rounds.length === 0) return
      const rect = event.currentTarget.getBoundingClientRect()
      if (rect.height <= 0) return
      const y = clamp(event.clientY - rect.top, 0, rect.height)
      const roundIndex = getRoundRailIndexFromY(y, rect.height, rounds.length)
      onRoundAnchorNavigate(rounds[roundIndex].id)
    },
    [onRoundAnchorNavigate, rounds]
  )

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
    const container = effectiveScrollContainerRef.current
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
  }, [effectiveScrollContainerRef, onActiveRoundChange, rounds])

  // SessionShell 通过 CSS Grid 的 row-2 给 ComposerBar 留出了物理空间，
  // 但 ComposerBar 自身的 `crisp-floating-surface` box-shadow 会向上扩散
  // ~15px、`crisp-composer-veil` 渐变末段（70-100% 区段）浓度高达 ~82%，
  // 这一带视觉上仍然在「压」transcript 最后一行。原先 hardcoded 的 24px
  // 不够 breathing room，流式输出滚到底时最后一行紧贴这条视觉边界，
  // 直观感受就是「输出跑到了输入框下面」。
  //
  // 这里改成跟随测量值 `bottomFloatingHeight`（composerHeight + dockHeight）
  // 动态计算：保底 56px（容纳阴影 + veil + 一点呼吸），并按 0.3 比例随
  // composer 扩展（attachments / voice / slash popover / 多行草稿）增长；
  // 封顶 96px 避免内容很短时拉出过多空白。
  //
  // 数值落点示例：
  //   60px (单行 composer, 无 dock) → 56px
  //  160px (展开 composer, 无 dock) → 80px
  //  280px (展开 + InterruptDock)   → 96px
  const safeBottomPadding =
    bottomFloatingHeight > 0
      ? Math.min(96, Math.max(56, Math.round(bottomFloatingHeight * 0.3) + 32))
      : 72

  // When the last round is a bootstrap (only a user message) and there isn't enough
  // content to fill the viewport, the spacer pushes it to the top so the user
  // message appears near the top of the screen (the "clear screen" visual effect).
  // This spacer height must be passed to useSessionSmartScroll so that
  // getDistanceFromBottom correctly accounts for the inflated scrollHeight.
  const shortContentTopSpacer =
    timelineViewportHeight > 0 && timelineContentHeight > 0
      ? Math.max(0, timelineViewportHeight - timelineContentHeight - safeBottomPadding - 24)
      : 0

  return (
    <div
      ref={effectiveScrollContainerRef}
      className="h-full min-h-0 overflow-y-auto overscroll-contain"
      onScroll={onScroll}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      data-testid="hq-agent-timeline-scroll"
    >
      {/* Top edge mask: visible when content extends above the viewport */}
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none sticky top-0 z-10 h-10 -mb-10 bg-gradient-to-b from-background/65 to-transparent transition-opacity duration-200',
          showTopGradient ? 'opacity-100' : 'opacity-0'
        )}
      />
      <div
        className="w-[85%] ml-[5%]"
        style={{
          // SessionShell reserves real layout space for the floating composer.
          // Keep only breathing room here so the final transcript node does not
          // feel glued to that boundary.
          paddingTop: `${24 + shortContentTopSpacer}px`,
          paddingBottom: `${safeBottomPadding}px`
        }}
      >
        <div className="flex items-start gap-4">
          <div ref={timelineContentRef} className="min-w-0 flex-1">
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

                    if (node.cardType === 'user-message') {
                      return (
                        <div key={node.key} className="mb-6">
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
                    }

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
                </section>
              )
            })}

            {/* Inflight 压缩 marker：永远落在 rounds 之后、streaming 之前。 */}
            {inflightCompaction && (
              <ThreadStatusRow key={inflightCompaction.id} status={inflightCompaction} />
            )}

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

            {/* Live streaming parts — real-time tool/text/reasoning rendering.
                Render from buffer regardless of streaming state so content survives
                session switches: the buffer holds what thread/read hasn't persisted yet. */}
            {streamingNodes.length > 0 &&
              streamingNodes.map((node, idx) => {
                const iconCfg = ICON_MAP[node.cardType]
                const Icon = iconCfg.icon
                const isLastStreamNode = idx === streamingNodes.length - 1
                const showSpinner = isStreaming && isLastStreamNode

                if (node.cardType === 'text') {
                  return (
                    <div key={node.key} className="relative pl-10 mb-4">
                      <div className="absolute left-[15px] top-0 bottom-0 w-[2px] bg-border opacity-60" />
                      <div
                        className={cn(
                          'absolute left-[4px] top-2.5 w-[24px] h-[24px] rounded-full',
                          'flex items-center justify-center z-10',
                          showSpinner
                            ? 'bg-neon-mint-soft text-neon-mint'
                            : iconCfg.bgClass + ' ' + iconCfg.colorClass
                        )}
                      >
                        {showSpinner ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Icon className="h-3 w-3" />
                        )}
                      </div>
                      <TextCard content={node.textContent ?? ''} isStreaming={showSpinner} />
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

            {/* Clear-screen spacer: renders when a new round starts (bootstrap round)
                and content doesn't fill the viewport. The spacer pushes content to the
                top so the user message appears near the viewport top (清屏 effect).
                Its height is measured by the ResizeObserver above (via shortContentTopSpacer)
                and passed to useSessionSmartScroll so that getDistanceFromBottom correctly
                accounts for the inflated scrollHeight. */}
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

          {rounds.length > 1 && (
            <aside
              className="sticky top-0 -mt-6 hidden w-8 shrink-0 self-start lg:block"
              data-testid="timeline-round-anchor-rail"
            >
              {/*
               * Floating Shuttle Rail — borderless, backgroundless.
               *
               * At rest   : only the active dot (a glowing bead) floats in
               *             empty vertical space. No container, no track line.
               * On hover  : a faint dashed guide line and ghost dots fade in,
               *             then distort into the Dock-style fisheye as the
               *             cursor moves along the axis.
               */}
              <div
                className="group relative cursor-pointer overflow-visible"
                data-testid="timeline-round-anchor-rail-items"
                style={{ height: `${roundRailHeight}px` }}
                onPointerMove={handleRoundRailPointerMove}
                onMouseMove={handleRoundRailPointerMove}
                onPointerLeave={handleRoundRailPointerLeave}
                onMouseLeave={handleRoundRailPointerLeave}
                onClick={handleRoundRailClick}
              >
                {/* Dashed guide axis — invisible at rest, fades in on hover */}
                <div
                  aria-hidden="true"
                  className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 border-l border-dashed border-border/30 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                />
                {rounds.map((round, roundIndex) => {
                  const isActive =
                    activeRoundId === round.id ||
                    (!activeRoundId && roundIndex === rounds.length - 1)
                  const dotStyle = getRailDotStyle({
                    topPercent:
                      fisheyeLayout.topPercents[roundIndex] ??
                      (roundIndex / Math.max(rounds.length - 1, 1)) * 100,
                    expansion: fisheyeLayout.expansions[roundIndex] ?? 1,
                    active: isActive,
                    hovering: roundRailHoverY !== null
                  })
                  return (
                    <button
                      key={`rail-${round.id}`}
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        onRoundAnchorNavigate?.(round.id)
                      }}
                      className={cn(
                        'absolute left-1/2 rounded-full transition-[width,height,opacity,background-color,box-shadow] duration-150 ease-out',
                        isActive
                          ? // Floating bead: soft dual-layer glow, no hard border
                            'bg-primary/90 shadow-[0_0_8px_rgba(59,130,246,0.55),0_0_3px_rgba(59,130,246,0.25)]'
                          : // Ghost dot: no border, brightens on individual hover
                            'bg-muted-foreground/35 hover:bg-primary/55'
                      )}
                      style={dotStyle}
                      title={round.preview}
                      aria-current={isActive ? 'step' : undefined}
                      aria-label={`跳转到第 ${roundIndex + 1} 轮：${round.preview}`}
                      data-testid="timeline-round-anchor-button"
                    />
                  )
                })}
              </div>
            </aside>
          )}
        </div>
      </div>
      {/* Bottom edge mask: visible when content extends below the viewport */}
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none sticky bottom-0 z-10 h-10 -mt-10 bg-gradient-to-t from-background/65 to-transparent transition-opacity duration-200',
          showBottomGradient ? 'opacity-100' : 'opacity-0'
        )}
      />
    </div>
  )
}
