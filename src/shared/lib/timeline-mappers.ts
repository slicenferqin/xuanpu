/**
 * Timeline mappers — Phase 2
 *
 * Pure functions for transforming DB rows (session_messages + session_activities)
 * into the unified TimelineMessage[] format.
 *
 * This module runs in the **main process** (session-timeline-service) and can
 * also be imported from the renderer via the shared path alias.
 *
 * The logic is extracted from:
 *   - src/renderer/src/lib/opencode-transcript.ts
 *   - src/renderer/src/lib/codex-timeline.ts
 * Those files are retained for backward compatibility until Phase 3.
 */

import type { MessagePart } from '../types/opencode'
import type { StreamingPart, ToolUseInfo, TimelineMessage } from './timeline-types'

// Re-export for convenience
export type { StreamingPart, ToolUseInfo, TimelineMessage }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function toIsoTimestamp(value: unknown): string | undefined {
  const timestamp = toTimestampMs(value)
  return timestamp === undefined ? undefined : new Date(timestamp).toISOString()
}

function mapRole(value: unknown): 'user' | 'assistant' | 'system' {
  if (value === 'user' || value === 'assistant' || value === 'system') return value
  return 'assistant'
}

function mapToolStatus(value: unknown): 'pending' | 'running' | 'success' | 'error' {
  switch (value) {
    case 'pending':
      return 'pending'
    case 'running':
      return 'running'
    case 'completed':
    case 'success':
      return 'success'
    case 'error':
      return 'error'
    default:
      return 'running'
  }
}

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

/** Check if a user message is a synthetic injection that should not appear in the timeline. */
function isSyntheticUserMessage(content: string): boolean {
  // Strip leading whitespace and any XML-like tags (e.g. <system-reminder>)
  // that Claude Code may prepend to synthetic messages.
  const trimmed = content.trimStart().replace(/^(?:<[^>]+>\s*)+/, '')
  return (
    trimmed.startsWith('This session is being continued from a previous conversation') ||
    trimmed.startsWith('Here is a summary of the conversation so far') ||
    trimmed.startsWith('Base directory for this skill:') ||
    trimmed.startsWith('<local-command-stdout>') ||
    trimmed.startsWith('<system-reminder>')
  )
}

// ---------------------------------------------------------------------------
// Part mappers (from opencode-transcript.ts)
// ---------------------------------------------------------------------------

export function extractTextContentFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  return parts
    .map((part) => {
      const record = asRecord(part)
      if (!record || record.type !== 'text') return ''
      return asString(record.text) ?? ''
    })
    .join('')
}

export function mapPartToStreamingPart(part: unknown, index = 0): StreamingPart | null {
  const record = asRecord(part)
  if (!record) return null

  const type = asString(record.type)
  if (!type) return null

  if (type === 'text') {
    const text = asString(record.text)
    return text ? { type: 'text', text } : null
  }

  if (type === 'tool_use') {
    const toolUse = asRecord(record.toolUse)
    if (!toolUse) return null
    return {
      type: 'tool_use',
      toolUse: {
        id: asString(toolUse.id) ?? `tool-${index}`,
        name: asString(toolUse.name) ?? 'Unknown',
        input: asRecord(toolUse.input) ?? {},
        status: mapToolStatus(toolUse.status),
        startTime: toTimestampMs(toolUse.startTime) ?? Date.now(),
        endTime: toTimestampMs(toolUse.endTime),
        output: stringifyValue(toolUse.output),
        error: asString(toolUse.error)
      }
    }
  }

  if (type === 'tool') {
    const state = asRecord(record.state) ?? {}
    const stateTime = asRecord(state.time) ?? {}
    return {
      type: 'tool_use',
      toolUse: {
        id: asString(record.callID) ?? asString(record.id) ?? `tool-${index}`,
        name: asString(record.tool) ?? asString(record.name) ?? 'Unknown',
        input: asRecord(state.input) ?? {},
        status: mapToolStatus(state.status),
        startTime: toTimestampMs(stateTime.start) ?? Date.now(),
        endTime: toTimestampMs(stateTime.end),
        output: stringifyValue(state.output),
        error: stringifyValue(state.error)
      }
    }
  }

  if (type === 'subtask') {
    const rawParts = Array.isArray(record.parts) ? record.parts : []
    const parts = rawParts
      .map((rawPart, partIndex) => mapPartToStreamingPart(rawPart, partIndex))
      .filter((mappedPart): mappedPart is StreamingPart => mappedPart !== null)
    return {
      type: 'subtask',
      subtask: {
        id: asString(record.id) ?? `subtask-${index}`,
        sessionID: asString(record.sessionID) ?? '',
        prompt: asString(record.prompt) ?? '',
        description: asString(record.description) ?? '',
        agent: asString(record.agent) ?? 'unknown',
        parts,
        status:
          record.status === 'completed' || record.status === 'error'
            ? (record.status as 'completed' | 'error')
            : 'running'
      }
    }
  }

  if (type === 'step-start' || type === 'step_start') {
    return { type: 'step_start', stepStart: { snapshot: asString(record.snapshot) } }
  }

  if (type === 'step-finish' || type === 'step_finish') {
    const tokens = asRecord(record.tokens)
    return {
      type: 'step_finish',
      stepFinish: {
        reason: asString(record.reason) ?? '',
        cost: toNumber(record.cost) ?? 0,
        tokens: {
          input: toNumber(tokens?.input) ?? 0,
          output: toNumber(tokens?.output) ?? 0,
          reasoning: toNumber(tokens?.reasoning) ?? 0
        }
      }
    }
  }

  if (type === 'reasoning') {
    return { type: 'reasoning', reasoning: asString(record.text) ?? '' }
  }

  if (type === 'compaction') {
    return { type: 'compaction', compactionAuto: record.auto === true }
  }

  return null
}

