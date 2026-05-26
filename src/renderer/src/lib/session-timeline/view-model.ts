import type { TimelineMessage, StreamingPart, ToolUseInfo } from '@shared/lib/timeline-types'
import type { MessagePart } from '@shared/types/opencode'
import { extractTaskNotifications, stripTaskNotifications } from '@/lib/content-sanitizer'
import { getMessageDisplayContent } from '@/lib/message-actions'
import {
  getTimelineCardTypeFromToolName,
  type TimelineCardType
} from '@/lib/session-timeline/card-type'

export interface TimelineNode {
  key: string
  cardType: TimelineCardType
  part?: StreamingPart
  toolUse?: ToolUseInfo
  message: TimelineMessage
  textContent?: string
  attachments?: MessagePart[]
  isLastInMessage?: boolean
}

export interface TimelineRound {
  id: string
  anchorId: string
  preview: string
  userNode: TimelineNode
  nodes: TimelineNode[]
}

export interface TimelineViewModelInput {
  timelineMessages: TimelineMessage[]
  streamingParts: StreamingPart[]
  isStreaming: boolean
  activeRunStartedAt?: number | string | null
  suppressTodoCards?: boolean
}

export interface TimelineViewModel {
  nodes: TimelineNode[]
  preludeNodes: TimelineNode[]
  rounds: TimelineRound[]
  streamingNodes: TimelineNode[]
  committedToolUseIds: Set<string>
}

function buildRoundPreview(node: TimelineNode): string {
  const displayText = getMessageDisplayContent(node.textContent ?? '')
  const compact = displayText.replace(/\s+/g, ' ').trim()
  return compact.length > 0 ? compact.slice(0, 24) : '未命名提问'
}

export function groupNodesIntoRounds(nodes: TimelineNode[]): {
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

export function messageToNodes(message: TimelineMessage): TimelineNode[] {
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

  if (message.role === 'system') return []

  const parts = message.parts ?? []

  const hasCompaction = parts.some((p) => p.type === 'compaction')
  if (hasCompaction) {
    return [
      {
        key: `${message.id}-compaction`,
        cardType: 'system',
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
      nodes.push({
        key: `${message.id}-tool-${i}`,
        cardType: getTimelineCardTypeFromToolName(part.toolUse.name),
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
  }

  flushText()

  if (nodes.length > 0) {
    nodes[nodes.length - 1].isLastInMessage = true
  }

  return nodes
}

function hasStructuredPart(message: TimelineMessage): boolean {
  if (!message.parts || message.parts.length === 0) return false
  return message.parts.some((part) => part.type !== 'text' && part.type !== 'reasoning')
}

function getCommittedToolUseIds(messages: TimelineMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type === 'tool_use' && part.toolUse?.id) {
        ids.add(part.toolUse.id)
      }
    }
  }
  return ids
}

function buildStreamingNodes({
  streamingParts,
  committedToolUseIds,
  suppressTodoCards,
  isStreaming
}: {
  streamingParts: StreamingPart[]
  committedToolUseIds: Set<string>
  suppressTodoCards?: boolean
  isStreaming: boolean
}): TimelineNode[] {
  if (streamingParts.length === 0) return []

  const placeholderMsg: TimelineMessage = {
    id: 'streaming',
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString()
  }
  const result: TimelineNode[] = []

  for (let i = 0; i < streamingParts.length; i++) {
    const part = streamingParts[i]

    if (part.type === 'tool_use' && part.toolUse?.id && committedToolUseIds.has(part.toolUse.id)) {
      continue
    }

    if (part.type === 'text' && part.text) {
      result.push({
        key: `stream-text-${i}`,
        cardType: 'text',
        message: placeholderMsg,
        textContent: part.text
      })
    } else if (part.type === 'reasoning' && part.reasoning) {
      result.push({
        key: `stream-thinking-${i}`,
        cardType: 'thinking',
        part,
        message: placeholderMsg,
        textContent: part.reasoning
      })
    } else if (part.type === 'tool_use' && part.toolUse) {
      result.push({
        key: `stream-tool-${part.toolUse.id}`,
        cardType: getTimelineCardTypeFromToolName(part.toolUse.name),
        part,
        toolUse: part.toolUse,
        message: placeholderMsg
      })
    } else if (part.type === 'subtask' && part.subtask) {
      result.push({
        key: `stream-subtask-${part.subtask.id}`,
        cardType: 'sub-agent',
        part,
        message: placeholderMsg
      })
    }
  }

  return result.filter((node) => {
    if (suppressTodoCards && node.cardType === 'todo') return false
    if (!isStreaming && (node.cardType === 'text' || node.cardType === 'thinking')) {
      return false
    }
    return true
  })
}

export function buildTimelineViewModel({
  timelineMessages,
  streamingParts,
  isStreaming,
  activeRunStartedAt,
  suppressTodoCards
}: TimelineViewModelInput): TimelineViewModel {
  const runCutoffMs =
    isStreaming && activeRunStartedAt != null
      ? typeof activeRunStartedAt === 'number'
        ? activeRunStartedAt
        : Date.parse(activeRunStartedAt)
      : null

  const filteredMessages =
    runCutoffMs != null && Number.isFinite(runCutoffMs)
      ? timelineMessages.filter((message) => {
          if (message.role !== 'assistant') return true
          if (hasStructuredPart(message)) return true
          const ts = Date.parse(message.timestamp)
          if (!Number.isFinite(ts)) return true
          return ts < runCutoffMs
        })
      : timelineMessages

  const nodes = filteredMessages
    .flatMap((message) => messageToNodes(message))
    .filter((node) => {
      if (suppressTodoCards && node.cardType === 'todo') return false
      return true
    })
  const committedToolUseIds = getCommittedToolUseIds(timelineMessages)
  const streamingNodes = buildStreamingNodes({
    streamingParts,
    committedToolUseIds,
    suppressTodoCards,
    isStreaming
  })
  const { preludeNodes, rounds } = groupNodesIntoRounds(nodes)

  return {
    nodes,
    preludeNodes,
    rounds,
    streamingNodes,
    committedToolUseIds
  }
}
