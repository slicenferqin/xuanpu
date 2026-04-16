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

import React, { useRef, useEffect, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { formatMessageTime } from '@/lib/format-time'
import type { TimelineMessage, StreamingPart, ToolUseInfo } from '@shared/lib/timeline-types'
import type { MessagePart } from '@shared/types/opencode'
import type { SessionLifecycle } from '@/stores/useSessionRuntimeStore'
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

/**
 * Explode a single TimelineMessage into 1+ timeline nodes.
 *
 * Each part that maps to a distinct card becomes its own node.
 * Text parts are collapsed into a single text node at the end.
 */
function messageToNodes(message: TimelineMessage): TimelineNode[] {
  // User messages → single node
  if (message.role === 'user') {
    return [{
      key: `${message.id}-user`,
      cardType: 'user-message',
      message,
      textContent: message.content,
      attachments: message.attachments,
      isLastInMessage: true
    }]
  }

  // System messages → skip
  if (message.role === 'system') return []

  // Assistant message — break into nodes per part
  const parts = message.parts ?? []

  // If this message contains a compaction part, render a compact status instead
  // of leaking the compressed summary text into the timeline
  const hasCompaction = parts.some((p) => p.type === 'compaction')
  if (hasCompaction) {
    return [{
      key: `${message.id}-compaction`,
      cardType: 'system' as CardType,
      message,
      textContent: 'Context compressed',
      isLastInMessage: true
    }]
  }

  if (parts.length === 0 && message.content.trim()) {
    return [{
      key: `${message.id}-text`,
      cardType: 'text',
      message,
      textContent: message.content,
      isLastInMessage: true
    }]
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

      if (toolName === 'bash' || toolName === 'execute_command') {
        cardType = 'bash'
      } else if (toolName === 'read' || toolName === 'readfile' || toolName === 'read_file') {
        cardType = 'file-read'
      } else if (
        toolName === 'write' || toolName === 'edit' ||
        toolName === 'writefile' || toolName === 'write_file' ||
        toolName === 'editfile' || toolName === 'edit_file'
      ) {
        cardType = 'file-write'
      } else if (
        toolName === 'grep' || toolName === 'glob' ||
        toolName === 'search' || toolName === 'codebase_search'
      ) {
        cardType = 'search'
      } else if (toolName === 'agent' || toolName === 'subagent' || toolName === 'dispatch_agent') {
        cardType = 'sub-agent'
      } else if (toolName === 'exitplanmode' || toolName === 'exit_plan_mode') {
        cardType = 'plan'
      } else if (toolName === 'askuserquestion' || toolName === 'ask_user') {
        cardType = 'ask-user'
      } else if (
        toolName === 'todowrite' || toolName === 'todo_write' ||
        toolName === 'taskcreate' || toolName === 'task_create' ||
        toolName === 'taskupdate' || toolName === 'task_update' ||
        toolName === 'todoread' || toolName === 'todo_read' ||
        toolName === 'tasklist' || toolName === 'task_list'
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
  'user-message': { icon: User, colorClass: 'text-blue-600 dark:text-blue-400', bgClass: 'bg-blue-500/15' },
  'system': { icon: MessageSquare, colorClass: 'text-muted-foreground', bgClass: 'bg-muted' },
  'thinking': { icon: Brain, colorClass: 'text-muted-foreground', bgClass: 'bg-muted' },
  'bash': { icon: Terminal, colorClass: 'text-celadon', bgClass: 'bg-celadon/15' },
  'file-read': { icon: FileText, colorClass: 'text-celadon', bgClass: 'bg-celadon/15' },
  'file-write': { icon: Pencil, colorClass: 'text-blue-600 dark:text-blue-400', bgClass: 'bg-blue-500/15' },
  'search': { icon: Search, colorClass: 'text-celadon', bgClass: 'bg-celadon/15' },
  'sub-agent': { icon: Users, colorClass: 'text-purple-600 dark:text-purple-400', bgClass: 'bg-purple-500/15' },
  'plan': { icon: ClipboardList, colorClass: 'text-purple-600 dark:text-purple-400', bgClass: 'bg-purple-500/15' },
  'ask-user': { icon: HelpCircle, colorClass: 'text-amber-600 dark:text-amber-400', bgClass: 'bg-amber-500/15' },
  'todo': { icon: CheckSquare, colorClass: 'text-celadon', bgClass: 'bg-celadon/15' },
  'tool-call': { icon: Terminal, colorClass: 'text-muted-foreground', bgClass: 'bg-muted' },
  'text': { icon: MessageSquare, colorClass: 'text-foreground', bgClass: 'bg-muted' }
}

// ---------------------------------------------------------------------------
// Generic tool label helper
// ---------------------------------------------------------------------------

/** Generate a display label for generic/unrecognized tool calls */
function getGenericToolLabel(name: string, input?: Record<string, unknown>): string {
  const lower = name.toLowerCase()
  if (lower === 'skill' && input?.skill) {
    return `/${input.skill as string}`
  }
  if ((lower === 'webfetch' || lower === 'web_fetch') && input?.url) {
    try { return new URL(input.url as string).hostname } catch { return name }
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
  childPartsMap
}: {
  node: TimelineNode
  sessionId?: string
  worktreePath?: string | null
  childPartsMap?: Map<string, StreamingPart[]>
}): React.JSX.Element | null {
  switch (node.cardType) {
    case 'user-message': {
      type FilePart = Extract<MessagePart, { type: 'file' }>
      const images = (node.attachments?.filter((a) => a.type === 'file' && a.mime.startsWith('image/')) ?? []) as FilePart[]
      const files = (node.attachments?.filter((a) => a.type === 'file' && !a.mime.startsWith('image/')) ?? []) as FilePart[]
      return (
        <div className="bg-blue-500/5 border border-blue-500/20 rounded-[10px] px-3.5 py-2.5">
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
                <div key={i} className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/50 px-2.5 py-1.5 text-xs text-muted-foreground">
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  {f.filename ?? 'file'}
                </div>
              ))}
            </div>
          )}
          {node.textContent && (
            <div className={cn('text-sm text-foreground whitespace-pre-wrap break-words', (images.length > 0 || files.length > 0) && 'mt-2')}>
              {node.textContent}
            </div>
          )}
        </div>
      )
    }

    case 'system':
      return (
        <div className="text-xs text-muted-foreground italic py-1">
          {node.textContent}
        </div>
      )

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
              description: (node.toolUse.input?.description as string) ?? 'Delegated task',
              agent: (node.toolUse.input?.subagent_type as string) ?? 'Agent',
              parts: [],
              status: (node.toolUse.status === 'success' ? 'completed'
                : node.toolUse.status === 'error' ? 'error'
                : 'running') as 'running' | 'completed' | 'error'
            }
          : null
      if (!subtaskData) return null
      const childParts = childPartsMap?.get(subtaskData.id) ?? []
      return <SubAgentCard subtask={subtaskData} childParts={childParts} />
    }

    case 'plan':
      return (
        <PlanCard
          content={
            (node.toolUse?.input?.plan as string)
            ?? (node.toolUse?.output as string)
            ?? ''
          }
          isPending={node.toolUse?.status === 'pending' || node.toolUse?.status === 'running'}
        />
      )

    case 'ask-user':
      return (
        <AskUserCard
          question={
            (node.toolUse?.input?.question as string) ?? ''
          }
          questions={
            Array.isArray(node.toolUse?.input?.questions)
              ? (node.toolUse!.input!.questions as Array<{ question: string; options?: Array<{ label: string; description?: string }>; header?: string; multiple?: boolean }>)
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
      return (
        <div className="rounded-lg border border-border/50 bg-card/80 px-3.5 py-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-foreground">{label}</span>
            <span className="text-xs text-muted-foreground">
              {isRunning ? 'Running...' : isError ? 'Error' : isSuccess ? 'Done' : node.toolUse.status}
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
  lifecycle: SessionLifecycle
  /** Suppress inline TodoCard rendering when MissionControl handles tasks */
  suppressTodoCards?: boolean
  /** Aggregated final task list — renders ONE TodoCard after MissionControl fades */
  finalTodoTasks?: Array<{ id: string; content: string; status: string }>
  /** Session ID — needed for interactive AskUserCard reply */
  sessionId?: string
  /** Worktree path — needed for interactive AskUserCard reply */
  worktreePath?: string | null
  /** Child-session parts keyed by parent tool_use id (sub-agent tool calls) */
  childPartsMap?: Map<string, StreamingPart[]>
}

export function AgentTimeline({
  timelineMessages,
  streamingContent,
  streamingParts = [],
  isStreaming,
  lifecycle: _lifecycle,
  suppressTodoCards,
  finalTodoTasks,
  sessionId,
  worktreePath,
  childPartsMap
}: AgentTimelineProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new content arrives
  const prevMessageCountRef = useRef(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const messageCount = timelineMessages.length
    const hasNewMessages = messageCount > prevMessageCountRef.current
    prevMessageCountRef.current = messageCount

    if (hasNewMessages || isStreaming) {
      // Only auto-scroll if user is near the bottom
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150
      if (isNearBottom || hasNewMessages) {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight
        })
      }
    }
  }, [timelineMessages.length, streamingContent, streamingParts.length, isStreaming])

  // Flatten messages into timeline nodes
  const nodes = useMemo(() => {
    return timelineMessages.flatMap((msg) => messageToNodes(msg))
      .filter((node) => {
        // Suppress inline TodoCards when MissionControl handles tasks
        if (suppressTodoCards && node.cardType === 'todo') return false
        return true
      })
  }, [timelineMessages, suppressTodoCards])

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

        if (toolName === 'bash' || toolName === 'execute_command') {
          cardType = 'bash'
        } else if (toolName === 'read' || toolName === 'readfile' || toolName === 'read_file') {
          cardType = 'file-read'
        } else if (
          toolName === 'write' || toolName === 'edit' ||
          toolName === 'writefile' || toolName === 'write_file' ||
          toolName === 'editfile' || toolName === 'edit_file'
        ) {
          cardType = 'file-write'
        } else if (
          toolName === 'grep' || toolName === 'glob' ||
          toolName === 'search' || toolName === 'codebase_search'
        ) {
          cardType = 'search'
        } else if (toolName === 'agent' || toolName === 'subagent' || toolName === 'dispatch_agent') {
          cardType = 'sub-agent'
        } else if (toolName === 'exitplanmode' || toolName === 'exit_plan_mode') {
          cardType = 'plan'
        } else if (toolName === 'askuserquestion' || toolName === 'ask_user') {
          cardType = 'ask-user'
        } else if (
          toolName === 'todowrite' || toolName === 'todo_write' ||
          toolName === 'taskcreate' || toolName === 'task_create' ||
          toolName === 'taskupdate' || toolName === 'task_update' ||
          toolName === 'todoread' || toolName === 'todo_read' ||
          toolName === 'tasklist' || toolName === 'task_list'
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
  }, [streamingParts, suppressTodoCards])

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto"
    >
      <div className="w-[85%] ml-[5%] py-6 pb-48">
        {/* Timeline nodes */}
        {nodes.map((node, index) => {
          const iconCfg = ICON_MAP[node.cardType]
          const Icon = iconCfg.icon
          const isLast = index === nodes.length - 1 && !isStreaming

          // Only show timestamp on: user messages, and the LAST assistant node
          // before a user message or end of timeline (not on every message).
          const nextNode = nodes[index + 1]
          const showTimestamp =
            node.cardType === 'user-message' ||
            (node.isLastInMessage && (!nextNode || nextNode.cardType === 'user-message'))

          // User messages render without the timeline line
          if (node.cardType === 'user-message') {
            return (
              <div key={node.key} className="mb-6">
                <TimelineNodeView node={node} sessionId={sessionId} worktreePath={worktreePath} childPartsMap={childPartsMap} />
                {node.message.timestamp && (
                  <div className="mt-1.5 text-xs text-muted-foreground text-right">
                    {formatMessageTime(node.message.timestamp)}
                  </div>
                )}
              </div>
            )
          }

          // Text nodes render inline without icon
          if (node.cardType === 'text') {
            return (
              <div key={node.key} className="relative pl-10 mb-4">
                {/* Vertical line */}
                {!isLast && (
                  <div className="absolute left-[15px] top-0 bottom-0 w-[2px] bg-border" />
                )}
                <TimelineNodeView node={node} sessionId={sessionId} worktreePath={worktreePath} childPartsMap={childPartsMap} />
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
              {/* Vertical line */}
              {!isLast && (
                <div className="absolute left-[15px] top-0 bottom-0 w-[2px] bg-border" />
              )}

              {/* Icon node */}
              <div
                className={cn(
                  'absolute left-[4px] top-2.5 w-[24px] h-[24px] rounded-full',
                  'flex items-center justify-center z-10',
                  iconCfg.bgClass, iconCfg.colorClass
                )}
              >
                <Icon className="h-3 w-3" />
              </div>

              {/* Card */}
              <TimelineNodeView node={node} sessionId={sessionId} worktreePath={worktreePath} childPartsMap={childPartsMap} />
              {showTimestamp && node.message.timestamp && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {formatMessageTime(node.message.timestamp)}
                </div>
              )}
            </div>
          )
        })}

        {/* Final aggregated TodoCard — appears after MissionControl fades */}
        {finalTodoTasks && finalTodoTasks.length > 0 && (
          <div className="relative pl-10 mb-4">
            <div className="absolute left-[15px] top-0 bottom-0 w-[2px] bg-border" />
            <div
              className={cn(
                'absolute left-[4px] top-2.5 w-[24px] h-[24px] rounded-full',
                'flex items-center justify-center z-10',
                ICON_MAP.todo.bgClass, ICON_MAP.todo.colorClass
              )}
            >
              <CheckSquare className="h-3 w-3" />
            </div>
            <TodoCard tasks={finalTodoTasks} />
          </div>
        )}

        {/* Live streaming parts — real-time tool/text/reasoning rendering */}
        {isStreaming && streamingNodes.length > 0 && streamingNodes.map((node, idx) => {
          const iconCfg = ICON_MAP[node.cardType]
          const Icon = iconCfg.icon
          const isLastStreamNode = idx === streamingNodes.length - 1

          if (node.cardType === 'text') {
            return (
              <div key={node.key} className="relative pl-10 mb-4">
                <div className="absolute left-[15px] top-0 bottom-0 w-[2px] bg-border" />
                <div
                  className={cn(
                    'absolute left-[4px] top-2.5 w-[24px] h-[24px] rounded-full',
                    'flex items-center justify-center z-10',
                    isLastStreamNode ? 'bg-muted text-foreground' : iconCfg.bgClass + ' ' + iconCfg.colorClass
                  )}
                >
                  {isLastStreamNode
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <Icon className="h-3 w-3" />
                  }
                </div>
                <TextCard content={node.textContent ?? ''} isStreaming={isLastStreamNode} />
              </div>
            )
          }

          return (
            <div key={node.key} className="relative pl-10 mb-4">
              <div className="absolute left-[15px] top-0 bottom-0 w-[2px] bg-border" />
              <div
                className={cn(
                  'absolute left-[4px] top-2.5 w-[24px] h-[24px] rounded-full',
                  'flex items-center justify-center z-10',
                  iconCfg.bgClass, iconCfg.colorClass
                )}
              >
                <Icon className="h-3 w-3" />
              </div>
              <TimelineNodeView node={node} sessionId={sessionId} worktreePath={worktreePath} childPartsMap={childPartsMap} />
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
                'bg-muted text-muted-foreground'
              )}
            >
              <Loader2 className="h-3 w-3 animate-spin" />
            </div>
            <div className="text-sm text-muted-foreground italic">
              Thinking…
            </div>
          </div>
        )}

        {/* Empty state */}
        {nodes.length === 0 && !isStreaming && (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <MessageSquare className="h-10 w-10 mb-3 opacity-30" />
            <div className="text-sm font-medium">No messages yet</div>
            <div className="text-xs mt-1">Send a message to start the conversation</div>
          </div>
        )}
      </div>
    </div>
  )
}