// ---------------------------------------------------------------------------
// OpenCode / Claude Code transcript mapper
// (from opencode-transcript.ts: mapOpencodeMessagesToSessionViewMessages)
// ---------------------------------------------------------------------------

interface MappedMessage {
  message: TimelineMessage
  sortTime?: number
  originalIndex: number
}

function mapRawMessage(rawMessage: unknown, index: number): MappedMessage {
  const messageRecord = asRecord(rawMessage)
  const info = asRecord(messageRecord?.info)

  const id = asString(info?.id) ?? asString(messageRecord?.id) ?? `message-${index}`
  const role = mapRole(info?.role ?? messageRecord?.role)

  const rawParts = Array.isArray(messageRecord?.parts) ? messageRecord.parts : []
  const mappedParts = rawParts
    .map((part, partIndex) => mapPartToStreamingPart(part, partIndex))
    .filter((part): part is StreamingPart => part !== null)

  const fileAttachments: MessagePart[] = rawParts
    .filter((p) => {
      const r = asRecord(p)
      return r && asString(r.type) === 'file'
    })
    .map((p) => {
      const r = asRecord(p)!
      return {
        type: 'file' as const,
        mime: asString(r.mime) ?? '',
        url: asString(r.url) ?? '',
        filename: asString(r.filename)
      }
    })
    .filter((f) => f.url)

  const content =
    extractTextContentFromParts(rawParts) ||
    asString(info?.content) ||
    asString(messageRecord?.content) ||
    ''

  const sortTime =
    toTimestampMs(info?.time && asRecord(info.time)?.created) ??
    toTimestampMs(info?.createdAt) ??
    toTimestampMs(info?.created_at) ??
    toTimestampMs(messageRecord?.timestamp)

  const timestamp =
    toIsoTimestamp(info?.time && asRecord(info.time)?.created) ??
    toIsoTimestamp(info?.createdAt) ??
    toIsoTimestamp(info?.created_at) ??
    toIsoTimestamp(messageRecord?.timestamp) ??
    new Date(0).toISOString()

  return {
    message: {
      id,
      role,
      content,
      timestamp,
      ...(messageRecord?.steered === true || info?.steered === true ? { steered: true } : {}),
      parts: mappedParts.length > 0 ? mappedParts : undefined,
      ...(role === 'user' && fileAttachments.length > 0
        ? { attachments: fileAttachments }
        : {})
    },
    sortTime,
    originalIndex: index
  }
}

/**
 * Map raw OpenCode/Claude Code messages to unified timeline messages.
 * Sorts by creation time, deduplicates user messages, and filters compaction summaries.
 */
export function mapRawTranscriptToTimeline(messages: unknown[]): TimelineMessage[] {
  if (!Array.isArray(messages)) return []

  const sorted = messages
    .map((message, index) => mapRawMessage(message, index))
    .sort((a, b) => {
      if (a.sortTime !== undefined && b.sortTime !== undefined && a.sortTime !== b.sortTime) {
        return a.sortTime - b.sortTime
      }
      if (a.sortTime !== undefined && b.sortTime === undefined) return -1
      if (a.sortTime === undefined && b.sortTime !== undefined) return 1
      return a.originalIndex - b.originalIndex
    })
    .map((item) => item.message)

  const seen = new Set<string>()
  return sorted.filter((msg) => {
    if (msg.role !== 'user') return true
    if (isSyntheticUserMessage(msg.content)) return false
    const key = msg.content.trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---------------------------------------------------------------------------
// DB row → TimelineMessage mapper
// (from codex-timeline.ts: mapDbSessionMessagesToOpenCodeMessages)
// ---------------------------------------------------------------------------

export interface DbSessionMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  opencode_message_id: string | null
  opencode_message_json: string | null
  opencode_parts_json: string | null
  opencode_timeline_json: string | null
  created_at: string
}

export interface DbSessionActivity {
  id: string
  session_id: string
  agent_session_id: string | null
  thread_id: string | null
  turn_id: string | null
  item_id: string | null
  request_id: string | null
  kind: string
  tone: string
  summary: string
  payload_json: string | null
  sequence: number | null
  created_at: string
}

export function mapDbRowsToTimelineMessages(messages: DbSessionMessage[]): TimelineMessage[] {
  return messages
    .filter((m) => !(m.role === 'user' && isSyntheticUserMessage(m.content)))
    .map((message) => {
    const parsedMessage = parseJson<Record<string, unknown>>(message.opencode_message_json)
    const parsedParts = parseJson<unknown[]>(message.opencode_parts_json)
    const parts = Array.isArray(parsedParts)
      ? parsedParts
          .map((part, index) => mapPartToStreamingPart(part, index))
          .filter((part): part is StreamingPart => part !== null)
      : undefined

    return {
      id: message.opencode_message_id ?? message.id,
      role: message.role,
      content: message.content,
      timestamp: message.created_at,
      ...(parsedMessage?.steered === true ? { steered: true } : {}),
      parts: parts && parts.length > 0 ? parts : undefined
    }
  })
}

// ---------------------------------------------------------------------------
// Codex timeline assembly helpers
// (from codex-timeline.ts)
// ---------------------------------------------------------------------------

function extractAssistantTurnId(messageId: string): string | null {
  const match = messageId.match(/^(.*):assistant(?::.*)?$/)
  return match?.[1] ?? null
}

function extractUserTurnId(messageId: string): string | null {
  const match = messageId.match(/^(.*):user(?::.*)?$/)
  return match?.[1] ?? null
}

function extractRoleOrdinal(messageId: string, role: 'user' | 'assistant'): number {
  const match = messageId.match(new RegExp(`^[^]*:${role}(?::(.+))?$`))
  if (!match) return 0
  if (!match[1]) return 1
  const numericSuffix = Number.parseInt(match[1], 10)
  return Number.isFinite(numericSuffix) ? Math.max(1, numericSuffix) : 2
}

function getOrderedActivityTurnIds(activityRows: DbSessionActivity[]): string[] {
  return [
    ...new Set(
      [...activityRows]
        .sort((left, right) => {
          const leftTime = Date.parse(left.created_at)
          const rightTime = Date.parse(right.created_at)
          if (leftTime !== rightTime) return leftTime - rightTime
          return left.id.localeCompare(right.id)
        })
        .map((activity) => activity.turn_id)
        .filter((turnId): turnId is string => typeof turnId === 'string' && turnId.length > 0)
    )
  ]
}

function normalizeCodexMessageRows(
  messages: DbSessionMessage[],
  activityRows: DbSessionActivity[]
): DbSessionMessage[] {
  const orderedMessages = [...messages].sort((left, right) => {
    const leftTime = Date.parse(left.created_at)
    const rightTime = Date.parse(right.created_at)
    if (leftTime !== rightTime) return leftTime - rightTime
    return left.id.localeCompare(right.id)
  })

  const orderedTurnIds = getOrderedActivityTurnIds(activityRows)
  if (orderedTurnIds.length === 0) return orderedMessages

  const turnIndexById = new Map(orderedTurnIds.map((turnId, index) => [turnId, index]))
  let currentTurnIndex = -1
  let currentTurnId: string | null = null
  let assistantCountWithinTurn = 0
  let userCountWithinTurn = 0

  return orderedMessages.map((message) => {
    const messageId = message.opencode_message_id
    const canonicalTurnId =
      typeof messageId === 'string'
        ? message.role === 'assistant'
          ? extractAssistantTurnId(messageId)
          : message.role === 'user'
            ? extractUserTurnId(messageId)
            : null
        : null

    if (canonicalTurnId) {
      currentTurnId = canonicalTurnId
      currentTurnIndex = turnIndexById.get(canonicalTurnId) ?? currentTurnIndex
      if (message.role === 'user') {
        userCountWithinTurn = extractRoleOrdinal(messageId!, 'user')
        assistantCountWithinTurn = 0
      } else if (message.role === 'assistant') {
        assistantCountWithinTurn = extractRoleOrdinal(messageId!, 'assistant')
      }
      return message
    }

    if (message.role === 'user') {
      if (!currentTurnId || userCountWithinTurn > 0) {
        currentTurnIndex += 1
        currentTurnId = orderedTurnIds[currentTurnIndex] ?? currentTurnId
        userCountWithinTurn = 0
      }
      if (!currentTurnId) return message
      assistantCountWithinTurn = 0
      userCountWithinTurn += 1
      return {
        ...message,
        opencode_message_id:
          userCountWithinTurn === 1
            ? `${currentTurnId}:user`
            : `${currentTurnId}:user:${userCountWithinTurn}`
      }
    }

    if (message.role === 'assistant') {
      const turnId = currentTurnId ?? orderedTurnIds[Math.max(currentTurnIndex, 0)]
      if (!turnId) return message
      const mid =
        assistantCountWithinTurn === 0
          ? `${turnId}:assistant`
          : `${turnId}:assistant:${assistantCountWithinTurn + 1}`
      assistantCountWithinTurn += 1
      return { ...message, opencode_message_id: mid }
    }

    return message
  })
}

function parseToolPartFromActivity(activity: DbSessionActivity): StreamingPart | null {
  const payload = parseJson<Record<string, unknown>>(activity.payload_json)
  const item =
    payload && typeof payload.item === 'object'
      ? (payload.item as Record<string, unknown>)
      : null
  const toolName =
    (typeof item?.toolName === 'string' && item.toolName) ||
    (typeof item?.name === 'string' && item.name) ||
    (typeof item?.type === 'string' && item.type) ||
    'unknown'
  const rawInput =
    item?.input && typeof item.input === 'object' && !Array.isArray(item.input)
      ? (item.input as Record<string, unknown>)
      : {}
  const input = Array.isArray(item?.changes) ? { ...rawInput, changes: item.changes } : rawInput
  const output =
    item?.output ?? payload?.output ?? item?.aggregatedOutput ?? payload?.aggregatedOutput

  return {
    type: 'tool_use',
    toolUse: {
      id: activity.item_id ?? activity.id,
      name: toolName,
      input,
      status:
        activity.kind === 'tool.completed'
          ? 'success'
          : activity.kind === 'tool.failed'
            ? 'error'
            : 'running',
      startTime: Date.parse(activity.created_at) || Date.now(),
      endTime:
        activity.kind === 'tool.completed' || activity.kind === 'tool.failed'
          ? Date.parse(activity.created_at) || Date.now()
          : undefined,
      output: activity.kind === 'tool.completed' ? stringifyValue(output) : undefined,
      error:
        activity.kind === 'tool.failed' ? (stringifyValue(output) ?? activity.summary) : undefined
    }
  }
}

function parsePlanPartFromActivity(activity: DbSessionActivity): StreamingPart | null {
  const payload = parseJson<Record<string, unknown>>(activity.payload_json)
  if (activity.kind === 'plan.ready') {
    const plan =
      (typeof payload?.plan === 'string' && payload.plan.trim()) ||
      (typeof payload?.planContent === 'string' && payload.planContent.trim()) ||
      ''
    if (!plan) return null

    const toolUseId =
      (typeof payload?.toolUseID === 'string' && payload.toolUseID) ||
      activity.item_id ||
      activity.request_id ||
      activity.id

    return {
      type: 'tool_use',
      toolUse: {
        id: toolUseId,
        name: 'ExitPlanMode',
        input: { plan },
        status: 'pending',
        startTime: Date.parse(activity.created_at) || Date.now()
      }
    }
  }

  if (
    activity.kind === 'session.info' &&
    payload?.kind === 'update_plan' &&
    Array.isArray(payload.todos)
  ) {
    const toolUseId =
      (typeof payload.callID === 'string' && payload.callID) ||
      activity.item_id ||
      activity.request_id ||
      activity.id

    return {
      type: 'tool_use',
      toolUse: {
        id: toolUseId,
        name: 'update_plan',
        input: { todos: payload.todos },
        status: 'success',
        startTime: Date.parse(activity.created_at) || Date.now(),
        endTime: Date.parse(activity.created_at) || Date.now()
      }
    }
  }

  return null
}

function upsertToolPart(
  parts: StreamingPart[] | undefined,
  nextPart: StreamingPart
): StreamingPart[] {
  const existingParts = parts ? [...parts] : []
  const nextToolId = nextPart.toolUse?.id
  const partIndex = existingParts.findIndex(
    (part) => part.type === 'tool_use' && part.toolUse?.id === nextToolId
  )
  if (partIndex >= 0) {
    existingParts[partIndex] = nextPart
  } else {
    existingParts.push(nextPart)
  }
  return existingParts
}

function normalizeCodexOpenCodeMessages(
  messages: TimelineMessage[],
  activityRows: DbSessionActivity[]
): TimelineMessage[] {
  const orderedTurnIds = getOrderedActivityTurnIds(activityRows)
  if (orderedTurnIds.length === 0) return messages

  const turnIndexById = new Map(orderedTurnIds.map((turnId, index) => [turnId, index]))
  let currentTurnIndex = -1
  let currentTurnId: string | null = null
  let assistantCountWithinTurn = 0
  let userCountWithinTurn = 0

  return messages.map((message) => {
    const canonicalTurnId =
      message.role === 'assistant'
        ? extractAssistantTurnId(message.id)
        : message.role === 'user'
          ? extractUserTurnId(message.id)
          : null

    if (canonicalTurnId) {
      currentTurnId = canonicalTurnId
      currentTurnIndex = turnIndexById.get(canonicalTurnId) ?? currentTurnIndex
      if (message.role === 'user') {
        userCountWithinTurn = extractRoleOrdinal(message.id, 'user')
        assistantCountWithinTurn = 0
      } else if (message.role === 'assistant') {
        assistantCountWithinTurn = extractRoleOrdinal(message.id, 'assistant')
      }
      return message
    }

    if (message.role === 'user') {
      if (!currentTurnId || userCountWithinTurn > 0) {
        currentTurnIndex += 1
        currentTurnId = orderedTurnIds[currentTurnIndex] ?? currentTurnId
        userCountWithinTurn = 0
      }
      if (!currentTurnId) return message
      assistantCountWithinTurn = 0
      userCountWithinTurn += 1
      return {
        ...message,
        id:
          userCountWithinTurn === 1
            ? `${currentTurnId}:user`
            : `${currentTurnId}:user:${userCountWithinTurn}`
      }
    }

    if (message.role === 'assistant') {
      const turnId = currentTurnId ?? orderedTurnIds[Math.max(currentTurnIndex, 0)]
      if (!turnId) return message
      const mid =
        assistantCountWithinTurn === 0
          ? `${turnId}:assistant`
          : `${turnId}:assistant:${assistantCountWithinTurn + 1}`
      assistantCountWithinTurn += 1
      return { ...message, id: mid }
    }

    return message
  })
}

function mergeCodexActivityMessages(
  baseMessages: TimelineMessage[],
  activityRows: DbSessionActivity[]
): TimelineMessage[] {
  const normalizedBaseMessages = normalizeCodexOpenCodeMessages(baseMessages, activityRows)
  const mergedMessages = normalizedBaseMessages.map((message) => ({
    ...message,
    parts: message.parts ? [...message.parts] : undefined
  }))
  const knownToolIds = new Set(
    mergedMessages.flatMap((message) =>
      (message.parts ?? [])
        .filter((part) => part.type === 'tool_use' && !!part.toolUse?.id)
        .map((part) => part.toolUse!.id)
    )
  )
  const firstAssistantIndexByTurnId = new Map<string, number>()
  const turnOrder: string[] = []

  mergedMessages.forEach((message, index) => {
    const turnId =
      message.role === 'assistant'
        ? extractAssistantTurnId(message.id)
        : (message.id.match(/^(.*):user(?::.*)?$/)?.[1] ?? null)
    if (!turnId) return
    if (!turnOrder.includes(turnId)) turnOrder.push(turnId)
    if (message.role === 'assistant' && !firstAssistantIndexByTurnId.has(turnId)) {
      firstAssistantIndexByTurnId.set(turnId, index)
    }
  })

  const anchoredSyntheticByTurnId = new Map<
    string,
    Array<TimelineMessage & { syntheticOrder: number }>
  >()
  const unanchoredSynthetic: Array<TimelineMessage & { syntheticOrder: number }> = []

  const sortedActivities = [...activityRows].sort((left, right) => {
    const leftTime = Date.parse(left.created_at)
    const rightTime = Date.parse(right.created_at)
    if (leftTime !== rightTime) return leftTime - rightTime
    return left.id.localeCompare(right.id)
  })

  for (const activity of sortedActivities) {
    const activityPart = activity.kind.startsWith('tool.')
      ? parseToolPartFromActivity(activity)
      : parsePlanPartFromActivity(activity)
    if (!activityPart?.toolUse) continue

    const toolId = activityPart.toolUse.id
    if (knownToolIds.has(toolId)) continue

    const turnId = activity.turn_id
    const syntheticId = turnId ? `${turnId}:tool:${toolId}` : `tool:${toolId}`
    const targetCollection = turnId
      ? (anchoredSyntheticByTurnId.get(turnId) ?? [])
      : unanchoredSynthetic
    let target = targetCollection.find((message) => message.id === syntheticId)
    if (!target) {
      target = {
        id: syntheticId,
        role: 'assistant',
        content: '',
        timestamp: activity.created_at,
        parts: [],
        syntheticOrder: targetCollection.length
      }
      targetCollection.push(target)
      if (turnId) anchoredSyntheticByTurnId.set(turnId, targetCollection)
    }
    target.parts = upsertToolPart(target.parts, activityPart)
  }

  const injectedTurns = new Set<string>()
  const orderedMessages: TimelineMessage[] = []

  mergedMessages.forEach((message, index) => {
    const turnId =
      message.role === 'assistant'
        ? extractAssistantTurnId(message.id)
        : (message.id.match(/^(.*):user(?::.*)?$/)?.[1] ?? null)
    if (
      turnId &&
      message.role === 'assistant' &&
      firstAssistantIndexByTurnId.get(turnId) === index &&
      !injectedTurns.has(turnId)
    ) {
      orderedMessages.push(...(anchoredSyntheticByTurnId.get(turnId) ?? []))
      injectedTurns.add(turnId)
    }
    orderedMessages.push(message)
  })

  for (const turnId of turnOrder) {
    if (injectedTurns.has(turnId)) continue
    const syntheticMessages = anchoredSyntheticByTurnId.get(turnId)
    if (syntheticMessages && syntheticMessages.length > 0) {
      orderedMessages.push(...syntheticMessages)
    }
  }

  if (unanchoredSynthetic.length > 0) {
    orderedMessages.push(...unanchoredSynthetic)
  }

  return orderedMessages
}

/**
 * Derive a unified timeline from Codex session data.
 * Combines session_messages with session_activities to produce tool-enriched timeline.
 */
export function deriveCodexTimeline(
  messageRows: DbSessionMessage[],
  activityRows: DbSessionActivity[]
): TimelineMessage[] {
  const normalizedMessages = normalizeCodexMessageRows(messageRows, activityRows)
  return mergeCodexActivityMessages(
    mapDbRowsToTimelineMessages(normalizedMessages),
    activityRows
  )
}
