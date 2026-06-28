import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type {
  AgentSdkCapabilities,
  AgentSdkImplementer,
  PromptOptions
} from './agent-runtime-types'
import type { AgentRuntimeAdapter } from './agent-runtime-types'
import { CODEX_CAPABILITIES } from './agent-runtime-types'
import {
  getAvailableCodexModels,
  getCodexModelInfo,
  CODEX_DEFAULT_MODEL,
  resolveCodexModelSlug
} from './codex-models'
import { createLogger } from './logger'
import { CodexAppServerManager, type CodexManagerEvent } from './codex-app-server-manager'
import { mapCodexManagerEventToActivity } from './codex-activity-mapper'
import {
  mapCodexEventToStreamEvents,
  contentStreamKindFromMethod,
  createCodexMapperState,
  type CodexMapperState
} from './codex-event-mapper'
import { ensureCodexAppServerLaunchSpec } from './codex-binary-resolver'
import { asNumber, asObject, asString, toDebugSnapshot } from './codex-utils'
import { generateCodexSessionTitle } from './codex-session-title'
import { getCodexConfiguredContextWindow, getCodexConfiguredModel } from './codex-config'
import type { DatabaseService } from '../db/database'
import type { SessionActivityCreate, SessionMessageCreate } from '../db'
import { autoRenameWorktreeBranch } from './git-service'
import { beginSessionRun, emitAgentEvent } from '@shared/lib/normalize-agent-event'
import { stripFieldContextEnvelope } from '@shared/lib/field-context-envelope'
import { calculateUsageCost, resolvePricingModelKey } from '@shared/usage/pricing'
import { notificationService } from './notification-service'
import { buildXfpFallbackContext } from '../xfp/fallback-context'
import { xfpProvider } from '../xfp/provider'
import { recordXfpAuditEvent, recordXfpPromptObservation } from '../xfp/audit'
import type { AgentCommand, AgentStatusPayload, RawAgentEvent } from '@shared/types/agent-protocol'

const log = createLogger({ component: 'CodexImplementer' })

// ── Session state ─────────────────────────────────────────────────

export interface CodexSessionState {
  threadId: string
  hiveSessionId: string
  worktreePath: string
  status: 'connecting' | 'ready' | 'running' | 'error' | 'closed'
  messages: unknown[]
  liveAssistantDraft?: CodexLiveAssistantDraft | null
  activeRun?: CodexActiveRun | null
  settledRunIds?: Set<string>
  revertMessageID: string | null
  revertDiff: string | null
  titleGenerated: boolean
  titleGenerationStarted: boolean
  tokenUsageCostByEvent?: Map<string, number>
  /**
   * Per-session mapper state. Codex commandExecution streams stdout via
   * outputDelta chunks; the mapper aggregates them into state.output here so
   * the renderer's last-write-wins merge produces the full output, not just
   * the latest delta.
   */
  mapperState: CodexMapperState
  /**
   * Per-turn array of wall-clock timestamps captured from `item/started`
   * events as they stream in. Position-indexed: the N-th `item/started`
   * we see for a turn lands at index N. parseThreadSnapshot uses the SAME
   * positional index to assign timestamps because codex's thread/read
   * response renumbers item ids (`item-1`, `item-2`, …), so an id-keyed
   * lookup would miss every time. Position is the only reliable bridge
   * between streaming and the snapshot.
   */
  itemTimestampsByTurn: Map<string, string[]>
  recordedItemIdsByTurn?: Map<string, Set<string>>
}

interface CodexActiveRun {
  runId: string
  expectedTurnId: string | null
  state: 'starting' | 'running' | 'aborting' | 'finalizing' | 'settled'
  startedAt: number
  abortController: AbortController
  interruptRequestedTurnId?: string | null
}

interface CodexLiveToolPart {
  type: 'tool'
  callID: string
  tool: string
  state: {
    status: 'running' | 'completed' | 'error' | 'cancelled'
    input?: unknown
    output?: unknown
    error?: unknown
    metadata?: Record<string, unknown>
    time?: { start?: number; end?: number }
  }
}

type CodexLiveDraftPart =
  | { type: 'text'; text: string; timestamp: string }
  | { type: 'reasoning'; text: string; timestamp: string }
  | CodexLiveToolPart

type CodexPromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; url: string; filename?: string }

type CodexPromptMessage = string | CodexPromptPart[]

interface CodexPreparedPrompt {
  runtimeText: string
  displayText: string
  displayParts: CodexPromptPart[]
}

interface CodexSkillInputPart extends Record<string, unknown> {
  type: 'skill'
  name: string
  path: string
}

interface CodexSkillCommand extends AgentCommand {
  source: 'skill'
  path: string
  scope?: 'user' | 'repo' | 'system' | 'admin'
  enabled: true
}

interface CodexLiveAssistantDraft {
  id: string
  timestamp: string
  parts: CodexLiveDraftPart[]
  toolIndexById: Map<string, number>
}

interface CodexJsonlTextTimestamp {
  text: string
  timestamp: string
}

interface CodexJsonlTurnTimeline {
  /**
   * Fallback sequence from the JSONL response stream. This is only safe when
   * its length matches the `thread/read` item count; otherwise the server may
   * have returned a summarized item list and text must be matched by content.
   */
  positional: string[]
  userMessages: CodexJsonlTextTimestamp[]
  assistantMessages: CodexJsonlTextTimestamp[]
  reasoningMessages: CodexJsonlTextTimestamp[]
  toolCallTimestampsById: Map<string, string>
}

interface CodexJsonlSupplementalMessage {
  message: unknown
  timestamp: string
  normalizedText: string
  role: 'user' | 'assistant'
}

interface CodexJsonlToolCall {
  callId: string
  name: string
  input: unknown
  turnId: string | null
  startedAt: string
  completedAt: string | null
  output: unknown
  failed: boolean
}

// ── Pending HITL entry (shared by questions and approvals) ────────

interface PendingHitlEntry {
  threadId: string
  hiveSessionId: string
  worktreePath: string
  turnId?: string
  /** Snapshot of the questions[] payload so we can persist it on resolution. */
  questions?: unknown[]
}

interface CodexPermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
}

/**
 * Extracts the markdown content from a `<proposed_plan>` XML block.
 * Returns the inner content trimmed, or null if no block is found.
 */
function extractProposedPlanMarkdown(text: string): string | null {
  const match = text.match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i)
  return match ? (match[1]?.trim() ?? null) : null
}

function buildCodexGoalObjective(promptText: string, successCriteria?: string): string {
  const objective = promptText.trim()
  const criteria = successCriteria?.trim() ?? ''

  if (!objective) {
    return criteria ? `Success criteria:\n${criteria}` : ''
  }

  if (!criteria) {
    return objective
  }

  return `${objective}\n\nSuccess criteria:\n${criteria}`
}

function isCodexGoalUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const lowered = message.toLowerCase()

  if (lowered.includes('goals feature is disabled')) return true
  if (!lowered.includes('thread/goal/set') && !lowered.includes('setthreadgoal')) return false

  return (
    lowered.includes('method not found') ||
    lowered.includes('unknown method') ||
    lowered.includes('no such method') ||
    lowered.includes('not supported') ||
    lowered.includes('unsupported') ||
    lowered.includes('feature is disabled')
  )
}

function appendCodexGoalFallbackPrompt(promptText: string, goalObjective: string): string {
  const prompt = promptText.trimEnd()
  const objective = goalObjective.trim()

  if (!objective) return prompt

  if (objective === promptText.trim()) {
    return `${prompt}\n\n[Xuanpu Goal]\nTreat the user message above as the objective and completion contract for this turn.`
  }

  return `${prompt}\n\n[Xuanpu Goal]\nTreat this goal and any success criteria as the completion contract for this turn:\n${objective}`
}

function extractCodexTextFromMessage(message: CodexPromptMessage): string {
  if (typeof message === 'string') return message

  return message
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function stripCodexPromptPart(part: CodexPromptPart): CodexPromptPart {
  if (part.type !== 'text') return part
  return { ...part, text: stripFieldContextEnvelope(part.text) }
}

function normalizeCodexTimelineText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

function normalizeCodexJsonlTimestamp(timestamp: string | undefined): string | null {
  if (!timestamp) return null
  const parsed = Date.parse(timestamp)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString()
}

function stripCodexMemoryCitation(text: string): string {
  return text.replace(/\n*<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>\s*$/i, '').trim()
}

function extractCodexJsonlPath(snapshot: unknown): string | null {
  const obj = asObject(snapshot)
  const threadObj = asObject(obj?.thread) ?? obj
  return asString(threadObj?.path) ?? null
}

function extractCodexJsonlContentText(content: unknown): string {
  if (!Array.isArray(content)) return ''

  return content
    .map((entry) => asObject(entry))
    .map((entry) => asString(entry?.text) ?? '')
    .filter(Boolean)
    .join('\n')
    .trim()
}

function parseCodexJsonlArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function parseCodexJsonlOutputExitCode(output: unknown): number | undefined {
  if (typeof output !== 'string') return undefined
  const match = output.match(/^Exit code:\s*(-?\d+)/m)
  if (!match?.[1]) return undefined
  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseCodexJsonlOutputDurationMs(output: unknown): number | undefined {
  if (typeof output !== 'string') return undefined
  const match = output.match(/^Wall time:\s*([0-9.]+)\s*seconds?/m)
  if (!match?.[1]) return undefined
  const parsed = Number.parseFloat(match[1])
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) : undefined
}

function inferCodexJsonlOutputFailed(output: unknown): boolean {
  const exitCode = parseCodexJsonlOutputExitCode(output)
  return exitCode !== undefined && exitCode !== 0
}

function extractCodexJsonlToolName(name: string): string {
  const parts = name.split('.').filter(Boolean)
  return parts[parts.length - 1] ?? name
}

function extractPatchChangesFromCodexJsonlInput(input: unknown): unknown[] {
  const patch = typeof input === 'string' ? input : asString(asObject(input)?.patch)
  if (!patch) return []

  const changes: Array<Record<string, unknown>> = []
  let current: { path: string; operation: string; lines: string[] } | null = null

  const flush = (): void => {
    if (!current) return
    changes.push({
      path: current.path,
      kind: { type: current.operation },
      diff: current.lines.join('\n').trim()
    })
    current = null
  }

  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/)
    if (match?.[1] && match[2]) {
      flush()
      current = {
        path: match[2].trim(),
        operation: match[1].toLowerCase(),
        lines: []
      }
      continue
    }

    if (current) {
      current.lines.push(line)
    }
  }

  flush()
  return changes
}

function buildCodexJsonlToolItem(call: CodexJsonlToolCall): Record<string, unknown> {
  const toolName = extractCodexJsonlToolName(call.name)
  const inputRecord = asObject(call.input)
  const output = call.output
  const exitCode = parseCodexJsonlOutputExitCode(output)
  const durationMs = parseCodexJsonlOutputDurationMs(output)
  const status = call.failed || inferCodexJsonlOutputFailed(output) ? 'failed' : 'completed'

  if (
    toolName === 'shell_command' ||
    toolName === 'bash' ||
    toolName === 'exec_command' ||
    toolName === 'run_command'
  ) {
    const command = asString(inputRecord?.command) ?? asString(inputRecord?.script) ?? ''
    const cwd = asString(inputRecord?.workdir) ?? asString(inputRecord?.cwd)
    return {
      type: 'commandExecution',
      id: call.callId,
      command,
      ...(cwd ? { cwd } : {}),
      commandActions: [],
      status,
      ...(typeof output === 'string' ? { aggregatedOutput: output } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(durationMs !== undefined ? { durationMs } : {})
    }
  }

  if (toolName === 'apply_patch' || toolName === 'patch_apply') {
    const changes = extractPatchChangesFromCodexJsonlInput(call.input)
    return {
      type: 'fileChange',
      id: call.callId,
      status,
      changes,
      ...(typeof call.input === 'string' ? { patch: call.input } : { input: call.input }),
      ...(typeof output === 'string' ? { output } : {})
    }
  }

  if (toolName === 'web_search' || toolName === 'web_search_call' || toolName === 'search') {
    const query =
      asString(inputRecord?.query) ??
      (Array.isArray(inputRecord?.queries) ? asString(inputRecord.queries[0]) : undefined)
    return {
      type: 'webSearch',
      id: call.callId,
      status,
      ...(query ? { query } : {}),
      action: {
        type: 'search',
        ...(query ? { query } : {}),
        ...(Array.isArray(inputRecord?.queries) ? { queries: inputRecord.queries } : {})
      }
    }
  }

  return {
    type: 'mcpToolCall',
    id: call.callId,
    server: 'codex-jsonl',
    tool: call.name,
    status,
    arguments: call.input,
    ...(output !== undefined ? { result: output } : {})
  }
}

function extractCodexJsonlReasoningText(payload: Record<string, unknown>): string {
  const extract = (value: unknown): string[] => {
    if (!Array.isArray(value)) return []
    return value.flatMap((entry) => {
      if (typeof entry === 'string') return entry
      const entryObj = asObject(entry)
      const text = asString(entryObj?.text)
      return text ? [text] : []
    })
  }

  return [...extract(payload.summary), ...extract(payload.content)].join('\n').trim()
}

function shiftMatchingCodexJsonlTextTimestamp(
  entries: CodexJsonlTextTimestamp[],
  text: string
): string | null {
  const target = normalizeCodexTimelineText(stripCodexMemoryCitation(text))
  if (!target) return null

  const index = entries.findIndex((entry) => {
    const candidate = normalizeCodexTimelineText(stripCodexMemoryCitation(entry.text))
    if (!candidate) return false
    if (candidate === target) return true

    // `thread/read` may return assistant text with the trailing memory-citation
    // block already stripped while JSONL keeps the raw final response. Treat
    // containment as a match only for substantial text so short status updates
    // do not accidentally steal a later timestamp.
    if (candidate.length < 80 || target.length < 80) return false
    return candidate.startsWith(target) || target.startsWith(candidate)
  })
  if (index < 0) return null

  const [entry] = entries.splice(index, 1)
  return entry?.timestamp ?? null
}

function normalizeCodexDisplayMessage(message: CodexPromptMessage): {
  text: string
  parts: CodexPromptPart[]
} {
  if (typeof message === 'string') {
    const text = stripFieldContextEnvelope(message)
    return { text, parts: [{ type: 'text', text }] }
  }

  const parts = message.map((part) => stripCodexPromptPart(part))
  return { text: extractCodexTextFromMessage(parts), parts }
}

function prepareCodexPrompt(
  message: CodexPromptMessage,
  promptOptions?: PromptOptions
): CodexPreparedPrompt {
  const runtimeText = extractCodexTextFromMessage(message)
  const optionsWithOriginal = promptOptions as
    | (PromptOptions & { originalMessage?: unknown })
    | undefined
  const originalMessage = optionsWithOriginal?.originalMessage

  if (typeof originalMessage === 'string' || Array.isArray(originalMessage)) {
    const normalized = normalizeCodexDisplayMessage(originalMessage as CodexPromptMessage)
    return {
      runtimeText,
      displayText: normalized.text,
      displayParts: normalized.parts
    }
  }

  const normalized = normalizeCodexDisplayMessage(message)
  return {
    runtimeText,
    displayText: normalized.text,
    displayParts: normalized.parts
  }
}

function withCodexPartTimestamp(part: CodexPromptPart, timestamp: string): Record<string, unknown> {
  return { ...part, timestamp }
}

function sanitizeCodexUserMessageForPersistence(message: unknown): unknown {
  const record = asObject(message)
  if (!record || record.role !== 'user') return message

  const parts = Array.isArray(record.parts)
    ? record.parts.map((part) => {
        const partRecord = asObject(part)
        if (partRecord?.type !== 'text' || typeof partRecord.text !== 'string') return part
        return { ...partRecord, text: stripFieldContextEnvelope(partRecord.text) }
      })
    : record.parts

  const sanitized: Record<string, unknown> = { ...record, parts }
  if (typeof record.content === 'string') {
    sanitized.content = stripFieldContextEnvelope(record.content)
  }
  return sanitized
}

function hasRenderableAssistantMessage(messages: unknown[]): boolean {
  return messages.some((message) => {
    const record = asObject(message)
    if (record?.role !== 'assistant') return false

    if (typeof record.content === 'string' && record.content.trim().length > 0) {
      return true
    }

    const parts = Array.isArray(record.parts) ? record.parts : []
    return parts.some((part) => {
      const partRecord = asObject(part)
      if (!partRecord) return false
      if (partRecord.type === 'text' && typeof partRecord.text === 'string') {
        return partRecord.text.trim().length > 0
      }
      if (partRecord.type === 'reasoning' && typeof partRecord.text === 'string') {
        return partRecord.text.trim().length > 0
      }
      return false
    })
  })
}

function extractCodexTimelineMessageText(message: unknown): string {
  const record = asObject(message)
  if (!record) return ''

  if (typeof record.content === 'string') {
    return record.content
  }

  const parts = Array.isArray(record.parts) ? record.parts : []
  return parts
    .map((part) => asObject(part))
    .map((part) => asString(part?.text) ?? '')
    .filter(Boolean)
    .join('\n')
    .trim()
}

// ── Immediate title helpers ────────────────────────────────────────────────

const IMMEDIATE_TITLE_LENGTH = 50

function truncateForImmediateTitle(text: string): string {
  const trimmed = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (!trimmed) return ''
  if (trimmed.length <= IMMEDIATE_TITLE_LENGTH) return trimmed
  return trimmed.slice(0, IMMEDIATE_TITLE_LENGTH - 3) + '...'
}

export function normalizeCodexMessageTimestamps<T extends { created_at: string }>(rows: T[]): T[] {
  let lastTimestampMs = Number.NEGATIVE_INFINITY

  return rows.map((row) => {
    const parsed = Date.parse(row.created_at)
    const baseTimestampMs = Number.isFinite(parsed) ? parsed : Date.now()
    const nextTimestampMs =
      baseTimestampMs > lastTimestampMs ? baseTimestampMs : lastTimestampMs + 1
    lastTimestampMs = nextTimestampMs

    return {
      ...row,
      created_at: new Date(nextTimestampMs).toISOString()
    }
  })
}

function extractCodexTurnIdFromMessageId(messageId: string | undefined): string | null {
  if (!messageId) return null
  const match = messageId.match(/^(.*):(user|assistant)(?::.*)?$/)
  return match?.[1] ?? null
}

function hasRenderableTextMessage(message: unknown): boolean {
  const record = asObject(message)
  if (!record) return false
  if (typeof record.content === 'string' && record.content.trim().length > 0) return true

  const parts = Array.isArray(record.parts) ? record.parts : []
  return parts.some((part) => {
    const partRecord = asObject(part)
    if (!partRecord) return false
    if (partRecord.type === 'text' && typeof partRecord.text === 'string') {
      return partRecord.text.trim().length > 0
    }
    if (partRecord.type === 'reasoning' && typeof partRecord.text === 'string') {
      return partRecord.text.trim().length > 0
    }
    return false
  })
}

function isCodexToolItemType(itemType: string | undefined): boolean {
  return (
    itemType === 'commandExecution' ||
    itemType === 'fileChange' ||
    itemType === 'webSearch' ||
    itemType === 'mcpToolCall'
  )
}

function timestampFromMs(value: unknown): string | null {
  const raw = asNumber(value)
  if (raw === undefined) return null
  const ms = raw < 10_000_000_000 ? raw * 1000 : raw
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function eventTimestampFromPayload(payload: Record<string, unknown> | null): string | null {
  return (
    timestampFromMs(payload?.startedAtMs) ??
    timestampFromMs(payload?.completedAtMs) ??
    timestampFromMs(payload?.createdAtMs) ??
    timestampFromMs(payload?.updatedAtMs)
  )
}

function asRawAgentEvent(event: unknown): RawAgentEvent {
  return event as RawAgentEvent
}

export function hasCollapsedCodexMessageTimeline(
  messages: unknown[],
  activities: Array<{ turn_id?: string | null; kind?: string; created_at?: string }>
): boolean {
  const toolSpansByTurn = new Map<string, { min: number; max: number; count: number }>()

  for (const activity of activities) {
    if (!activity.kind?.startsWith('tool.')) continue
    if (!activity.turn_id) continue
    const ts = Date.parse(activity.created_at ?? '')
    if (!Number.isFinite(ts)) continue
    const current = toolSpansByTurn.get(activity.turn_id) ?? {
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
      count: 0
    }
    current.min = Math.min(current.min, ts)
    current.max = Math.max(current.max, ts)
    current.count += 1
    toolSpansByTurn.set(activity.turn_id, current)
  }

  if (toolSpansByTurn.size === 0) return false

  const assistantTimesByTurn = new Map<string, number[]>()
  for (const message of messages) {
    const record = asObject(message)
    if (!record || record.role !== 'assistant') continue
    if (!hasRenderableTextMessage(message)) continue

    const turnId = extractCodexTurnIdFromMessageId(asString(record.id))
    if (!turnId) continue
    const ts = Date.parse(asString(record.timestamp) ?? '')
    if (!Number.isFinite(ts)) continue
    const list = assistantTimesByTurn.get(turnId) ?? []
    list.push(ts)
    assistantTimesByTurn.set(turnId, list)
  }

  for (const [turnId, assistantTimes] of assistantTimesByTurn) {
    if (assistantTimes.length < 2) continue
    const toolSpan = toolSpansByTurn.get(turnId)
    if (!toolSpan || toolSpan.count === 0) continue

    const minAssistant = Math.min(...assistantTimes)
    const maxAssistant = Math.max(...assistantTimes)
    const assistantSpread = maxAssistant - minAssistant
    const toolSpread = toolSpan.max - toolSpan.min

    if (assistantSpread <= 1000 && toolSpread >= 2000 && maxAssistant < toolSpan.min) {
      return true
    }
  }

  return false
}

export class CodexImplementer implements AgentSdkImplementer, AgentRuntimeAdapter {
  readonly id = 'codex' as const
  readonly capabilities: AgentSdkCapabilities = CODEX_CAPABILITIES

  private mainWindow: BrowserWindow | null = null
  private dbService: DatabaseService | null = null
  private selectedModel: string = resolveCodexModelSlug(
    getCodexConfiguredModel() ?? CODEX_DEFAULT_MODEL
  )
  private selectedVariant: string | undefined
  private manager: CodexAppServerManager = new CodexAppServerManager()
  private sessions = new Map<string, CodexSessionState>()
  private pendingQuestions = new Map<string, PendingHitlEntry>()
  private pendingApprovalSessions = new Map<string, PendingHitlEntry>()
  private skillCommandsBySessionKey = new Map<string, CodexSkillCommand[]>()

  private resolveContextWindow(runtimeValue: number | undefined, modelID: string): number {
    return (
      getCodexConfiguredContextWindow() ??
      runtimeValue ??
      getCodexModelInfo(modelID)?.limit.context ??
      0
    )
  }

  private calculateTurnTokenUsageCostDelta(
    session: CodexSessionState,
    turnId: string | undefined,
    modelID: string,
    tokens: { input: number; cacheRead: number; cacheWrite: number; output: number },
    totals?: {
      totalInputTokens: number
      totalCachedInputTokens: number
      totalOutputTokens: number
      totalReasoningTokens: number
    }
  ): { cost?: number; requestId?: string } {
    if (!turnId) return {}

    // Use event-keyed dedup instead of per-turn max.
    // Each unique token-count event should only be counted once.
    const costByEvent =
      session.tokenUsageCostByEvent ?? (session.tokenUsageCostByEvent = new Map<string, number>())

    // Build event key matching the DB sourceEventId fingerprint.
    // Use cumulative totals when available (same as persistCodexTokenCountEvent),
    // fall back to delta values for backward compat.
    const eventKey = totals
      ? [
          session.threadId ?? 'unknown',
          turnId,
          totals.totalInputTokens,
          totals.totalCachedInputTokens,
          totals.totalOutputTokens,
          totals.totalReasoningTokens
        ].join(':')
      : [turnId, tokens.input, tokens.cacheRead, tokens.cacheWrite, tokens.output].join(':')

    const totalCost = calculateUsageCost(modelID, tokens, 'codex')

    if (costByEvent.has(eventKey)) {
      // Already counted this exact event
      return {}
    }

    costByEvent.set(eventKey, totalCost)

    return {
      cost: totalCost,
      requestId: ['codex-context-usage', eventKey].join(':')
    }
  }

  /**
   * Persist a codex turn's token usage to `usage_entries`.
   *
   * Per-turn rows are keyed by `(session_id, source_message_id='codex-turn:<turnId>')`,
   * Persist a single Codex token-count event to the v2 event-keyed ledger.
   *
   * Each tokenUsage/updated notification gets its own row, keyed by a fingerprint
   * of the cumulative totals. This ensures:
   * - Duplicate notifications with the same cumulative total are ignored
   * - Multiple events in the same turn each get their own row
   * - Summing event deltas reconstructs the correct thread total
   */
  private persistCodexTokenCountEvent(
    session: CodexSessionState,
    turnId: string | undefined,
    modelID: string,
    lastTokens: {
      input: number
      cacheRead: number
      cacheWrite: number
      output: number
      reasoning: number
    },
    totals: {
      totalInputTokens: number
      totalCachedInputTokens: number
      totalOutputTokens: number
      totalReasoningTokens: number
      lastInputTokens: number
      lastCachedInputTokens: number
      lastOutputTokens: number
      lastReasoningTokens: number
    },
    contextWindow: number
  ): void {
    if (!this.dbService || !turnId) return

    // total_tokens = input + output + cacheRead + cacheWrite
    // reasoning is a subset of output, NOT additive
    const total =
      lastTokens.input + lastTokens.output + lastTokens.cacheRead + lastTokens.cacheWrite
    if (total <= 0) return

    try {
      const dbSession = this.dbService.getSession(session.hiveSessionId)
      if (!dbSession) return

      // Build a stable event fingerprint from cumulative totals.
      // If Codex ever exposes a native event id, use that instead.
      const sourceEventId = [
        session.threadId ?? 'unknown',
        turnId,
        totals.totalInputTokens,
        totals.totalCachedInputTokens,
        totals.totalOutputTokens,
        totals.totalReasoningTokens
      ].join(':')

      // Cost uses input + output + cache (reasoning is subset of output)
      const costTokens = {
        input: lastTokens.input,
        cacheRead: lastTokens.cacheRead,
        cacheWrite: lastTokens.cacheWrite,
        output: lastTokens.output
      }
      const cost = calculateUsageCost(modelID, costTokens, 'codex')
      const pricingModelKey = resolvePricingModelKey(modelID, 'codex')

      this.dbService.insertUsageEvent({
        session_id: session.hiveSessionId,
        project_id: dbSession.project_id,
        worktree_id: dbSession.worktree_id ?? null,
        agent_sdk: 'codex',
        source_kind: 'codex-token-count',
        source_event_id: sourceEventId,
        runtime_session_id: session.threadId ?? null,
        thread_id: session.threadId ?? null,
        turn_id: turnId,
        provider_id: 'codex',
        model_id: pricingModelKey,
        model_label: modelID,
        input_tokens: lastTokens.input,
        output_tokens: lastTokens.output,
        reasoning_tokens: lastTokens.reasoning,
        cache_write_tokens: lastTokens.cacheWrite,
        cache_read_tokens: lastTokens.cacheRead,
        total_tokens: total,
        cost_estimate: cost,
        occurred_at: new Date().toISOString()
      })

      // Update the session usage snapshot with cumulative totals
      // total_tokens = input + output (reasoning is subset of output)
      const snapshotTotalTokens = totals.totalInputTokens + totals.totalOutputTokens
      this.dbService.upsertUsageSnapshot({
        session_id: session.hiveSessionId,
        agent_sdk: 'codex',
        runtime_session_id: session.threadId ?? null,
        thread_id: session.threadId ?? null,
        provider_id: 'codex',
        model_id: pricingModelKey,
        model_label: modelID,
        total_input_tokens: totals.totalInputTokens - totals.totalCachedInputTokens,
        total_output_tokens: totals.totalOutputTokens,
        total_reasoning_tokens: totals.totalReasoningTokens,
        total_cache_write_tokens: 0,
        total_cache_read_tokens: totals.totalCachedInputTokens,
        total_tokens: snapshotTotalTokens,
        total_cost_estimate: calculateUsageCost(
          modelID,
          {
            input: totals.totalInputTokens - totals.totalCachedInputTokens,
            cacheRead: totals.totalCachedInputTokens,
            cacheWrite: 0,
            output: totals.totalOutputTokens
          },
          'codex'
        ),
        context_used_tokens: totals.lastInputTokens,
        context_window_tokens: contextWindow,
        context_percent: contextWindow > 0 ? (totals.lastInputTokens / contextWindow) * 100 : 0,
        source_kind: 'codex-token-count',
        sync_status: 'synced',
        last_event_at: new Date().toISOString()
      })

      // Also persist to legacy usage_entries for backward compatibility
      this.persistCodexTurnUsageLegacy(session, turnId, modelID, lastTokens)
    } catch (error) {
      log.warn('Failed to persist codex token-count event', {
        hiveSessionId: session.hiveSessionId,
        turnId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * Legacy persistence to usage_entries for backward compatibility.
   * This keeps the old behavior of one row per turn for existing consumers.
   */
  private persistCodexTurnUsageLegacy(
    session: CodexSessionState,
    turnId: string | undefined,
    modelID: string,
    lastTokens: { input: number; cacheRead: number; cacheWrite: number; output: number }
  ): void {
    if (!this.dbService || !turnId) return

    const total =
      lastTokens.input + lastTokens.output + lastTokens.cacheRead + lastTokens.cacheWrite
    if (total <= 0) return

    try {
      const dbSession = this.dbService.getSession(session.hiveSessionId)
      if (!dbSession) return

      const cost = calculateUsageCost(modelID, lastTokens, 'codex')
      const pricingModelKey = resolvePricingModelKey(modelID, 'codex')

      this.dbService.upsertUsageEntry({
        session_id: session.hiveSessionId,
        project_id: dbSession.project_id,
        worktree_id: dbSession.worktree_id ?? null,
        agent_sdk: 'codex',
        source_kind: 'codex-message',
        source_message_id: `codex-turn:${turnId}`,
        provider_id: 'codex',
        model_id: pricingModelKey,
        model_label: modelID,
        input_tokens: lastTokens.input,
        output_tokens: lastTokens.output,
        cache_write_tokens: lastTokens.cacheWrite,
        cache_read_tokens: lastTokens.cacheRead,
        total_tokens: total,
        cost,
        occurred_at: new Date().toISOString()
      })
    } catch (error) {
      log.warn('Failed to persist codex turn usage (legacy)', {
        hiveSessionId: session.hiveSessionId,
        turnId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  // ── Window binding ───────────────────────────────────────────────

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  setDatabaseService(db: DatabaseService): void {
    this.dbService = db
  }

  private async resolveLaunchSpec() {
    return ensureCodexAppServerLaunchSpec()
  }

  private maybeNotifyPendingUserFeedback(
    hiveSessionId: string,
    kind: 'question' | 'approval'
  ): void {
    try {
      if (!this.mainWindow || this.mainWindow.isDestroyed() || this.mainWindow.isFocused()) {
        return
      }

      if (!this.dbService) return

      const session = this.dbService.getSession(hiveSessionId)
      if (!session) return

      const project = this.dbService.getProject(session.project_id)
      if (!project) return

      notificationService.showPendingUserFeedback(
        {
          projectName: project.name,
          sessionName: session.name || 'Untitled',
          projectId: session.project_id,
          worktreeId: session.worktree_id || '',
          sessionId: hiveSessionId
        },
        kind
      )
    } catch (error) {
      log.warn('Failed to show pending user feedback notification', {
        hiveSessionId,
        kind,
        error
      })
    }
  }

  // ── Manager event listener (handles approval/question routing) ──

  private managerListenerAttached = false

  private attachManagerListener(): void {
    if (this.managerListenerAttached) return
    this.managerListenerAttached = true

    this.manager.on('event', (event: CodexManagerEvent) => {
      this.handleManagerEvent(event)
    })
  }

  private handleManagerEvent(event: CodexManagerEvent): void {
    // DEBUG: Log ALL notification events to discover title-related methods
    if (event.kind === 'notification') {
      log.info('DEBUG handleManagerEvent: notification received', {
        method: event.method,
        threadId: event.threadId,
        payloadKeys: event.payload ? Object.keys(event.payload as Record<string, unknown>) : [],
        payloadSnapshot: toDebugSnapshot(event.payload, 500)
      })
    }

    const targetSession = this.findSessionByThreadId(event.threadId)
    if (targetSession) {
      this.persistActivity(targetSession, event)

      this.recordCodexItemTimelineTimestamp(targetSession, event)

      // Phase 21.5: emit agent.* field events when a tool item completes.
      // Wrapped in try/catch — instrumentation failure must never affect
      // the main event flow.
      if (event.kind === 'notification' && event.method === 'item/completed') {
        try {
          this.emitAgentToolField(targetSession, event)
        } catch (err) {
          log.debug('Phase 21.5 emit failed; continuing', {
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
    }

    // Clean up stale pending entries when a session closes
    if (
      event.kind === 'session' &&
      (event.method === 'session/closed' || event.method === 'session/exited')
    ) {
      this.cleanupPendingForThread(event.threadId)
      return
    }

    // Handle thread name updates from the Codex provider (title generation)
    if (event.kind === 'notification' && event.method === 'thread/name/updated') {
      this.handleProviderTitleUpdate(event).catch(() => {})
      return
    }

    // Handle token usage updates from the Codex provider
    if (event.kind === 'notification' && event.method === 'thread/tokenUsage/updated') {
      if (!targetSession) return

      const payload = asObject(event.payload)
      const tokenUsage = asObject(payload?.tokenUsage)
      const last = asObject(tokenUsage?.last)
      const total = asObject(tokenUsage?.total) ?? last
      const turnId = event.turnId ?? asString(payload?.turnId)

      const lastInputTokens = asNumber(last?.inputTokens) ?? 0
      const lastCachedInputTokens = asNumber(last?.cachedInputTokens) ?? 0
      const lastOutputTokens = asNumber(last?.outputTokens) ?? 0
      const lastReasoningTokens = asNumber(last?.reasoningOutputTokens) ?? 0
      const totalInputTokens = asNumber(total?.inputTokens) ?? lastInputTokens
      const totalCachedInputTokens = asNumber(total?.cachedInputTokens) ?? lastCachedInputTokens
      const totalOutputTokens = asNumber(total?.outputTokens) ?? lastOutputTokens
      const totalReasoningTokens = asNumber(total?.reasoningOutputTokens) ?? lastReasoningTokens

      const modelID = resolveCodexModelSlug(asString(payload?.model) ?? this.selectedModel)
      const contextWindow = this.resolveContextWindow(
        asNumber(tokenUsage?.modelContextWindow),
        modelID
      )
      const tokens = {
        input: Math.max(0, totalInputTokens - totalCachedInputTokens),
        cacheRead: totalCachedInputTokens,
        cacheWrite: 0,
        output: totalOutputTokens,
        reasoning: totalReasoningTokens
      }
      const lastTokens = {
        input: Math.max(0, lastInputTokens - lastCachedInputTokens),
        cacheRead: lastCachedInputTokens,
        cacheWrite: 0,
        output: lastOutputTokens,
        reasoning: lastReasoningTokens
      }
      const costData = this.calculateTurnTokenUsageCostDelta(
        targetSession,
        turnId,
        modelID,
        lastTokens,
        {
          totalInputTokens,
          totalCachedInputTokens,
          totalOutputTokens,
          totalReasoningTokens
        }
      )

      // Persist this token-count event to the v2 event-keyed ledger.
      //
      // Previous behavior: one row per turnId, upserted on each tokenUsage/updated.
      // This lost ~90% of data because a single turn can have many token-count events.
      //
      // New behavior: one row per unique token-count event, keyed by a fingerprint
      // of the cumulative totals. This allows correct aggregation by summing deltas.
      this.persistCodexTokenCountEvent(
        targetSession,
        turnId,
        modelID,
        lastTokens,
        {
          totalInputTokens,
          totalCachedInputTokens,
          totalOutputTokens,
          totalReasoningTokens,
          lastInputTokens,
          lastCachedInputTokens,
          lastOutputTokens,
          lastReasoningTokens
        },
        contextWindow
      )

      emitAgentEvent(this.mainWindow, {
        type: 'session.context_usage',
        sessionId: targetSession.hiveSessionId,
        data: {
          tokens,
          model: { providerID: 'codex', modelID },
          contextWindow,
          breakdown: {
            usedTokens: lastInputTokens,
            maxTokens: contextWindow,
            percentage: contextWindow > 0 ? (lastInputTokens / contextWindow) * 100 : 0
          },
          ...costData
        }
      })
      return
    }

    // Handle thread compaction notifications
    if (event.kind === 'notification' && event.method === 'thread/compacted') {
      if (!targetSession) return

      emitAgentEvent(this.mainWindow, {
        type: 'session.context_compacted',
        sessionId: targetSession.hiveSessionId,
        data: {}
      })
      return
    }

    if (event.kind === 'notification' && event.method === 'skills/changed') {
      if (targetSession) {
        this.skillCommandsBySessionKey.delete(
          this.getSessionKey(targetSession.worktreePath, targetSession.threadId)
        )
        this.sendCommandsAvailable(targetSession)
      } else {
        this.skillCommandsBySessionKey.clear()
        for (const session of this.sessions.values()) {
          this.sendCommandsAvailable(session)
        }
      }
      return
    }

    // Only handle request events (approvals + user inputs)
    if (event.kind !== 'request') return

    if (!targetSession) return

    const requestId = event.requestId
    if (!requestId) return

    // Handle approval requests
    if (
      event.method === 'item/commandExecution/requestApproval' ||
      event.method === 'item/fileChange/requestApproval' ||
      event.method === 'item/fileRead/requestApproval'
    ) {
      this.pendingApprovalSessions.set(requestId, {
        threadId: targetSession.threadId,
        hiveSessionId: targetSession.hiveSessionId,
        worktreePath: targetSession.worktreePath,
        turnId:
          event.turnId ?? this.manager.getSession(targetSession.threadId)?.activeTurnId ?? undefined
      })

      const payload = asObject(event.payload)
      emitAgentEvent(this.mainWindow, {
        type: 'permission.asked',
        sessionId: targetSession.hiveSessionId,
        data: this.toPermissionRequest(
          requestId,
          targetSession.hiveSessionId,
          event.method,
          payload,
          event.turnId,
          event.itemId
        )
      })
      this.maybeNotifyPendingUserFeedback(targetSession.hiveSessionId, 'approval')
      return
    }

    // Handle user input requests (questions)
    if (event.method === 'item/tool/requestUserInput') {
      this.pendingQuestions.set(requestId, {
        threadId: targetSession.threadId,
        hiveSessionId: targetSession.hiveSessionId,
        worktreePath: targetSession.worktreePath,
        // Same fallback as the durable activity below — codex's
        // requestUserInput JSON-RPC params don't always carry turn.id.
        turnId:
          event.turnId ?? this.manager.getSession(targetSession.threadId)?.activeTurnId ?? undefined
      })

      const payload = asObject(event.payload)
      // Codex's request_user_input MCP tool may carry the question in any of
      // several shapes (depending on how the agent invoked it). Normalize so
      // the UI always receives a non-empty `questions` array — otherwise
      // AskUserCard would silently drop the request and the turn would hang
      // forever waiting for a reply that can never arrive.
      let questions = (payload?.questions ?? payload?.items ?? []) as unknown[]
      if (!Array.isArray(questions) || questions.length === 0) {
        const item = asObject(payload?.item)
        const args = asObject(item?.arguments) ?? asObject(payload?.arguments)
        const prompt =
          asString(args?.prompt) ??
          asString(args?.question) ??
          asString(payload?.prompt) ??
          asString(payload?.question) ??
          'Codex requested user input.'
        const optionsRaw = (args?.options ?? args?.choices ?? payload?.options) as unknown
        const options = Array.isArray(optionsRaw)
          ? optionsRaw.map((opt) =>
              typeof opt === 'string'
                ? { label: opt, description: '' }
                : ((opt as { label?: string; description?: string }) ?? {
                    label: '',
                    description: ''
                  })
            )
          : []
        questions = [
          {
            question: prompt,
            header: 'Codex',
            multiple: false,
            options
          }
        ]
        log.info('codex requestUserInput: synthesized fallback question', {
          requestId,
          prompt,
          optionCount: options.length,
          payloadKeys: payload ? Object.keys(payload) : []
        })
      }

      // Snapshot questions on the pending entry so questionReply can include
      // them in the durable record (input.questions).
      const pending = this.pendingQuestions.get(requestId)
      if (pending) pending.questions = questions

      emitAgentEvent(this.mainWindow, {
        type: 'question.asked',
        sessionId: targetSession.hiveSessionId,
        data: {
          requestId,
          id: requestId,
          questions
        }
      })

      // Also surface as a synthetic tool part so AgentTimeline renders the
      // existing AskUserCard (it dispatches on tool name === 'AskUserQuestion').
      // Without this, the question would only appear as a composer placeholder
      // change and the user would have nowhere to click an answer.
      emitAgentEvent(this.mainWindow, {
        type: 'message.part.updated',
        sessionId: targetSession.hiveSessionId,
        data: {
          part: {
            type: 'tool',
            callID: requestId,
            tool: 'AskUserQuestion',
            state: {
              status: 'running',
              input: { questions }
            }
          }
        }
      })

      // Persist a tool.started activity so the durable timeline keeps the
      // AskUserCard around after the turn ends. Without this, the synthetic
      // tool part lives only in the streaming overlay and disappears as
      // soon as the live transcript is sealed.
      if (this.dbService) {
        try {
          this.dbService.upsertSessionActivity({
            id: `${requestId}:asked`,
            session_id: targetSession.hiveSessionId,
            agent_session_id: targetSession.threadId,
            thread_id: targetSession.threadId,
            // Fallback to the session's active turn — codex's
            // item/tool/requestUserInput JSON-RPC params don't always carry
            // turn.id, but without it the synthetic AskUserCard becomes
            // "unanchored" in timeline-mappers and gets pushed to the END of
            // the timeline (rendered after all post-question text). The
            // manager already tracks activeTurnId from turn/started events.
            turn_id:
              event.turnId ?? this.manager.getSession(targetSession.threadId)?.activeTurnId ?? null,
            item_id: requestId,
            request_id: requestId,
            kind: 'tool.started',
            tone: 'tool',
            summary: 'AskUserQuestion',
            payload_json: JSON.stringify({
              item: {
                type: 'AskUserQuestion',
                toolName: 'AskUserQuestion',
                id: requestId,
                input: { questions }
              }
            })
          })
        } catch (err) {
          log.warn('codex requestUserInput: failed to persist tool.started', {
            requestId,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }

      this.maybeNotifyPendingUserFeedback(targetSession.hiveSessionId, 'question')
    }
  }

  private async handleProviderTitleUpdate(event: CodexManagerEvent): Promise<void> {
    const payload = asObject(event.payload)
    log.info('DEBUG handleProviderTitleUpdate: raw payload', {
      payloadKeys: payload ? Object.keys(payload) : [],
      fullPayload: toDebugSnapshot(event.payload, 1000)
    })
    const title = asString(payload?.threadName)
    if (!title) {
      log.warn(
        'DEBUG handleProviderTitleUpdate: threadName field empty/missing, tried payload?.threadName'
      )
      return
    }

    // Find session by threadId
    let targetSession: CodexSessionState | undefined
    for (const session of this.sessions.values()) {
      if (session.threadId === event.threadId) {
        targetSession = session
        break
      }
    }
    if (!targetSession) return

    await this.applyGeneratedTitle(targetSession, title)
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async connect(worktreePath: string, hiveSessionId: string): Promise<{ sessionId: string }> {
    const resolvedModel = resolveCodexModelSlug(this.selectedModel)
    log.info('Connecting', { worktreePath, hiveSessionId, model: resolvedModel })

    // Ensure the manager event listener is attached for HITL flows
    this.attachManagerListener()

    const providerSession = await this.manager.startSession({
      cwd: worktreePath,
      model: resolvedModel,
      codexLaunchSpec: await this.resolveLaunchSpec()
    })

    const threadId = providerSession.threadId
    if (!threadId) {
      throw new Error('Codex session started but no thread ID was returned.')
    }

    const key = this.getSessionKey(worktreePath, threadId)
    const state: CodexSessionState = {
      threadId,
      hiveSessionId,
      worktreePath,
      status: this.mapProviderStatus(providerSession.status),
      messages: [],
      liveAssistantDraft: null,
      activeRun: null,
      settledRunIds: new Set(),
      revertMessageID: null,
      revertDiff: null,
      titleGenerated: false,
      titleGenerationStarted: false,
      tokenUsageCostByEvent: new Map(),
      mapperState: createCodexMapperState(),
      itemTimestampsByTurn: new Map(),
      recordedItemIdsByTurn: new Map()
    }
    this.sessions.set(key, state)

    // Notify renderer that the session has materialized
    emitAgentEvent(this.mainWindow, {
      type: 'session.materialized',
      sessionId: hiveSessionId,
      data: { newSessionId: threadId, wasFork: false }
    })

    log.info('Connected', { worktreePath, hiveSessionId, threadId })
    return { sessionId: threadId }
  }

  async reconnect(
    worktreePath: string,
    agentSessionId: string,
    hiveSessionId: string
  ): Promise<{
    success: boolean
    sessionId?: string
    sessionStatus?: 'idle' | 'busy' | 'retry'
    revertMessageID?: string | null
  }> {
    const key = this.getSessionKey(worktreePath, agentSessionId)

    // If session already exists locally, just update the hiveSessionId
    const existing = this.sessions.get(key)
    if (existing) {
      existing.hiveSessionId = hiveSessionId
      const sessionStatus = this.statusToHive(existing.status)
      log.info('Reconnect: session already registered, updated hiveSessionId', {
        worktreePath,
        agentSessionId,
        hiveSessionId,
        sessionStatus
      })
      this.hydrateTokenUsageFromThread(existing).catch(() => {})
      return { success: true, sessionId: existing.threadId, sessionStatus, revertMessageID: null }
    }

    // Otherwise, start a new session with thread resume
    try {
      // Ensure the manager event listener is attached so notifications
      // like thread/tokenUsage/updated reach handleManagerEvent.
      this.attachManagerListener()

      const resolvedModel = resolveCodexModelSlug(this.selectedModel)
      const providerSession = await this.manager.startSession({
        cwd: worktreePath,
        model: resolvedModel,
        resumeThreadId: agentSessionId,
        codexLaunchSpec: await this.resolveLaunchSpec()
      })

      const threadId = providerSession.threadId
      if (!threadId) {
        throw new Error('Codex session started but no thread ID was returned.')
      }

      const newKey = this.getSessionKey(worktreePath, threadId)
      const state: CodexSessionState = {
        threadId,
        hiveSessionId,
        worktreePath,
        status: this.mapProviderStatus(providerSession.status),
        messages: [],
        liveAssistantDraft: null,
        activeRun: null,
        settledRunIds: new Set(),
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: true,
        titleGenerationStarted: true,
        tokenUsageCostByEvent: new Map(),
        mapperState: createCodexMapperState(),
        itemTimestampsByTurn: new Map(),
        recordedItemIdsByTurn: new Map()
      }
      this.sessions.set(newKey, state)

      log.info('Reconnected via thread resume', { worktreePath, agentSessionId, threadId })

      // Fire-and-forget: hydrate token usage so the context bar shows
      // accumulated usage from previous turns, not 0/200k.
      this.hydrateTokenUsageFromThread(state).catch(() => {})

      return {
        success: true,
        sessionId: state.threadId,
        sessionStatus: this.statusToHive(state.status),
        revertMessageID: null
      }
    } catch (error) {
      log.error('Reconnect failed', error instanceof Error ? error : new Error(String(error)), {
        worktreePath,
        agentSessionId
      })
      return { success: false }
    }
  }

  async disconnect(worktreePath: string, agentSessionId: string): Promise<void> {
    const key = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(key)

    if (!session) {
      log.warn('Disconnect: session not found, ignoring', { worktreePath, agentSessionId })
      return
    }

    // Stop the manager session
    this.manager.stopSession(agentSessionId)

    // Clean up local state
    this.sessions.delete(key)
    this.skillCommandsBySessionKey.delete(key)
    this.cleanupPendingForThread(agentSessionId)

    log.info('Disconnected', { worktreePath, agentSessionId })
  }

  async cleanup(): Promise<void> {
    log.info('Cleaning up CodexImplementer state', { sessionCount: this.sessions.size })

    // Stop all manager sessions
    this.manager.stopAll()

    // Clear local state
    this.sessions.clear()
    this.skillCommandsBySessionKey.clear()
    this.pendingQuestions.clear()
    this.pendingApprovalSessions.clear()
    this.managerListenerAttached = false
    this.mainWindow = null
    this.selectedModel = CODEX_DEFAULT_MODEL
    this.selectedVariant = undefined
  }

  // ── Messaging ────────────────────────────────────────────────────

  async prompt(
    worktreePath: string,
    agentSessionId: string,
    message: CodexPromptMessage,
    modelOverride?: { providerID: string; modelID: string; variant?: string },
    options?: PromptOptions
  ): Promise<void> {
    const key = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(key)
    if (!session) {
      throw new Error(`Prompt failed: session not found for ${worktreePath} / ${agentSessionId}`)
    }

    const { runtimeText, displayText, displayParts } = prepareCodexPrompt(message, options)

    if (!runtimeText.trim()) {
      log.warn('Prompt: empty text, ignoring', { worktreePath, agentSessionId })
      return
    }

    const activeRun = this.beginCodexRun(session)
    const runId = activeRun.runId
    beginSessionRun(session.hiveSessionId)

    // Immediate title: set truncated first message as title for instant UX feedback
    const isFirstMessage = session.messages.length === 0 && !session.titleGenerated
    if (isFirstMessage) {
      session.titleGenerated = true
      const immediateTitle = truncateForImmediateTitle(displayText)
      if (immediateTitle && this.dbService) {
        this.dbService.updateSession(session.hiveSessionId, { name: immediateTitle })
        emitAgentEvent(this.mainWindow, {
          type: 'session.updated',
          sessionId: session.hiveSessionId,
          data: { title: immediateTitle, info: { title: immediateTitle } }
        })
        log.info('Prompt: set immediate title', {
          hiveSessionId: session.hiveSessionId,
          immediateTitle
        })
      }
    }

    if (!session.titleGenerationStarted) {
      session.titleGenerationStarted = true
      this.handleTitleGeneration(session, displayText).catch(() => {})
    }

    // Inject synthetic user message so getMessages() returns it
    const syntheticTimestamp = new Date().toISOString()
    session.messages.push({
      id: `client:${runId}:user`,
      role: 'user',
      parts: displayParts.map((part) => withCodexPartTimestamp(part, syntheticTimestamp)),
      timestamp: syntheticTimestamp
    })
    this.persistCanonicalMessages(session)
    this.resetLiveAssistantDraft(session)

    // Emit busy status
    session.status = 'running'
    this.emitStatus(session.hiveSessionId, 'busy')

    log.info('Prompt: starting', {
      worktreePath,
      agentSessionId,
      hiveSessionId: session.hiveSessionId,
      textLength: runtimeText.length,
      displayTextLength: displayText.length
    })

    // Set up event listener for streaming
    let interactionMode: 'default' | 'plan' = 'default'
    let assistantText = ''
    let reasoningText = ''
    let pendingPlanText: string | null = null
    let turnCompleted = false
    let turnFailed = false
    let turnInterrupted = false
    let completedTurnId: string | undefined
    // Track whether a question was raised in this turn. When the agent uses
    // request_user_input (a Plan-mode tool) inside an otherwise-Plan turn,
    // the assistant's final text is its REPLY to the user's answer, not a
    // proposed plan. Re-emitting plan.ready in that case turns every Q&A
    // into a fresh "Requires Approval" card. Suppress emission whenever the
    // turn raised a question.
    let userInputAskedInTurn = false

    const handleEvent = (event: CodexManagerEvent) => {
      // Only the currently active local run may mutate this session. This
      // prevents late events from a stopped turn from completing or repainting
      // a newly-started prompt on the same Codex thread.
      if (!this.eventMatchesActiveRun(session, runId, event)) return
      this.bindActiveRunTurnId(session, runId, event)

      const streamEvents = mapCodexEventToStreamEvents(
        event,
        session.hiveSessionId,
        session.mapperState
      )
      for (const streamEvent of streamEvents) {
        if (
          (event.method === 'turn/completed' || event.method === 'thread/status/changed') &&
          streamEvent.type === 'session.status' &&
          streamEvent.statusPayload?.type === 'idle'
        ) {
          continue
        }
        emitAgentEvent(this.mainWindow, asRawAgentEvent(streamEvent))
        this.updateLiveAssistantDraftFromStreamEvent(session, streamEvent)
      }

      // Accumulate text for message history
      const streamKind = contentStreamKindFromMethod(event.method)
      if (streamKind) {
        const payload = event.payload as Record<string, unknown> | undefined
        const deltaText =
          event.textDelta ??
          asString(asObject(payload)?.delta) ??
          asString(asObject(payload)?.text) ??
          ''

        if (streamKind === 'reasoning' || streamKind === 'reasoning_summary') {
          reasoningText += deltaText
        } else {
          assistantText += deltaText
        }
      }

      if (interactionMode === 'plan') {
        // Only extract plan from streaming events when <proposed_plan> XML
        // tags are present — the tag-based extraction is reliable.  Without
        // tags these events carry only the LAST message fragment, so we let
        // the post-turn fallback use the full accumulated assistantText.
        if (event.method === 'codex/event/task_complete') {
          const payload = asObject(event.payload)
          const msg = asObject(payload?.msg)
          const planText = asString(msg?.last_agent_message)
          if (planText) {
            const extracted = extractProposedPlanMarkdown(planText)
            if (extracted) pendingPlanText = extracted
          }
        }

        if (event.method === 'item/completed') {
          const payload = asObject(event.payload)
          const item = asObject(payload?.item)
          const itemType = asString(item?.type)?.toLowerCase()
          const planText = asString(item?.text)
          if (itemType === 'agentmessage' && planText) {
            const extracted = extractProposedPlanMarkdown(planText)
            if (extracted) pendingPlanText = extracted
          }
        }
      }

      // Detect turn completion and whether it failed
      if (event.method === 'turn/completed') {
        turnCompleted = true
        const payload = event.payload as Record<string, unknown> | undefined
        const turnObj = payload?.turn as Record<string, unknown> | undefined
        completedTurnId =
          event.turnId ?? (typeof turnObj?.id === 'string' ? (turnObj.id as string) : undefined)
        const status = (turnObj?.status as string) ?? (payload?.state as string)
        if (status === 'failed') {
          turnFailed = true
        }
        if (status === 'interrupted') {
          turnInterrupted = true
        }
      }

      if (event.method === 'turn/interrupted') {
        turnCompleted = true
        turnInterrupted = true
        completedTurnId = this.extractEventTurnId(event) ?? completedTurnId
      }

      // Track if request_user_input fires anywhere in this turn so we know
      // the assistant's final text is a reply to a question, not a plan.
      if (event.method === 'item/tool/requestUserInput') {
        userInputAskedInTurn = true
      }
    }

    this.manager.on('event', handleEvent)

    try {
      const model = resolveCodexModelSlug(modelOverride?.modelID ?? this.selectedModel)

      // Determine interaction mode from DB session mode (same pattern as claude-code-implementer)
      if (this.dbService) {
        try {
          const dbSession = this.dbService.getSession(session.hiveSessionId)
          if (dbSession?.mode === 'plan') {
            interactionMode = 'plan'
          }
        } catch {
          // Fall through to default mode
        }
      }

      let turnText = runtimeText
      let fallbackChars = 0

      const worktree =
        (
          this.dbService as { getWorktreeByPath?: (path: string) => { id?: string } | null } | null
        )?.getWorktreeByPath?.(session.worktreePath) ?? null
      if (worktree?.id) {
        const fallback = await buildXfpFallbackContext({
          provider: xfpProvider,
          scope: { worktreeId: worktree.id, sessionId: session.hiveSessionId },
          promptText: displayText || runtimeText
        })
        if (fallback) {
          fallbackChars = fallback.markdown.length
          turnText = `${fallback.markdown}\n\n[User Message]\n${turnText}`
          recordXfpAuditEvent({
            worktreeId: worktree.id,
            sessionId: session.hiveSessionId,
            runtimeId: 'codex',
            kind: 'fallback',
            toolName: 'xfp_triggered_fallback',
            input: {
              reason: fallback.reason,
              included: fallback.included
            },
            outputSummary: `Fallback prefix: ${fallback.included.join(', ')} (~${fallback.approxTokens} tokens)`,
            outputChars: fallback.markdown.length,
            truncated: false,
            privacy: 'allowed'
          })
          log.info('Codex XFP: using bounded triggered fallback field prefix', {
            worktreePath,
            agentSessionId,
            hiveSessionId: session.hiveSessionId,
            worktreeId: worktree.id,
            reason: fallback.reason,
            included: fallback.included,
            approxTokens: fallback.approxTokens
          })
        }
      }

      if (options?.goalMode) {
        const objective =
          options.goalObjective?.trim() ||
          buildCodexGoalObjective(displayText || runtimeText, options.successCriteria)
        if (!objective) {
          throw new Error('Codex goal mode requires a non-empty objective')
        }

        try {
          await this.manager.setThreadGoal(session.threadId, {
            objective,
            status: 'active',
            tokenBudget: null
          })
        } catch (goalError) {
          if (!isCodexGoalUnavailableError(goalError)) {
            throw goalError
          }

          const errorMessage = goalError instanceof Error ? goalError.message : String(goalError)
          turnText = appendCodexGoalFallbackPrompt(turnText, objective)
          log.warn('Codex native goal unavailable; falling back to prompt goal instructions', {
            worktreePath,
            agentSessionId,
            error: errorMessage
          })
        }
      }

      recordXfpPromptObservation({
        worktreeId: worktree?.id ?? null,
        sessionId: session.hiveSessionId,
        runtimeId: 'codex',
        fieldDeliveryMode: fallbackChars > 0 ? 'xfp-fallback' : 'none',
        promptChars: turnText.length,
        displayChars: (displayText || runtimeText).length,
        fallbackChars: fallbackChars > 0 ? fallbackChars : undefined,
        hasFieldContextEnvelope: turnText.trimStart().startsWith('[Field Context'),
        hasXfpFallbackPrefix: turnText.trimStart().startsWith('[Xuanpu Field Fallback]'),
        hasFileAttachments: Array.isArray(message),
        attachmentCount: Array.isArray(message)
          ? message.filter((part) => part.type === 'file').length
          : 0,
        mcpAttached: false
      })

      const turnStart = await this.manager.sendTurn(session.threadId, {
        text: turnText,
        model,
        ...(options?.codexFastMode ? { serviceTier: 'fast' } : {}),
        interactionMode
      })

      if (!this.isRunCurrent(session, runId)) {
        log.info('Prompt: stale run finished after a newer run started, skipping finalization', {
          worktreePath,
          agentSessionId,
          runId,
          activeRunId: session.activeRun?.runId ?? null
        })
        return
      }

      activeRun.expectedTurnId = turnStart.turnId || activeRun.expectedTurnId || null
      if (activeRun.state !== 'aborting') {
        activeRun.state = 'running'
      }

      // Wait for turn completion (the sendTurn starts the turn, but
      // events stream asynchronously via the manager's event emitter)
      const completionState = await this.waitForTurnCompletion(session, {
        runId,
        expectedTurnId: activeRun.expectedTurnId,
        isComplete: () => turnCompleted,
        signal: activeRun.abortController.signal
      })

      if (!this.isRunCurrent(session, runId)) {
        log.info('Prompt: stale run finished after wait, skipping finalization', {
          worktreePath,
          agentSessionId,
          runId,
          activeRunId: session.activeRun?.runId ?? null
        })
        return
      }

      if (completionState === 'interrupted' || turnInterrupted) {
        activeRun.state = 'finalizing'
        this.materializeLiveAssistantDraft(session, {
          aborted: true,
          terminalizeRunningTools: true,
          emitTerminalTools: true
        })
        session.liveAssistantDraft = null
        this.persistCanonicalMessages(session)
        session.status = 'ready'
        this.settleRun(session, runId)
        this.emitStatus(session.hiveSessionId, 'idle')
        return
      }

      // Read canonical thread for properly separated messages
      try {
        activeRun.state = 'finalizing'
        const threadSnapshot = await this.manager.readThread(session.threadId)
        if (!this.isRunCurrent(session, runId)) {
          log.info('Prompt: stale run finished during thread/read, skipping snapshot', {
            worktreePath,
            agentSessionId,
            runId,
            activeRunId: session.activeRun?.runId ?? null
          })
          return
        }
        const parsed = this.parseThreadSnapshot(threadSnapshot, session.itemTimestampsByTurn)
        this.persistJsonlSupplementalActivities(session, threadSnapshot)
        const snapshotMatchesPrompt = this.parsedMessagesContainUserText(parsed, [
          displayText,
          runtimeText,
          turnText
        ])
        if (parsed.length > 0 && snapshotMatchesPrompt) {
          session.messages = parsed
          // The snapshot is the canonical source once it matches the prompt.
          // Clear the live draft instead of materializing it — keeping both
          // would duplicate messages (live draft has id `codex-live-*` while
          // snapshot items have `${turnId}:assistant:item-*`).
          session.liveAssistantDraft = null
        } else if (parsed.length > 0) {
          log.warn(
            'prompt: stale or mismatched thread/read snapshot ignored, preserving live draft',
            {
              worktreePath,
              agentSessionId,
              runId
            }
          )
          if (!this.materializeLiveAssistantDraft(session)) {
            const assistantParts: unknown[] = []
            if (assistantText) {
              assistantParts.push({
                type: 'text',
                text: assistantText,
                timestamp: new Date().toISOString()
              })
            }
            if (reasoningText) {
              assistantParts.push({
                type: 'reasoning',
                text: reasoningText,
                timestamp: new Date().toISOString()
              })
            }
            if (assistantParts.length > 0) {
              session.messages.push({
                role: 'assistant',
                parts: assistantParts,
                timestamp: new Date().toISOString()
              })
            }
          }
        } else if (parsed.length === 0) {
          this.materializeLiveAssistantDraft(session)
        }
        this.persistCanonicalMessages(session)
        session.liveAssistantDraft = null
      } catch (readError) {
        if (!this.isRunCurrent(session, runId)) {
          log.info(
            'Prompt: stale run readThread failed after newer run started, skipping fallback',
            {
              worktreePath,
              agentSessionId,
              runId,
              activeRunId: session.activeRun?.runId ?? null
            }
          )
          return
        }
        log.warn('prompt: readThread after turn failed, falling back to accumulated text', {
          agentSessionId,
          error: readError instanceof Error ? readError.message : String(readError)
        })
        if (!this.materializeLiveAssistantDraft(session)) {
          // Fallback: use accumulated text as single message
          const assistantParts: unknown[] = []
          if (assistantText) {
            assistantParts.push({
              type: 'text',
              text: assistantText,
              timestamp: new Date().toISOString()
            })
          }
          if (reasoningText) {
            assistantParts.push({
              type: 'reasoning',
              text: reasoningText,
              timestamp: new Date().toISOString()
            })
          }
          if (assistantParts.length > 0) {
            session.messages.push({
              role: 'assistant',
              parts: assistantParts,
              timestamp: new Date().toISOString()
            })
          }
        }
        this.persistCanonicalMessages(session)
        session.liveAssistantDraft = null
      }

      // If no plan was detected from streaming events, extract from the parsed
      // thread snapshot.  session.messages has properly separated messages
      // (unlike assistantText which concatenates all deltas without separators).
      // Use the last assistant text message — in plan mode that's the plan.
      if (interactionMode === 'plan' && !pendingPlanText) {
        const msgs = session.messages as Array<Record<string, unknown>>
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i]?.role !== 'assistant') continue
          const parts = msgs[i].parts as Array<Record<string, unknown>> | undefined
          if (!Array.isArray(parts)) continue
          for (let j = parts.length - 1; j >= 0; j--) {
            if (parts[j]?.type === 'text' && typeof parts[j]?.text === 'string') {
              const text = parts[j].text as string
              const extracted = extractProposedPlanMarkdown(text)
              pendingPlanText = extracted ?? text
              break
            }
          }
          if (pendingPlanText) break
        }

        // Ultimate fallback: accumulated streaming text (lossy but better than nothing)
        if (!pendingPlanText && assistantText) {
          const extracted = extractProposedPlanMarkdown(assistantText)
          pendingPlanText = extracted ?? assistantText
        }
      }

      if (interactionMode === 'plan' && pendingPlanText && !userInputAskedInTurn) {
        const toolUseID = `codex-exitplan-${session.threadId}-${Date.now()}`
        // Per-plan requestId — including the turn id (or timestamp fallback)
        // so the same session can produce multiple plans without their
        // request_ids colliding. Previously this was just
        // `codex-plan:${session.threadId}`, which meant every subsequent
        // plan reused the requestId of the first plan; once that first plan
        // had a `plan.resolved` activity persisted, every later plan in the
        // same session got `resolvedRequestIds.has(reqId) === true` in
        // parsePlanPartFromActivity → status flipped to 'success' → the
        // brand-new plan card showed "Approved" while the FAB was still
        // waiting for the user to act on the new plan.
        const requestId = `codex-plan:${session.threadId}:${completedTurnId ?? Date.now()}`
        this.persistSyntheticActivity(session, {
          id: requestId,
          kind: 'plan.ready',
          tone: 'info',
          summary: 'Plan ready',
          requestId,
          turnId: completedTurnId,
          payload: { plan: pendingPlanText, toolUseID }
        })
        emitAgentEvent(this.mainWindow, {
          type: 'plan.ready',
          sessionId: session.hiveSessionId,
          data: {
            id: requestId,
            requestId,
            plan: pendingPlanText,
            toolUseID
          }
        })
      }

      session.status = turnFailed ? 'error' : 'ready'
      this.settleRun(session, runId)
      this.emitStatus(session.hiveSessionId, 'idle')

      log.info('Prompt: completed', {
        worktreePath,
        agentSessionId,
        assistantTextLength: assistantText.length,
        reasoningTextLength: reasoningText.length
      })
    } catch (error) {
      if (!this.isRunCurrent(session, runId)) {
        log.info('Prompt: stale run failed after newer run started, ignoring error', {
          worktreePath,
          agentSessionId,
          runId,
          error: error instanceof Error ? error.message : String(error)
        })
        return
      }

      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error(
        'Prompt streaming error',
        error instanceof Error ? error : new Error(errorMessage),
        { worktreePath, agentSessionId, error: errorMessage }
      )

      session.status = 'error'
      session.liveAssistantDraft = null
      if (this.isRunCurrent(session, runId)) {
        this.settleRun(session, runId)
      }
      emitAgentEvent(this.mainWindow, {
        type: 'session.error',
        sessionId: session.hiveSessionId,
        data: { error: errorMessage }
      })
      this.emitStatus(session.hiveSessionId, 'idle')
    } finally {
      this.manager.removeListener('event', handleEvent)
    }
  }

  async steer(
    worktreePath: string,
    agentSessionId: string,
    message:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'file'; mime: string; url: string; filename?: string }
        >,
    _modelOverride?: { providerID: string; modelID: string; variant?: string },
    _options?: PromptOptions
  ): Promise<void> {
    const key = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(key)
    if (!session) {
      throw new Error(`Steer failed: session not found for ${worktreePath} / ${agentSessionId}`)
    }

    const hasAttachments = Array.isArray(message) && message.some((part) => part.type !== 'text')
    if (hasAttachments) {
      throw new Error('Steer only supports text messages')
    }

    const text =
      typeof message === 'string'
        ? message
        : message
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')

    if (!text.trim()) {
      throw new Error('Steer message cannot be empty')
    }

    const managerSession = this.manager.getSession(session.threadId)
    const activeTurnId = managerSession?.activeTurnId
    if (!activeTurnId) {
      throw new Error('Steer is unavailable because there is no active Codex turn')
    }

    await this.manager.steerTurn(session.threadId, { text }, activeTurnId)

    const syntheticTimestamp = new Date().toISOString()
    session.messages.push({
      role: 'user',
      steered: true,
      parts: [{ type: 'text', text, timestamp: syntheticTimestamp }],
      timestamp: syntheticTimestamp
    })
    this.persistCanonicalMessages(session)
  }

  async abort(worktreePath: string, agentSessionId: string): Promise<boolean> {
    const key = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(key)
    if (!session) {
      log.warn('Abort: session not found', { worktreePath, agentSessionId })
      return false
    }

    const activeRun = session.activeRun
    if (activeRun) {
      activeRun.state = 'aborting'
    }

    const managerSession = this.manager.getSession(session.threadId)
    const expectedTurnId = activeRun?.expectedTurnId ?? managerSession?.activeTurnId ?? null

    if (activeRun) {
      activeRun.interruptRequestedTurnId = expectedTurnId
    }

    try {
      if (expectedTurnId) {
        await this.manager.interruptTurn(session.threadId, expectedTurnId)
      } else {
        await this.manager.interruptTurn(session.threadId)
      }
    } catch (error) {
      log.warn('Abort: interruptTurn failed', {
        worktreePath,
        agentSessionId,
        error: error instanceof Error ? error.message : String(error)
      })
      return false
    }

    if (!activeRun) {
      const materialized = this.materializeLiveAssistantDraft(session, {
        aborted: true,
        terminalizeRunningTools: true,
        emitTerminalTools: true
      })
      if (materialized) {
        this.persistCanonicalMessages(session)
      }
      session.liveAssistantDraft = null
      session.status = 'ready'
      this.emitStatus(session.hiveSessionId, 'idle')
    }

    return true
  }

  async getMessages(
    worktreePath: string,
    agentSessionId: string,
    options?: { forceRefresh?: boolean }
  ): Promise<unknown[]> {
    const key = this.getSessionKey(worktreePath, agentSessionId)
    let session = this.sessions.get(key)
    if (!session) {
      const recoveredSession = await this.recoverSessionForRead(worktreePath, agentSessionId)
      session = recoveredSession ?? undefined
    }

    if (!session) {
      log.warn('getMessages: session not found', { worktreePath, agentSessionId })
      return []
    }

    let fallbackMessages: unknown[] | null = null

    // Return in-memory messages if they contain assistant text. A user-only
    // cache is incomplete after reconnect/abort paths; continue to thread/read
    // so missing Codex replies can be recovered.
    if (session.messages.length > 0) {
      const liveDraftMessage =
        session.status === 'running' ? this.cloneLiveAssistantDraftMessage(session) : null
      const inMemoryMessages = liveDraftMessage
        ? [...session.messages, liveDraftMessage]
        : [...session.messages]
      if (
        !options?.forceRefresh &&
        (hasRenderableAssistantMessage(inMemoryMessages) || session.status === 'running') &&
        !this.shouldRefreshCollapsedTimeline(session, inMemoryMessages)
      ) {
        return inMemoryMessages
      }
      fallbackMessages = inMemoryMessages
    }

    if (session.status === 'running') {
      const liveDraftMessage = this.cloneLiveAssistantDraftMessage(session)
      if (liveDraftMessage) {
        return [liveDraftMessage]
      }
    }

    if (this.dbService) {
      try {
        const persistedMessages = this.dbService.getSessionMessages(session.hiveSessionId)
        if (persistedMessages.length > 0) {
          const parsed = persistedMessages.flatMap((message) => {
            if (!message.opencode_message_json) return []
            try {
              return [JSON.parse(message.opencode_message_json)]
            } catch {
              return []
            }
          })
          if (parsed.length > 0) {
            const sanitized = parsed.map((message) =>
              sanitizeCodexUserMessageForPersistence(message)
            )
            session.messages = sanitized
            if (
              !options?.forceRefresh &&
              (hasRenderableAssistantMessage(sanitized) || session.status === 'closed') &&
              !this.shouldRefreshCollapsedTimeline(session, sanitized)
            ) {
              return [...sanitized]
            }
            fallbackMessages = [...sanitized]
          }
        }
      } catch (error) {
        log.warn('getMessages: failed to load persisted Codex messages', {
          agentSessionId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    // Fallback: try reading from thread via the server
    if (session.status !== 'closed') {
      try {
        const threadSnapshot = await this.manager.readThread(session.threadId)
        const parsed = this.parseThreadSnapshot(threadSnapshot, session.itemTimestampsByTurn)
        this.persistJsonlSupplementalActivities(session, threadSnapshot)
        if (parsed.length > 0) {
          session.messages = parsed
          this.persistCanonicalMessages(session)
          log.info('getMessages: warmed in-memory cache from thread/read', {
            agentSessionId,
            count: parsed.length
          })
          return [...parsed]
        }
      } catch (error) {
        log.warn('getMessages: readThread fallback failed', {
          agentSessionId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    return fallbackMessages ? [...fallbackMessages] : []
  }

  // ── Models ───────────────────────────────────────────────────────

  async getAvailableModels(): Promise<unknown> {
    const configuredContextWindow = getCodexConfiguredContextWindow()
    const providers = getAvailableCodexModels()
    if (!configuredContextWindow) return providers

    return providers.map((provider) => ({
      ...provider,
      models: Object.fromEntries(
        Object.entries(provider.models).map(([id, model]) => [
          id,
          {
            ...model,
            limit: { ...model.limit, context: configuredContextWindow }
          }
        ])
      )
    }))
  }

  async getModelInfo(
    _worktreePath: string,
    modelId: string
  ): Promise<{
    id: string
    name: string
    limit: { context: number; input?: number; output: number }
  } | null> {
    const info = getCodexModelInfo(modelId)
    const configuredContextWindow = getCodexConfiguredContextWindow()
    if (!info || !configuredContextWindow) return info
    return {
      ...info,
      limit: { ...info.limit, context: configuredContextWindow }
    }
  }

  setSelectedModel(model: { providerID: string; modelID: string; variant?: string }): void {
    this.selectedModel = resolveCodexModelSlug(model.modelID)
    this.selectedVariant = model.variant
    log.info('Selected model set', {
      raw: model.modelID,
      resolved: this.selectedModel,
      variant: model.variant
    })
  }

  clearSelectedModel(): void {
    this.selectedModel = resolveCodexModelSlug(getCodexConfiguredModel() ?? CODEX_DEFAULT_MODEL)
    this.selectedVariant = undefined
    log.info('Selected model cleared, reset to default', { model: this.selectedModel })
  }

  // ── Session info ─────────────────────────────────────────────────

  async getSessionInfo(
    worktreePath: string,
    agentSessionId: string
  ): Promise<{
    revertMessageID: string | null
    revertDiff: string | null
  }> {
    const sessionKey = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(sessionKey)
    return {
      revertMessageID: session?.revertMessageID ?? null,
      revertDiff: session?.revertDiff ?? null
    }
  }

  // ── Human-in-the-loop ────────────────────────────────────────────

  async questionReply(
    requestId: string,
    answers: string[][],
    _worktreePath?: string
  ): Promise<void> {
    const pending = this.pendingQuestions.get(requestId)
    if (!pending) {
      throw new Error(`No pending question found for requestId: ${requestId}`)
    }

    // Convert string[][] answers to the format Codex expects
    const codexAnswers = answers.map(([id, answer]) => ({
      id: id ?? requestId,
      answer: answer ?? ''
    }))

    log.info('questionReply: responding to pending question', {
      requestId,
      hiveSessionId: pending.hiveSessionId,
      answerCount: codexAnswers.length
    })

    this.manager.respondToUserInput(pending.threadId, requestId, codexAnswers)
    this.pendingQuestions.delete(requestId)
    const session = this.findSessionByThreadId(pending.threadId)
    if (session) {
      this.persistSyntheticActivity(session, {
        id: `${requestId}:resolved`,
        kind: 'user-input.resolved',
        tone: 'approval',
        summary: 'User input answered',
        requestId,
        turnId: pending.turnId,
        payload: { answers: codexAnswers }
      })
    }

    emitAgentEvent(this.mainWindow, {
      type: 'question.replied',
      sessionId: pending.hiveSessionId,
      data: { requestId, id: requestId }
    })

    // Flip the synthetic AskUserQuestion tool part to completed so the
    // AgentTimeline card transitions from "Waiting for reply" → "Answered".
    const answerSummary = codexAnswers
      .map((a) => a.answer)
      .filter((s) => s.length > 0)
      .join('\n')
    emitAgentEvent(this.mainWindow, {
      type: 'message.part.updated',
      sessionId: pending.hiveSessionId,
      data: {
        part: {
          type: 'tool',
          callID: requestId,
          tool: 'AskUserQuestion',
          state: {
            status: 'completed',
            output: answerSummary
          }
        }
      }
    })

    // Persist tool.completed so the answered question card survives turn
    // sealing and remains in the durable timeline. Pairs with the
    // tool.started activity written when the question was raised.
    if (this.dbService) {
      try {
        this.dbService.upsertSessionActivity({
          id: `${requestId}:answered`,
          session_id: pending.hiveSessionId,
          agent_session_id: pending.threadId,
          thread_id: pending.threadId,
          turn_id: pending.turnId ?? null,
          item_id: requestId,
          request_id: requestId,
          kind: 'tool.completed',
          tone: 'tool',
          summary: 'AskUserQuestion',
          payload_json: JSON.stringify({
            item: {
              type: 'AskUserQuestion',
              toolName: 'AskUserQuestion',
              id: requestId,
              input: { questions: pending.questions ?? [] },
              output: answerSummary
            }
          })
        })
      } catch (err) {
        log.warn('codex questionReply: failed to persist tool.completed', {
          requestId,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  }

  async questionReject(requestId: string, _worktreePath?: string): Promise<void> {
    const pending = this.pendingQuestions.get(requestId)
    if (!pending) {
      throw new Error(`No pending question found for requestId: ${requestId}`)
    }

    log.info('questionReject: rejecting pending question', {
      requestId,
      hiveSessionId: pending.hiveSessionId
    })

    this.manager.rejectUserInput(pending.threadId, requestId)
    this.pendingQuestions.delete(requestId)
    const session = this.findSessionByThreadId(pending.threadId)
    if (session) {
      this.persistSyntheticActivity(session, {
        id: `${requestId}:resolved`,
        kind: 'user-input.resolved',
        tone: 'approval',
        summary: 'User input dismissed',
        requestId,
        turnId: pending.turnId,
        payload: { dismissed: true }
      })
    }

    emitAgentEvent(this.mainWindow, {
      type: 'question.rejected',
      sessionId: pending.hiveSessionId,
      data: { requestId, id: requestId }
    })

    // Flip the synthetic AskUserQuestion tool part to cancelled.
    emitAgentEvent(this.mainWindow, {
      type: 'message.part.updated',
      sessionId: pending.hiveSessionId,
      data: {
        part: {
          type: 'tool',
          callID: requestId,
          tool: 'AskUserQuestion',
          state: { status: 'cancelled' }
        }
      }
    })
  }

  async permissionReply(
    requestId: string,
    decision: 'once' | 'always' | 'reject',
    _worktreePath?: string
  ): Promise<void> {
    const pending = this.pendingApprovalSessions.get(requestId)
    if (!pending) {
      throw new Error(`No pending approval found for requestId: ${requestId}`)
    }

    log.info('permissionReply: responding to pending approval', {
      requestId,
      hiveSessionId: pending.hiveSessionId,
      decision
    })

    this.manager.respondToApproval(pending.threadId, requestId, decision)
    this.pendingApprovalSessions.delete(requestId)
    const session = this.findSessionByThreadId(pending.threadId)
    if (session) {
      this.persistSyntheticActivity(session, {
        id: `${requestId}:resolved`,
        kind: 'approval.resolved',
        tone: 'approval',
        summary: 'Approval resolved',
        requestId,
        turnId: pending.turnId,
        payload: { decision }
      })
    }

    emitAgentEvent(this.mainWindow, {
      type: 'permission.replied',
      sessionId: pending.hiveSessionId,
      data: { requestId, id: requestId, decision }
    })
  }

  async permissionList(_worktreePath?: string): Promise<unknown[]> {
    // Aggregate pending approvals across all sessions
    const result: unknown[] = []
    for (const session of this.sessions.values()) {
      const approvals = this.manager.getPendingApprovals(session.threadId)
      for (const approval of approvals) {
        const payload = asObject(approval.payload)
        result.push({
          ...this.toPermissionRequest(
            approval.requestId,
            session.hiveSessionId,
            approval.method,
            payload,
            approval.turnId,
            approval.itemId
          )
        })
      }
    }
    return result
  }

  private toPermissionRequest(
    requestId: string,
    hiveSessionId: string,
    method: string,
    payload: Record<string, unknown> | undefined,
    turnId?: string,
    itemId?: string
  ): CodexPermissionRequest {
    const permission = this.permissionFromApprovalMethod(method)
    const patterns = this.patternsFromApprovalPayload(method, payload)

    return {
      id: requestId,
      sessionID: hiveSessionId,
      permission,
      patterns,
      metadata: {
        method,
        ...(payload ? { payload } : {}),
        ...(turnId ? { turnId } : {}),
        ...(itemId ? { itemId } : {})
      },
      always: []
    }
  }

  private permissionFromApprovalMethod(method: string): string {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return 'bash'
      case 'item/fileRead/requestApproval':
        return 'read'
      case 'item/fileChange/requestApproval':
        return 'edit'
      default:
        return 'unknown'
    }
  }

  private patternsFromApprovalPayload(
    method: string,
    payload: Record<string, unknown> | undefined
  ): string[] {
    if (!payload) return []

    if (method === 'item/commandExecution/requestApproval') {
      const command = asString(payload.command)
      return command ? [command] : []
    }

    const filePath =
      asString(payload.path) ?? asString(payload.filePath) ?? asString(payload.target)
    return filePath ? [filePath] : []
  }

  /** Check if a question requestId belongs to this implementer */
  hasPendingQuestion(requestId: string): boolean {
    return this.pendingQuestions.has(requestId)
  }

  /** Check if a permission requestId belongs to this implementer */
  hasPendingApproval(requestId: string): boolean {
    return this.pendingApprovalSessions.has(requestId)
  }

  // ── Undo/Redo ────────────────────────────────────────────────────

  async undo(
    worktreePath: string,
    agentSessionId: string,
    _hiveSessionId: string
  ): Promise<{ revertMessageID: string; restoredPrompt: string; revertDiff: string | null }> {
    const sessionKey = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(sessionKey)
    if (!session) {
      throw new Error(`Undo failed: session not found for ${worktreePath} / ${agentSessionId}`)
    }

    if (session.messages.length === 0) {
      throw new Error('Nothing to undo')
    }

    // Rollback 1 turn via the Codex server
    const snapshot = await this.manager.rollbackThread(session.threadId, 1)

    // Try to extract the last user prompt from in-memory messages
    const restoredPrompt = this.extractLastUserPrompt(session)

    // Pop the last exchange (assistant + user) from in-memory messages
    // Find the last user message boundary
    const revertMessageID = this.popLastExchange(session)

    // Store revert state
    session.revertMessageID = revertMessageID
    session.revertDiff = null

    // Emit session info update to renderer
    emitAgentEvent(this.mainWindow, {
      type: 'session.updated',
      sessionId: session.hiveSessionId,
      data: { revertMessageID }
    })

    log.info('Undo completed', {
      worktreePath,
      agentSessionId,
      revertMessageID,
      restoredPrompt: restoredPrompt.slice(0, 50),
      snapshotReceived: !!snapshot
    })

    return { revertMessageID, restoredPrompt, revertDiff: null }
  }

  async redo(
    _worktreePath: string,
    _agentSessionId: string,
    _hiveSessionId: string
  ): Promise<unknown> {
    throw new Error('Redo is not supported for Codex sessions')
  }

  // ── Commands ─────────────────────────────────────────────────────

  async listCommands(worktreePath: string): Promise<unknown[]> {
    const session = this.findSessionByWorktreePath(worktreePath)
    if (!session) return []

    try {
      const response = await this.manager.listSkills(session.threadId, worktreePath)
      const skillCommands = this.mapSkillsListResponseToCommands(response, worktreePath)
      this.cacheSkillCommandsForWorktree(worktreePath, skillCommands)
      return skillCommands
    } catch (error) {
      log.warn('Codex skills/list failed; slash command picker will omit skills', {
        worktreePath,
        error: error instanceof Error ? error.message : String(error)
      })
      this.clearSkillCommandsForWorktree(worktreePath)
      return []
    }
  }

  async sendCommand(
    worktreePath: string,
    agentSessionId: string,
    command: string,
    args?: string
  ): Promise<void> {
    const session = this.getSession(worktreePath, agentSessionId)
    if (!session) {
      throw new Error(`No Codex session found for ${agentSessionId}`)
    }

    const normalizedCommand = command.trim().replace(/^\//, '').toLowerCase()
    const skill =
      this.findCachedSkillCommand(worktreePath, agentSessionId, normalizedCommand) ??
      (await this.refreshAndFindSkillCommand(worktreePath, agentSessionId, normalizedCommand))
    if (!skill) {
      throw new Error(`Unsupported Codex command: /${normalizedCommand || command}`)
    }

    const trimmedArgs = (args ?? '').trim()
    const turnInput: Array<Record<string, unknown>> = [this.createCodexSkillInput(skill)]
    if (trimmedArgs) {
      turnInput.push({ type: 'text', text: trimmedArgs, text_elements: [] })
    }
    const displayText = `/${skill.name}${trimmedArgs ? ` ${trimmedArgs}` : ''}`
    const model = resolveCodexModelSlug(this.selectedModel)
    const activeRun = this.beginCodexRun(session)
    const runId = activeRun.runId
    let turnCompleted = false

    beginSessionRun(session.hiveSessionId)

    const syntheticTimestamp = new Date().toISOString()
    session.messages.push({
      id: `client:${runId}:user`,
      role: 'user',
      parts: [{ type: 'text', text: displayText, timestamp: syntheticTimestamp }],
      timestamp: syntheticTimestamp
    })
    this.persistCanonicalMessages(session)
    this.resetLiveAssistantDraft(session)

    session.status = 'running'
    this.emitStatus(session.hiveSessionId, 'busy')

    const handleEvent = (event: CodexManagerEvent) => {
      if (!this.eventMatchesActiveRun(session, runId, event)) return
      this.bindActiveRunTurnId(session, runId, event)

      const streamEvents = mapCodexEventToStreamEvents(
        event,
        session.hiveSessionId,
        session.mapperState
      )
      for (const streamEvent of streamEvents) {
        if (
          (event.method === 'turn/completed' || event.method === 'thread/status/changed') &&
          streamEvent.type === 'session.status' &&
          streamEvent.statusPayload?.type === 'idle'
        ) {
          continue
        }
        emitAgentEvent(this.mainWindow, asRawAgentEvent(streamEvent))
        this.updateLiveAssistantDraftFromStreamEvent(session, streamEvent)
      }

      if (event.method === 'turn/completed' || event.method === 'turn/interrupted') {
        turnCompleted = true
      }
    }

    this.manager.on('event', handleEvent)

    try {
      const turnStart = await this.manager.sendTurn(session.threadId, {
        input: turnInput,
        model
      })

      if (!this.isRunCurrent(session, runId)) {
        log.info('sendCommand: stale run finished after a newer run started', {
          worktreePath,
          agentSessionId,
          runId,
          activeRunId: session.activeRun?.runId ?? null
        })
        return
      }

      activeRun.expectedTurnId = turnStart.turnId || activeRun.expectedTurnId || null
      if (activeRun.state !== 'aborting') {
        activeRun.state = 'running'
      }

      const completionState = await this.waitForTurnCompletion(session, {
        runId,
        expectedTurnId: activeRun.expectedTurnId,
        isComplete: () => turnCompleted,
        signal: activeRun.abortController.signal
      })

      if (!this.isRunCurrent(session, runId)) {
        log.info('sendCommand: stale run finished after wait', {
          worktreePath,
          agentSessionId,
          runId,
          activeRunId: session.activeRun?.runId ?? null
        })
        return
      }

      if (completionState === 'interrupted') {
        activeRun.state = 'finalizing'
        this.materializeLiveAssistantDraft(session, {
          aborted: true,
          terminalizeRunningTools: true,
          emitTerminalTools: true
        })
        this.persistCanonicalMessages(session)
        session.liveAssistantDraft = null
        session.status = 'ready'
        this.settleRun(session, runId)
        this.emitStatus(session.hiveSessionId, 'idle')
        return
      }

      try {
        activeRun.state = 'finalizing'
        const threadSnapshot = await this.manager.readThread(session.threadId)
        if (!this.isRunCurrent(session, runId)) return

        const parsed = this.parseThreadSnapshot(threadSnapshot, session.itemTimestampsByTurn)
        this.persistJsonlSupplementalActivities(session, threadSnapshot)
        if (parsed.length > 0 && this.parsedMessagesContainUserText(parsed, [displayText])) {
          session.messages = parsed
          session.liveAssistantDraft = null
        } else {
          this.materializeLiveAssistantDraft(session)
        }
      } catch (readError) {
        log.warn('sendCommand: readThread after skill turn failed, falling back to live draft', {
          agentSessionId,
          error: readError instanceof Error ? readError.message : String(readError)
        })
        this.materializeLiveAssistantDraft(session)
      }

      this.persistCanonicalMessages(session)
      session.liveAssistantDraft = null
      session.status = 'ready'
      this.settleRun(session, runId)
      this.emitStatus(session.hiveSessionId, 'idle')
    } catch (error) {
      if (!this.isRunCurrent(session, runId)) {
        log.info('sendCommand: stale run failed after newer run started, ignoring error', {
          worktreePath,
          agentSessionId,
          runId,
          error: error instanceof Error ? error.message : String(error)
        })
        return
      }

      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error(
        'Codex skill command error',
        error instanceof Error ? error : new Error(errorMessage),
        { worktreePath, agentSessionId, command, error: errorMessage }
      )
      session.status = 'error'
      session.liveAssistantDraft = null
      this.settleRun(session, runId)
      emitAgentEvent(this.mainWindow, {
        type: 'session.error',
        sessionId: session.hiveSessionId,
        data: { error: errorMessage }
      })
      this.emitStatus(session.hiveSessionId, 'idle')
    } finally {
      this.manager.removeListener('event', handleEvent)
    }
  }

  private findCachedSkillCommand(
    worktreePath: string,
    agentSessionId: string,
    commandName: string
  ): CodexSkillCommand | undefined {
    return this.skillCommandsBySessionKey
      .get(this.getSessionKey(worktreePath, agentSessionId))
      ?.find((skill) => skill.name.toLowerCase() === commandName.toLowerCase())
  }

  private async refreshAndFindSkillCommand(
    worktreePath: string,
    agentSessionId: string,
    commandName: string
  ): Promise<CodexSkillCommand | undefined> {
    try {
      const response = await this.manager.listSkills(agentSessionId, worktreePath)
      const skillCommands = this.mapSkillsListResponseToCommands(response, worktreePath)
      this.cacheSkillCommandsForWorktree(worktreePath, skillCommands)
      return this.findCachedSkillCommand(worktreePath, agentSessionId, commandName)
    } catch (error) {
      log.warn('Codex skills/list refresh failed before command dispatch', {
        worktreePath,
        agentSessionId,
        commandName,
        error: error instanceof Error ? error.message : String(error)
      })
      return undefined
    }
  }

  private cacheSkillCommandsForWorktree(
    worktreePath: string,
    skillCommands: CodexSkillCommand[]
  ): void {
    let matched = false
    for (const session of this.sessions.values()) {
      if (session.worktreePath !== worktreePath) continue
      this.skillCommandsBySessionKey.set(
        this.getSessionKey(worktreePath, session.threadId),
        skillCommands
      )
      matched = true
    }

    if (!matched) {
      this.skillCommandsBySessionKey.set(
        this.getSessionKey(worktreePath, worktreePath),
        skillCommands
      )
    }
  }

  private clearSkillCommandsForWorktree(worktreePath: string): void {
    for (const key of this.skillCommandsBySessionKey.keys()) {
      if (key.startsWith(`${worktreePath}::`)) {
        this.skillCommandsBySessionKey.delete(key)
      }
    }
  }

  private mapSkillsListResponseToCommands(
    response: unknown,
    worktreePath: string
  ): CodexSkillCommand[] {
    const responseObj = asObject(response)
    const dataEntries = Array.isArray(responseObj?.data) ? responseObj.data : []

    if (dataEntries.length > 0) {
      for (const entry of dataEntries) {
        const entryObj = asObject(entry)
        const errors = Array.isArray(entryObj?.errors) ? entryObj.errors : []
        for (const error of errors) {
          log.warn('skills/list returned cwd error', {
            cwd: asString(entryObj?.cwd),
            error: toDebugSnapshot(error, 500)
          })
        }
      }

      const exactEntry = dataEntries.find(
        (entry) => asString(asObject(entry)?.cwd) === worktreePath
      )
      const skills = exactEntry
        ? (asObject(exactEntry)?.skills as unknown)
        : dataEntries.flatMap((entry) => {
            const skillsForEntry = asObject(entry)?.skills
            return Array.isArray(skillsForEntry) ? skillsForEntry : []
          })

      if (!exactEntry) {
        log.warn('skills/list did not return exact cwd match; flattening all skills', {
          worktreePath,
          returnedCwds: dataEntries.map((entry) => asString(asObject(entry)?.cwd)).filter(Boolean)
        })
      }

      return (Array.isArray(skills) ? skills : []).flatMap((skill) => {
        const command = this.mapSkillMetadataToCommand(skill)
        return command ? [command] : []
      })
    }

    const legacySkills = Array.isArray(responseObj?.skills)
      ? responseObj.skills
      : Array.isArray(response)
        ? response
        : []

    return legacySkills.flatMap((skill) => {
      const command = this.mapSkillMetadataToCommand(skill)
      return command ? [command] : []
    })
  }

  private mapSkillMetadataToCommand(skill: unknown): CodexSkillCommand | null {
    const obj = asObject(skill)
    if (!obj) return null

    const enabled = obj.enabled
    if (enabled === false) return null

    const name =
      asString(obj.name)?.trim() ??
      asString(obj.id)?.trim() ??
      asString(obj.skill)?.trim() ??
      asString(obj.title)?.trim().replace(/\s+/g, '-').toLowerCase()
    const path = asString(obj.path)?.trim() ?? asString(obj.file)?.trim()
    if (!name || !path) {
      log.debug('Skipping invalid Codex skill metadata', {
        name,
        hasPath: Boolean(path)
      })
      return null
    }

    const interfaceObj = asObject(obj.interface)
    const defaultPrompt = asString(interfaceObj?.defaultPrompt)?.trim()
    const scope = asString(obj.scope)
    const command: CodexSkillCommand = {
      name,
      description:
        asString(interfaceObj?.shortDescription) ??
        asString(obj.shortDescription) ??
        asString(obj.description) ??
        asString(obj.summary) ??
        'Codex skill',
      template: defaultPrompt ? `/${name} ${defaultPrompt} ` : `/${name} `,
      source: 'skill',
      agent: 'codex',
      path,
      enabled: true
    }
    if (scope === 'user' || scope === 'repo' || scope === 'system' || scope === 'admin') {
      command.scope = scope
    }
    return command
  }

  private createCodexSkillInput(skill: CodexSkillCommand): CodexSkillInputPart {
    return {
      type: 'skill',
      name: skill.name,
      path: skill.path
    }
  }

  // ── Session management ───────────────────────────────────────────

  async renameSession(_worktreePath: string, agentSessionId: string, name: string): Promise<void> {
    // Codex has no server-side rename — just update Hive's local DB
    if (!this.dbService) {
      log.warn('renameSession: no dbService available', { agentSessionId })
      return
    }

    // Find hive session by matching agentSessionId (threadId)
    const sessionKey = this.findSessionKeyByAgentId(agentSessionId)
    if (sessionKey) {
      const session = this.sessions.get(sessionKey)
      if (session?.hiveSessionId) {
        try {
          this.dbService.updateSession(session.hiveSessionId, { name })
          log.info('renameSession: updated title in DB', {
            hiveSessionId: session.hiveSessionId,
            name
          })
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          log.error('renameSession: failed to update title', error, {
            hiveSessionId: session.hiveSessionId
          })
        }
      }
    } else {
      log.warn('renameSession: session not found in active map', { agentSessionId })
    }
  }

  // ── Internal helpers (exposed for testing) ───────────────────────

  /** @internal */
  getSelectedModel(): string {
    return this.selectedModel
  }

  /** @internal */
  getSelectedVariant(): string | undefined {
    return this.selectedVariant
  }

  /** @internal */
  getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }

  /** @internal */
  getManager(): CodexAppServerManager {
    return this.manager
  }

  /** @internal */
  getSessions(): Map<string, CodexSessionState> {
    return this.sessions
  }

  /** @internal */
  getPendingQuestions(): Map<string, PendingHitlEntry> {
    return this.pendingQuestions
  }

  /** @internal */
  getPendingApprovalSessions(): Map<string, PendingHitlEntry> {
    return this.pendingApprovalSessions
  }

  // ── Private helpers ──────────────────────────────────────────────

  private cleanupPendingForThread(threadId: string): void {
    for (const [reqId, entry] of this.pendingQuestions.entries()) {
      if (entry.threadId === threadId) {
        this.pendingQuestions.delete(reqId)
      }
    }
    for (const [reqId, entry] of this.pendingApprovalSessions.entries()) {
      if (entry.threadId === threadId) {
        this.pendingApprovalSessions.delete(reqId)
      }
    }
  }

  /**
   * Hydrate token usage on reconnect by reading the session JSONL file.
   *
   * thread/read does NOT include tokenUsage data, but the JSONL session
   * file contains event_msg entries with type "token_count" that carry
   * full cumulative token data.  We read the file, find the LAST
   * token_count event, and emit a session.context_usage event.
   */
  private async hydrateTokenUsageFromThread(session: CodexSessionState): Promise<void> {
    try {
      // 1. Get the JSONL path from thread/read
      const snapshot = await this.manager.readThread(session.threadId)
      const obj = asObject(snapshot)
      const threadObj = asObject(obj?.thread) ?? obj
      const jsonlPath = asString(threadObj?.path)
      if (!jsonlPath) {
        log.debug('hydrateTokenUsage: no path in thread/read response')
        return
      }

      // 2. Read the JSONL file and find the last token_count event
      const { readFile } = await import('node:fs/promises')
      const content = await readFile(jsonlPath, 'utf-8')
      const lines = content.split('\n').filter((l) => l.trim())

      let lastTokenCount: Record<string, unknown> | undefined
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]) as Record<string, unknown>
          const msg = asObject(entry.payload) ?? asObject(entry.msg)
          if (msg?.type === 'token_count') {
            lastTokenCount = asObject(msg.info)
            break
          }
        } catch {
          continue
        }
      }

      if (!lastTokenCount) {
        log.debug('hydrateTokenUsage: no token_count in JSONL')
        return
      }

      // 3. Extract token data (snake_case fields from JSONL).  The renderer
      // uses cumulative tokens for session/worktree totals, while the context
      // bar uses the last prompt's input size as current window occupancy.
      const lastUsage = asObject(lastTokenCount.last_token_usage)
      const totalUsage = asObject(lastTokenCount.total_token_usage) ?? lastUsage
      if (!lastUsage) return

      const lastInputTokens = asNumber(lastUsage.input_tokens) ?? 0
      const totalInputTokens = asNumber(totalUsage?.input_tokens) ?? lastInputTokens
      const totalCachedInputTokens =
        asNumber(totalUsage?.cached_input_tokens) ?? asNumber(lastUsage.cached_input_tokens) ?? 0
      const totalOutputTokens =
        asNumber(totalUsage?.output_tokens) ?? asNumber(lastUsage.output_tokens) ?? 0
      const totalReasoningTokens =
        asNumber(totalUsage?.reasoning_output_tokens) ??
        asNumber(lastUsage.reasoning_output_tokens) ??
        0
      if (totalInputTokens === 0 && totalOutputTokens === 0) return

      const modelID = resolveCodexModelSlug(this.selectedModel)
      const contextWindow = this.resolveContextWindow(
        asNumber(lastTokenCount.model_context_window),
        modelID
      )
      emitAgentEvent(this.mainWindow, {
        type: 'session.context_usage',
        sessionId: session.hiveSessionId,
        data: {
          tokens: {
            input: Math.max(0, totalInputTokens - totalCachedInputTokens),
            cacheRead: totalCachedInputTokens,
            cacheWrite: 0,
            output: totalOutputTokens,
            reasoning: totalReasoningTokens
          },
          model: { providerID: 'codex', modelID },
          contextWindow,
          breakdown: {
            usedTokens: lastInputTokens,
            maxTokens: contextWindow,
            percentage: contextWindow > 0 ? (lastInputTokens / contextWindow) * 100 : 0
          }
        }
      })

      log.info('hydrateTokenUsage: emitted context_usage from JSONL', {
        hiveSessionId: session.hiveSessionId,
        inputTokens: totalInputTokens,
        contextWindow,
        modelID
      })
    } catch (error) {
      log.debug('hydrateTokenUsage: failed', {
        hiveSessionId: session.hiveSessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private findSessionByThreadId(threadId: string): CodexSessionState | undefined {
    for (const session of this.sessions.values()) {
      if (session.threadId === threadId) {
        return session
      }
    }
    return undefined
  }

  private findSessionByWorktreePath(worktreePath: string): CodexSessionState | undefined {
    for (const session of this.sessions.values()) {
      if (session.worktreePath === worktreePath) {
        return session
      }
    }
    return undefined
  }

  private getSession(worktreePath: string, agentSessionId: string): CodexSessionState | undefined {
    return this.sessions.get(this.getSessionKey(worktreePath, agentSessionId))
  }

  private getSessionKey(worktreePath: string, agentSessionId: string): string {
    return `${worktreePath}::${agentSessionId}`
  }

  private sendCommandsAvailable(session: CodexSessionState): void {
    emitAgentEvent(this.mainWindow, {
      type: 'session.commands_available',
      sessionId: session.hiveSessionId,
      data: {}
    })
  }

  private sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    } else {
      log.debug('sendToRenderer: no window (headless)')
    }
  }

  private persistActivity(session: CodexSessionState, event: CodexManagerEvent): void {
    if (!this.dbService) return

    const activity = mapCodexManagerEventToActivity(session.hiveSessionId, session.threadId, event)
    if (!activity) return

    try {
      this.dbService.upsertSessionActivity(activity)
    } catch (error) {
      log.warn('Failed to persist Codex activity', {
        hiveSessionId: session.hiveSessionId,
        method: event.method,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private persistSyntheticActivity(
    session: CodexSessionState,
    params: {
      id: string
      kind:
        | 'approval.resolved'
        | 'user-input.resolved'
        | 'plan.ready'
        | 'plan.resolved'
        | 'session.error'
        | 'session.info'
      tone: 'approval' | 'info' | 'error'
      summary: string
      requestId?: string
      turnId?: string
      payload?: unknown
    }
  ): void {
    if (!this.dbService) return

    try {
      this.dbService.upsertSessionActivity({
        id: params.id,
        session_id: session.hiveSessionId,
        agent_session_id: session.threadId,
        thread_id: session.threadId,
        turn_id: params.turnId ?? null,
        request_id: params.requestId ?? null,
        kind: params.kind,
        tone: params.tone,
        summary: params.summary,
        payload_json: params.payload ? JSON.stringify(params.payload) : null
      })
    } catch (error) {
      log.warn('Failed to persist synthetic Codex activity', {
        hiveSessionId: session.hiveSessionId,
        kind: params.kind,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private persistCanonicalMessages(session: CodexSessionState): void {
    if (!this.dbService) return

    try {
      const rows: Array<SessionMessageCreate & { created_at: string }> = session.messages.flatMap(
        (message) => {
          const sanitizedMessage = sanitizeCodexUserMessageForPersistence(message)
          const record = asObject(sanitizedMessage)
          if (!record) return []

          const role = asString(record.role)
          const timestamp = asString(record.timestamp) ?? new Date().toISOString()
          if (role !== 'user' && role !== 'assistant' && role !== 'system') return []

          const parts = Array.isArray(record.parts) ? record.parts : []
          const textContent = parts
            .map((part) => asObject(part))
            .filter((part) => part?.type === 'text' || part?.type === 'reasoning')
            .map((part) => asString(part?.text) ?? '')
            .join('')

          return [
            {
              session_id: session.hiveSessionId,
              role,
              content: textContent,
              opencode_message_id: asString(record.id) ?? null,
              opencode_message_json: JSON.stringify(sanitizedMessage),
              opencode_parts_json: JSON.stringify(parts),
              created_at: timestamp
            }
          ]
        }
      )

      this.dbService.replaceSessionMessages(
        session.hiveSessionId,
        normalizeCodexMessageTimestamps(rows)
      )
    } catch (error) {
      log.warn('Failed to persist Codex canonical messages', {
        hiveSessionId: session.hiveSessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private mapProviderStatus(
    status: 'connecting' | 'ready' | 'running' | 'error' | 'closed'
  ): CodexSessionState['status'] {
    return status
  }

  private statusToHive(status: CodexSessionState['status']): 'idle' | 'busy' | 'retry' {
    if (status === 'running') return 'busy'
    return 'idle'
  }

  private emitStatus(
    hiveSessionId: string,
    status: 'idle' | 'busy' | 'retry',
    extra?: { attempt?: number; message?: string; next?: number }
  ): void {
    const statusPayload: AgentStatusPayload = { type: status, ...extra }
    emitAgentEvent(this.mainWindow, {
      type: 'session.status',
      sessionId: hiveSessionId,
      data: { status: statusPayload },
      statusPayload
    } as RawAgentEvent)
  }

  private beginCodexRun(session: CodexSessionState): CodexActiveRun {
    const previousRun = session.activeRun
    if (previousRun && previousRun.state !== 'settled') {
      previousRun.abortController.abort()
      session.settledRunIds?.add(previousRun.runId)
    }

    const activeRun: CodexActiveRun = {
      runId: randomUUID(),
      expectedTurnId: null,
      state: 'starting',
      startedAt: Date.now(),
      abortController: new AbortController()
    }
    session.activeRun = activeRun
    session.settledRunIds ??= new Set()
    return activeRun
  }

  private isRunCurrent(session: CodexSessionState, runId: string): boolean {
    return session.activeRun?.runId === runId
  }

  private settleRun(session: CodexSessionState, runId: string): void {
    session.settledRunIds ??= new Set()
    session.settledRunIds.add(runId)
    if (session.activeRun?.runId === runId) {
      session.activeRun.state = 'settled'
      session.activeRun = null
    }
  }

  private extractEventTurnId(event: CodexManagerEvent): string | undefined {
    const payload = asObject(event.payload)
    return event.turnId ?? asString(payload?.turnId) ?? asString(asObject(payload?.turn)?.id)
  }

  private recordCodexItemTimelineTimestamp(
    session: CodexSessionState,
    event: CodexManagerEvent
  ): void {
    if (event.kind !== 'notification') return

    const method = event.method
    const isStarted = method === 'item/started' || method === 'item.started'
    const isCompleted = method === 'item/completed' || method === 'item.completed'
    if (!isStarted && !isCompleted) return

    const payload = asObject(event.payload)
    const item = asObject(payload?.item)
    if (!item) return

    const turnId = this.extractEventTurnId(event)
    if (!turnId) return

    const itemType = asString(item.type)
    session.itemTimestampsByTurn ??= new Map()

    const itemId =
      asString(item.id) ??
      event.itemId ??
      `${method}:${turnId}:${session.itemTimestampsByTurn.get(turnId)?.length ?? 0}`
    const isTool = isCodexToolItemType(itemType)

    // Record one timestamp per turn item, matching the order `thread/read`
    // later exposes. Tool items are anchored at start; text/reasoning items
    // only become useful once completed and carrying their final content.
    if ((isTool && !isStarted) || (!isTool && !isCompleted)) return

    const seenByTurn =
      session.recordedItemIdsByTurn ??
      (session.recordedItemIdsByTurn = new Map<string, Set<string>>())
    const seen = seenByTurn.get(turnId) ?? new Set<string>()
    if (seen.has(itemId)) return

    const list =
      session.itemTimestampsByTurn.get(turnId) ??
      (session.itemTimestampsByTurn.set(turnId, []), session.itemTimestampsByTurn.get(turnId)!)
    list.push(
      eventTimestampFromPayload(payload ?? null) ?? event.createdAt ?? new Date().toISOString()
    )
    seen.add(itemId)
    seenByTurn.set(turnId, seen)
  }

  private eventMatchesActiveRun(
    session: CodexSessionState,
    runId: string,
    event: CodexManagerEvent
  ): boolean {
    if (event.threadId !== session.threadId) return false
    const activeRun = session.activeRun
    if (!activeRun || activeRun.runId !== runId) return false

    const expectedTurnId = activeRun.expectedTurnId
    const eventTurnId = this.extractEventTurnId(event)
    if (!expectedTurnId && eventTurnId) {
      if (event.method === 'turn/started') return true
      const managerTurnId = this.manager.getSession(session.threadId)?.activeTurnId
      return managerTurnId === eventTurnId
    }
    if (expectedTurnId && eventTurnId && eventTurnId !== expectedTurnId) {
      return false
    }
    return true
  }

  private bindActiveRunTurnId(
    session: CodexSessionState,
    runId: string,
    event: CodexManagerEvent
  ): void {
    const activeRun = session.activeRun
    if (!activeRun || activeRun.runId !== runId || activeRun.expectedTurnId) return

    const eventTurnId = this.extractEventTurnId(event)
    if (eventTurnId) {
      activeRun.expectedTurnId = eventTurnId
    }
  }

  private parsedMessagesContainUserText(messages: unknown[], candidates: string[]): boolean {
    const targets = candidates.map((candidate) => candidate.trim()).filter(Boolean)
    if (targets.length === 0) return true

    for (const message of messages) {
      const record = asObject(message)
      if (record?.role !== 'user') continue
      const parts = Array.isArray(record.parts) ? record.parts : []
      const text = parts
        .map((part) => asObject(part))
        .filter((part) => part?.type === 'text')
        .map((part) => asString(part?.text) ?? '')
        .join('\n')
        .trim()
      if (!text) continue
      if (
        targets.some((target) => text === target || text.includes(target) || target.includes(text))
      ) {
        return true
      }
    }
    return false
  }

  private shouldRefreshCollapsedTimeline(session: CodexSessionState, messages: unknown[]): boolean {
    if (!this.dbService || session.status === 'running' || session.status === 'closed') return false

    try {
      const activities = this.dbService.getSessionActivities(session.hiveSessionId)
      return hasCollapsedCodexMessageTimeline(messages, activities)
    } catch {
      return false
    }
  }

  private resetLiveAssistantDraft(session: CodexSessionState): void {
    session.liveAssistantDraft = {
      id: `codex-live-${session.threadId}`,
      timestamp: new Date().toISOString(),
      parts: [],
      toolIndexById: new Map()
    }
  }

  private ensureLiveAssistantDraft(session: CodexSessionState): CodexLiveAssistantDraft {
    if (!session.liveAssistantDraft) {
      this.resetLiveAssistantDraft(session)
    }
    return session.liveAssistantDraft!
  }

  private appendLiveAssistantText(
    session: CodexSessionState,
    kind: 'text' | 'reasoning',
    text: string
  ): void {
    if (!text) return

    const draft = this.ensureLiveAssistantDraft(session)
    const lastPart = draft.parts[draft.parts.length - 1]
    const timestamp = new Date().toISOString()

    if (lastPart && lastPart.type === kind) {
      lastPart.text += text
      return
    }

    draft.parts.push({ type: kind, text, timestamp })
  }

  private upsertLiveAssistantTool(
    session: CodexSessionState,
    tool: {
      callID: string
      tool: string
      state: {
        status: 'running' | 'completed' | 'error' | 'cancelled'
        input?: unknown
        output?: unknown
        error?: unknown
        metadata?: Record<string, unknown>
        time?: { start?: number; end?: number }
      }
    }
  ): void {
    if (!tool.callID) return

    const draft = this.ensureLiveAssistantDraft(session)
    const existingIndex = draft.toolIndexById.get(tool.callID)

    if (existingIndex !== undefined) {
      const existing = draft.parts[existingIndex]
      if (existing && existing.type === 'tool') {
        existing.tool = tool.tool || existing.tool
        existing.state = {
          ...existing.state,
          ...tool.state,
          ...(tool.state.input === undefined ? { input: existing.state.input } : {}),
          ...(tool.state.output === undefined ? { output: existing.state.output } : {}),
          ...(tool.state.error === undefined ? { error: existing.state.error } : {})
        }
      }
      return
    }

    draft.toolIndexById.set(tool.callID, draft.parts.length)
    draft.parts.push({
      type: 'tool',
      callID: tool.callID,
      tool: tool.tool,
      state: tool.state
    })
  }

  private updateLiveAssistantDraftFromStreamEvent(
    session: CodexSessionState,
    streamEvent: { type?: string; data?: unknown }
  ): void {
    if (streamEvent.type !== 'message.part.updated') return

    const data = asObject(streamEvent.data)
    const part = asObject(data?.part)
    if (!part) return

    const partType = asString(part.type)
    if (partType === 'text') {
      const delta = asString(data?.delta) ?? asString(part.text) ?? ''
      this.appendLiveAssistantText(session, 'text', delta)
      return
    }

    if (partType === 'reasoning') {
      const delta = asString(data?.delta) ?? asString(part.text) ?? ''
      this.appendLiveAssistantText(session, 'reasoning', delta)
      return
    }

    if (partType === 'tool') {
      const state = asObject(part.state)
      const statusValue = asString(state?.status)
      const status =
        statusValue === 'completed' || statusValue === 'error' || statusValue === 'cancelled'
          ? statusValue
          : 'running'

      this.upsertLiveAssistantTool(session, {
        callID: asString(part.callID) ?? asString(part.id) ?? '',
        tool: asString(part.tool) ?? 'unknown',
        state: {
          status,
          ...(state?.input !== undefined ? { input: state.input } : {}),
          ...(state?.output !== undefined ? { output: state.output } : {}),
          ...(state?.error !== undefined ? { error: state.error } : {})
        }
      })
    }
  }

  private cloneLiveAssistantDraftMessage(
    session: CodexSessionState,
    options?: { aborted?: boolean; terminalizeRunningTools?: boolean }
  ): unknown | null {
    const draft = session.liveAssistantDraft
    if (!draft || draft.parts.length === 0) return null

    const now = Date.now()

    return {
      id: draft.id,
      role: 'assistant',
      parts: draft.parts.map((part) => {
        if (part.type === 'text' || part.type === 'reasoning') {
          return { ...part }
        }

        return {
          type: 'tool',
          callID: part.callID,
          tool: part.tool,
          state:
            options?.terminalizeRunningTools && part.state.status === 'running'
              ? {
                  ...part.state,
                  status: 'cancelled',
                  metadata: { ...(part.state.metadata ?? {}), aborted: true },
                  time: { ...(part.state.time ?? {}), end: now }
                }
              : { ...part.state }
        }
      }),
      timestamp: draft.timestamp,
      ...(options?.aborted ? { aborted: true } : {})
    }
  }

  private materializeLiveAssistantDraft(
    session: CodexSessionState,
    options?: { aborted?: boolean; terminalizeRunningTools?: boolean; emitTerminalTools?: boolean }
  ): boolean {
    const message = this.cloneLiveAssistantDraftMessage(session, options)
    if (!message) return false

    const messageId = asString(asObject(message)?.id)
    const existingIndex = messageId
      ? session.messages.findIndex((candidate) => asString(asObject(candidate)?.id) === messageId)
      : -1

    if (existingIndex >= 0) {
      session.messages[existingIndex] = message
    } else {
      session.messages.push(message)
    }

    if (options?.emitTerminalTools) {
      const parts = asObject(message)?.parts
      if (Array.isArray(parts)) {
        for (const part of parts) {
          const record = asObject(part)
          const state = asObject(record?.state)
          if (record?.type !== 'tool' || state?.status !== 'cancelled') continue
          emitAgentEvent(this.mainWindow, {
            type: 'message.part.updated',
            sessionId: session.hiveSessionId,
            data: { part }
          })
        }
      }
    }

    return true
  }

  private waitForTurnCompletion(
    session: CodexSessionState,
    params: {
      runId: string
      expectedTurnId?: string | null
      isComplete: () => boolean
      signal?: AbortSignal
      timeoutMs?: number
    }
  ): Promise<'completed' | 'interrupted'> {
    const { runId, expectedTurnId = null, isComplete, signal, timeoutMs = 300_000 } = params

    if (expectedTurnId && session.activeRun?.runId === runId) {
      session.activeRun.expectedTurnId = expectedTurnId
    }

    if (isComplete()) return Promise.resolve('completed')
    if (signal?.aborted) return Promise.resolve('interrupted')

    return new Promise<'completed' | 'interrupted'>((resolve, reject) => {
      let remainingMs = timeoutMs
      let timerStartedAt = Date.now()
      let timer: ReturnType<typeof setTimeout> | null = null
      let settled = false
      let onAbort: (() => void) | null = null

      const hasPendingHitlForThread = (): boolean => {
        for (const entry of this.pendingQuestions.values()) {
          if (entry.threadId === session.threadId) return true
        }
        for (const entry of this.pendingApprovalSessions.values()) {
          if (entry.threadId === session.threadId) return true
        }
        return false
      }

      const clearSignalListener = () => {
        if (onAbort) {
          signal?.removeEventListener('abort', onAbort)
        }
      }

      const clearTimer = () => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
      }

      const cleanup = () => {
        if (settled) return
        settled = true
        clearTimer()
        clearSignalListener()
        this.manager.removeListener('event', checkEvent)
      }

      const finish = (result: 'completed' | 'interrupted'): void => {
        cleanup()
        resolve(result)
      }

      const fail = (error: Error): void => {
        cleanup()
        reject(error)
      }

      onAbort = () => {
        finish('interrupted')
      }

      const startTimer = () => {
        clearTimer()
        timerStartedAt = Date.now()
        timer = setTimeout(() => {
          fail(new Error('Turn timed out'))
        }, remainingMs)
      }

      const resetInactivityTimer = () => {
        if (hasPendingHitlForThread()) return
        remainingMs = timeoutMs
        startTimer()
      }

      const pauseTimer = () => {
        if (!timer) return
        clearTimeout(timer)
        timer = null
        const elapsed = Date.now() - timerStartedAt
        remainingMs = Math.max(0, remainingMs - elapsed)
      }

      const isProgressEvent = (event: CodexManagerEvent): boolean => {
        if (contentStreamKindFromMethod(event.method)) return true
        if (event.method.startsWith('item/')) return true
        if (event.method.startsWith('codex/event/')) return true
        if (event.method === 'turn/started') return true
        if (event.method === 'thread/tokenUsage/updated') return true
        if (event.method === 'account/rateLimits/updated') return true
        if (event.method === 'thread/status/changed') {
          const payload = asObject(event.payload)
          const status = asObject(payload?.status) ?? payload
          return asString(status?.type) === 'active'
        }
        return false
      }

      const checkEvent = (event: CodexManagerEvent) => {
        if (!this.eventMatchesActiveRun(session, runId, event)) return

        if (event.method === 'turn/completed') {
          const payload = event.payload as Record<string, unknown> | undefined
          const turnObj = payload?.turn as Record<string, unknown> | undefined
          const status = (turnObj?.status as string) ?? (payload?.state as string)
          if (status === 'interrupted') {
            finish('interrupted')
            return
          }
          finish('completed')
          return
        }

        if (event.method === 'turn/interrupted') {
          finish('interrupted')
          return
        }

        if (event.method === 'thread/status/changed') {
          const payload = asObject(event.payload)
          const status = asObject(payload?.status) ?? payload
          if (asString(status?.type) === 'idle') {
            const activeRun = session.activeRun
            finish(activeRun?.state === 'aborting' ? 'interrupted' : 'completed')
            return
          }
        }

        // Only reject on truly fatal errors — not stderr warnings.
        // The Codex app-server may output benign stderr content (warnings,
        // progress info, non-standard log formats) that should not abort
        // the turn. Only process crashes and session exits are fatal.
        const isFatalError =
          event.method === 'process/error' ||
          event.method === 'session/exited' ||
          event.method === 'session/closed'

        if (isFatalError) {
          fail(new Error(event.message ?? 'Codex process error'))
          return
        }

        const isErrorStateChange =
          (event.method === 'session.state.changed' || event.method === 'session/state/changed') &&
          (event.payload as Record<string, unknown> | undefined)?.state === 'error'

        if (isErrorStateChange) {
          const payload = event.payload as Record<string, unknown>
          const reason =
            (payload?.reason as string) ??
            (payload?.error as string) ??
            event.message ??
            'Session entered error state'
          fail(new Error(reason))
          return
        }

        if (event.kind === 'request') {
          pauseTimer()
          return
        }

        const hitlStateChanged =
          event.method === 'item/tool/requestUserInput/answered' ||
          event.method === 'approval/responded' ||
          event.method === 'userInput/rejected' ||
          event.method === 'session/closed' ||
          event.method === 'session/exited'

        if (hitlStateChanged && !hasPendingHitlForThread() && remainingMs > 0) {
          startTimer()
          return
        }

        if (isProgressEvent(event)) {
          resetInactivityTimer()
        }
      }

      if (onAbort) {
        signal?.addEventListener('abort', onAbort, { once: true })
      }
      this.manager.on('event', checkEvent)
      if (!hasPendingHitlForThread()) {
        startTimer()
      }

      // Check again in case it completed between the start and listener setup
      if (isComplete()) {
        finish('completed')
      }
    })
  }

  /** Find a session key by its agentSessionId (threadId) */
  private findSessionKeyByAgentId(agentSessionId: string): string | null {
    for (const [key, session] of this.sessions.entries()) {
      if (session.threadId === agentSessionId) {
        return key
      }
    }
    return null
  }

  /** Extract the last user prompt text from in-memory messages */
  private extractLastUserPrompt(session: CodexSessionState): string {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = asObject(session.messages[i])
      if (msg?.role === 'user') {
        const parts = msg.parts as unknown[] | undefined
        if (Array.isArray(parts)) {
          for (const part of parts) {
            const partObj = asObject(part)
            if (partObj?.type === 'text' && typeof partObj.text === 'string') {
              return partObj.text
            }
          }
        }
      }
    }
    return ''
  }

  /**
   * Pop the last user+assistant exchange from in-memory messages.
   * Returns the ID/timestamp of the new last message (the revert boundary),
   * or a synthetic boundary ID if no messages remain.
   */
  private popLastExchange(session: CodexSessionState): string {
    // Remove trailing assistant message(s)
    while (session.messages.length > 0) {
      const last = asObject(session.messages[session.messages.length - 1])
      if (last?.role === 'assistant') {
        session.messages.pop()
      } else {
        break
      }
    }

    // Remove the trailing user message
    if (session.messages.length > 0) {
      const last = asObject(session.messages[session.messages.length - 1])
      if (last?.role === 'user') {
        session.messages.pop()
      }
    }

    // Return the ID of what's now the last message, or a synthetic boundary
    if (session.messages.length > 0) {
      const last = asObject(session.messages[session.messages.length - 1])
      return asString(last?.id) ?? asString(last?.timestamp) ?? `revert-${session.messages.length}`
    }

    return 'revert-0'
  }

  private async recoverSessionForRead(
    worktreePath: string,
    agentSessionId: string
  ): Promise<CodexSessionState | null> {
    if (!this.dbService) {
      return null
    }

    const persistedSession = this.dbService.getSessionByOpenCodeSessionId(agentSessionId)
    if (!persistedSession || persistedSession.agent_sdk !== 'codex') {
      return null
    }

    try {
      const providerSession = await this.manager.startSession({
        cwd: worktreePath,
        model: resolveCodexModelSlug(persistedSession.model_id ?? this.selectedModel),
        resumeThreadId: agentSessionId,
        codexLaunchSpec: await this.resolveLaunchSpec()
      })

      const threadId = providerSession.threadId
      if (!threadId) {
        throw new Error('Codex session resumed for read but no thread ID was returned.')
      }

      const recovered: CodexSessionState = {
        threadId,
        hiveSessionId: persistedSession.id,
        worktreePath,
        status: this.mapProviderStatus(providerSession.status),
        messages: [],
        liveAssistantDraft: null,
        activeRun: null,
        settledRunIds: new Set(),
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: true,
        titleGenerationStarted: true,
        tokenUsageCostByEvent: new Map(),
        mapperState: createCodexMapperState(),
        itemTimestampsByTurn: new Map(),
        recordedItemIdsByTurn: new Map()
      }

      this.sessions.set(this.getSessionKey(worktreePath, threadId), recovered)

      log.info('Recovered persisted Codex session for transcript read', {
        worktreePath,
        agentSessionId,
        threadId,
        hiveSessionId: persistedSession.id
      })

      return recovered
    } catch (error) {
      log.warn('Failed to recover persisted Codex session for transcript read', {
        worktreePath,
        agentSessionId,
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  }

  private async handleTitleGeneration(
    session: CodexSessionState,
    userMessage: string
  ): Promise<void> {
    try {
      const title = await generateCodexSessionTitle(userMessage, session.worktreePath)
      if (!title) return
      await this.applyGeneratedTitle(session, title)
    } catch (err) {
      log.warn('handleTitleGeneration: failed', {
        hiveSessionId: session.hiveSessionId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  private async applyGeneratedTitle(session: CodexSessionState, title: string): Promise<void> {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return

    let currentTitle: string | null = null
    if (this.dbService) {
      try {
        currentTitle = this.dbService.getSession(session.hiveSessionId)?.name ?? null
      } catch {
        currentTitle = null
      }
    }

    const titleChanged = currentTitle !== trimmedTitle

    if (this.dbService && titleChanged) {
      this.dbService.updateSession(session.hiveSessionId, { name: trimmedTitle })
      log.info('applyGeneratedTitle: updated DB', {
        hiveSessionId: session.hiveSessionId,
        title: trimmedTitle
      })
    }

    if (titleChanged) {
      emitAgentEvent(this.mainWindow, {
        type: 'session.updated',
        sessionId: session.hiveSessionId,
        data: { title: trimmedTitle, info: { title: trimmedTitle } }
      })
    } else {
      log.debug('applyGeneratedTitle: title unchanged, skipping session rename event', {
        hiveSessionId: session.hiveSessionId,
        title: trimmedTitle
      })
    }

    if (!this.dbService) return
    const worktree = this.dbService.getWorktreeBySessionId(session.hiveSessionId)
    if (worktree && !worktree.branch_renamed) {
      try {
        const result = await autoRenameWorktreeBranch({
          worktreeId: worktree.id,
          worktreePath: worktree.path,
          currentBranchName: worktree.branch_name,
          sessionTitle: trimmedTitle,
          db: this.dbService
        })
        if (result.renamed) {
          this.sendToRenderer('worktree:branchRenamed', {
            worktreeId: worktree.id,
            newBranch: result.newBranch
          })
          log.info('applyGeneratedTitle: auto-renamed branch', {
            oldBranch: worktree.branch_name,
            newBranch: result.newBranch
          })
        } else if (result.error) {
          log.warn('applyGeneratedTitle: rename failed', { error: result.error })
        }
      } catch (err) {
        this.dbService.updateWorktree(worktree.id, { branch_renamed: 1 })
        log.warn('applyGeneratedTitle: branch rename error', { err })
      }
    }

    const dbSession = this.dbService.getSession(session.hiveSessionId)
    if (!dbSession?.connection_id) return

    const connection = this.dbService.getConnection(dbSession.connection_id)
    if (!connection) return

    for (const member of connection.members) {
      if (worktree && member.worktree_id === worktree.id) continue
      try {
        const memberWorktree = this.dbService.getWorktree(member.worktree_id)
        if (!memberWorktree || memberWorktree.branch_renamed) continue

        const result = await autoRenameWorktreeBranch({
          worktreeId: memberWorktree.id,
          worktreePath: memberWorktree.path,
          currentBranchName: memberWorktree.branch_name,
          sessionTitle: trimmedTitle,
          db: this.dbService
        })
        if (result.renamed) {
          this.sendToRenderer('worktree:branchRenamed', {
            worktreeId: memberWorktree.id,
            newBranch: result.newBranch
          })
          log.info('applyGeneratedTitle: auto-renamed connection member', {
            connectionId: dbSession.connection_id,
            worktreeId: memberWorktree.id,
            oldBranch: memberWorktree.branch_name,
            newBranch: result.newBranch
          })
        } else if (result.error) {
          log.warn('applyGeneratedTitle: connection member rename failed', {
            connectionId: dbSession.connection_id,
            worktreeId: memberWorktree.id,
            error: result.error
          })
        }
      } catch (err) {
        log.warn('applyGeneratedTitle: connection member rename error', {
          worktreeId: member.worktree_id,
          err
        })
      }
    }
  }

  private readJsonlItemTimelineByTurn(snapshot: unknown): Map<string, CodexJsonlTurnTimeline> {
    const jsonlPath = extractCodexJsonlPath(snapshot)
    if (!jsonlPath) return new Map()

    const result = new Map<string, CodexJsonlTurnTimeline>()
    const getTurnTimeline = (turnId: string): CodexJsonlTurnTimeline => {
      const existing = result.get(turnId)
      if (existing) return existing
      const created: CodexJsonlTurnTimeline = {
        positional: [],
        userMessages: [],
        assistantMessages: [],
        reasoningMessages: [],
        toolCallTimestampsById: new Map()
      }
      result.set(turnId, created)
      return created
    }

    try {
      const lines = readFileSync(jsonlPath, 'utf-8').split('\n')
      let currentTurnId: string | null = null

      const pushPositional = (timestamp: string | undefined): string | null => {
        if (!currentTurnId || !timestamp) return null
        const normalized = normalizeCodexJsonlTimestamp(timestamp)
        if (!normalized) return null
        getTurnTimeline(currentTurnId).positional.push(normalized)
        return normalized
      }

      const pushText = (
        collection: keyof Pick<
          CodexJsonlTurnTimeline,
          'userMessages' | 'assistantMessages' | 'reasoningMessages'
        >,
        text: string,
        timestamp: string | undefined
      ): void => {
        if (!currentTurnId || !text.trim()) return
        const normalized = normalizeCodexJsonlTimestamp(timestamp)
        if (!normalized) return
        getTurnTimeline(currentTurnId)[collection].push({ text, timestamp: normalized })
      }

      for (const line of lines) {
        if (!line.trim()) continue
        let entry: Record<string, unknown>
        try {
          entry = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }

        const entryType = asString(entry.type)
        const payload = asObject(entry.payload)
        const timestamp = asString(entry.timestamp)

        if (entryType === 'turn_context') {
          currentTurnId = asString(payload?.turn_id) ?? currentTurnId
          continue
        }

        if (entryType === 'event_msg') {
          const payloadType = asString(payload?.type)
          if (payloadType === 'task_started') {
            currentTurnId = asString(payload?.turn_id) ?? null
            continue
          }
          if (payloadType === 'user_message') {
            pushPositional(timestamp)
            pushText('userMessages', asString(payload?.message) ?? '', timestamp)
          }
          continue
        }

        if (entryType !== 'response_item' || !currentTurnId) continue

        const itemType = asString(payload?.type)
        const role = asString(payload?.role)
        if (itemType === 'message' && role === 'assistant') {
          pushPositional(timestamp)
          pushText('assistantMessages', extractCodexJsonlContentText(payload?.content), timestamp)
        } else if (itemType === 'message' && role === 'user') {
          pushText('userMessages', extractCodexJsonlContentText(payload?.content), timestamp)
        } else if (itemType === 'reasoning') {
          pushPositional(timestamp)
          pushText('reasoningMessages', extractCodexJsonlReasoningText(payload ?? {}), timestamp)
        } else if (
          itemType === 'function_call' ||
          itemType === 'custom_tool_call' ||
          itemType === 'tool_search_call' ||
          itemType === 'local_shell_call' ||
          itemType === 'web_search_call' ||
          itemType === 'image_generation_call'
        ) {
          const normalized = pushPositional(timestamp)
          const callId = asString(payload?.call_id) ?? asString(payload?.id)
          if (normalized && callId) {
            getTurnTimeline(currentTurnId).toolCallTimestampsById.set(callId, normalized)
          }
        }
      }
    } catch (error) {
      log.debug('parseThreadSnapshot: failed to read Codex JSONL timestamps', {
        jsonlPath,
        error: error instanceof Error ? error.message : String(error)
      })
    }

    return result
  }

  private readJsonlSupplementalMessages(snapshot: unknown): CodexJsonlSupplementalMessage[] {
    const jsonlPath = extractCodexJsonlPath(snapshot)
    if (!jsonlPath) return []

    const messages: CodexJsonlSupplementalMessage[] = []
    const responseMessages: CodexJsonlSupplementalMessage[] = []
    let currentTurnId: string | null = null
    let messageOrdinal = 0

    const pushSupplementalMessage = (
      target: CodexJsonlSupplementalMessage[],
      role: 'user' | 'assistant',
      text: string,
      timestamp: string | undefined
    ): void => {
      const trimmed = stripCodexMemoryCitation(text)
      const normalizedText = normalizeCodexTimelineText(trimmed)
      if (!normalizedText) return
      if (
        target.some(
          (message) =>
            (message.role === role && message.normalizedText === normalizedText) ||
            (message.role === role &&
              (message.normalizedText.startsWith(normalizedText) ||
                normalizedText.startsWith(message.normalizedText)))
        )
      ) {
        return
      }

      const normalizedTimestamp =
        normalizeCodexJsonlTimestamp(timestamp) ?? new Date().toISOString()
      messageOrdinal += 1
      const idBase = currentTurnId ?? `jsonl-${messageOrdinal}`
      const roleSuffix = role === 'assistant' ? 'assistant' : 'user'
      target.push({
        role,
        normalizedText,
        timestamp: normalizedTimestamp,
        message: {
          id: `${idBase}:${roleSuffix}:jsonl-${messageOrdinal}`,
          role,
          parts: [
            {
              type: 'text',
              text: trimmed,
              timestamp: normalizedTimestamp
            }
          ],
          timestamp: normalizedTimestamp
        }
      })
    }

    try {
      const lines = readFileSync(jsonlPath, 'utf-8').split('\n')
      for (const line of lines) {
        if (!line.trim()) continue

        let entry: Record<string, unknown>
        try {
          entry = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }

        const entryType = asString(entry.type)
        const payload = asObject(entry.payload)
        const timestamp = asString(entry.timestamp)

        if (entryType === 'turn_context') {
          currentTurnId = asString(payload?.turn_id) ?? currentTurnId
          continue
        }

        if (entryType === 'event_msg') {
          const payloadType = asString(payload?.type)
          if (payloadType === 'task_started') {
            currentTurnId = asString(payload?.turn_id) ?? null
            continue
          }

          if (payloadType === 'user_message') {
            pushSupplementalMessage(messages, 'user', asString(payload?.message) ?? '', timestamp)
          } else if (payloadType === 'agent_message') {
            pushSupplementalMessage(
              messages,
              'assistant',
              asString(payload?.message) ?? '',
              timestamp
            )
          }
          continue
        }

        if (
          entryType === 'response_item' &&
          asString(payload?.type) === 'message' &&
          asString(payload?.role) === 'assistant'
        ) {
          pushSupplementalMessage(
            responseMessages,
            'assistant',
            extractCodexJsonlContentText(payload?.content),
            timestamp
          )
        }

        // Recover reasoning content from JSONL when thread/read hasn't returned it yet.
        // Same structure as the reasoning items in parseThreadSnapshot.
        if (entryType === 'response_item' && asString(payload?.type) === 'reasoning') {
          const summary = Array.isArray(payload?.summary)
            ? (payload.summary as string[]).filter((s): s is string => typeof s === 'string')
            : []
          const content = Array.isArray(payload?.content)
            ? (payload.content as string[]).filter((s): s is string => typeof s === 'string')
            : []
          const reasoningText = [...summary, ...content].join('\n').trim()
          if (reasoningText) {
            pushSupplementalMessage(responseMessages, 'assistant', reasoningText, timestamp)
          }
        }
      }
    } catch (error) {
      log.debug('parseThreadSnapshot: failed to read Codex JSONL supplemental messages', {
        jsonlPath,
        error: error instanceof Error ? error.message : String(error)
      })
    }

    return [
      ...messages,
      ...responseMessages.filter(
        (responseMessage) =>
          !messages.some(
            (message) =>
              responseMessage.role === message.role &&
              (responseMessage.normalizedText === message.normalizedText ||
                responseMessage.normalizedText.startsWith(message.normalizedText) ||
                message.normalizedText.startsWith(responseMessage.normalizedText))
          )
      )
    ]
  }

  private readJsonlSupplementalActivities(
    session: CodexSessionState,
    snapshot: unknown
  ): SessionActivityCreate[] {
    const jsonlPath = extractCodexJsonlPath(snapshot)
    if (!jsonlPath) return []

    const calls = new Map<string, CodexJsonlToolCall>()
    let currentTurnId: string | null = null

    const getOrCreateCall = (
      callId: string,
      name: string,
      timestamp: string | undefined
    ): CodexJsonlToolCall => {
      const normalizedTimestamp =
        normalizeCodexJsonlTimestamp(timestamp) ?? new Date().toISOString()
      const existing = calls.get(callId)
      if (existing) {
        if (!existing.name && name) existing.name = name
        if (!existing.turnId && currentTurnId) existing.turnId = currentTurnId
        return existing
      }

      const created: CodexJsonlToolCall = {
        callId,
        name,
        input: {},
        turnId: currentTurnId,
        startedAt: normalizedTimestamp,
        completedAt: null,
        output: undefined,
        failed: false
      }
      calls.set(callId, created)
      return created
    }

    const recordToolCall = (
      callId: string | undefined,
      name: string | undefined,
      input: unknown,
      timestamp: string | undefined
    ): void => {
      if (!callId || !name) return
      const call = getOrCreateCall(callId, name, timestamp)
      call.input = parseCodexJsonlArguments(input)
      call.startedAt = normalizeCodexJsonlTimestamp(timestamp) ?? call.startedAt
      call.turnId = call.turnId ?? currentTurnId
    }

    const recordToolOutput = (
      callId: string | undefined,
      output: unknown,
      timestamp: string | undefined
    ): void => {
      if (!callId) return
      const call = getOrCreateCall(callId, 'unknown', timestamp)
      call.output = output
      call.completedAt = normalizeCodexJsonlTimestamp(timestamp) ?? call.completedAt
      call.failed = call.failed || inferCodexJsonlOutputFailed(output)
      call.turnId = call.turnId ?? currentTurnId
    }

    try {
      const lines = readFileSync(jsonlPath, 'utf-8').split('\n')
      for (const line of lines) {
        if (!line.trim()) continue

        let entry: Record<string, unknown>
        try {
          entry = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }

        const entryType = asString(entry.type)
        const payload = asObject(entry.payload)
        const timestamp = asString(entry.timestamp)

        if (entryType === 'turn_context') {
          currentTurnId = asString(payload?.turn_id) ?? currentTurnId
          continue
        }

        if (entryType === 'event_msg') {
          const payloadType = asString(payload?.type)
          if (payloadType === 'task_started') {
            currentTurnId = asString(payload?.turn_id) ?? null
          } else if (payloadType === 'patch_apply_end') {
            const stdout = asString(payload?.stdout)
            const stderr = asString(payload?.stderr)
            recordToolOutput(
              asString(payload?.call_id),
              [stdout, stderr].filter(Boolean).join('\n'),
              timestamp
            )
          }
          continue
        }

        if (entryType !== 'response_item') continue

        const itemType = asString(payload?.type)
        if (itemType === 'function_call' || itemType === 'custom_tool_call') {
          recordToolCall(
            asString(payload?.call_id) ?? asString(payload?.id),
            asString(payload?.name),
            payload?.arguments ?? payload?.input,
            timestamp
          )
        } else if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
          recordToolOutput(asString(payload?.call_id), payload?.output, timestamp)
        } else if (
          itemType === 'local_shell_call' ||
          itemType === 'web_search_call' ||
          itemType === 'tool_search_call' ||
          itemType === 'image_generation_call'
        ) {
          recordToolCall(
            asString(payload?.call_id) ?? asString(payload?.id),
            itemType,
            payload,
            timestamp
          )
          const callId = asString(payload?.call_id) ?? asString(payload?.id)
          if (callId && asString(payload?.status) === 'completed') {
            const call = getOrCreateCall(callId, itemType, timestamp)
            call.completedAt = normalizeCodexJsonlTimestamp(timestamp) ?? call.completedAt
          }
        }
      }
    } catch (error) {
      log.debug('parseThreadSnapshot: failed to read Codex JSONL supplemental activities', {
        jsonlPath,
        error: error instanceof Error ? error.message : String(error)
      })
    }

    return Array.from(calls.values())
      .filter((call) => call.name !== 'unknown' || call.output !== undefined)
      .map((call) => {
        const item = buildCodexJsonlToolItem(call)
        const createdAt = call.completedAt ?? call.startedAt
        const failed = asString(item.status) === 'failed'
        return {
          id: `codex-jsonl:${session.hiveSessionId}:${call.callId}`,
          session_id: session.hiveSessionId,
          agent_session_id: session.threadId,
          thread_id: session.threadId,
          turn_id: call.turnId,
          item_id: call.callId,
          request_id: null,
          kind: failed ? 'tool.failed' : 'tool.completed',
          tone: failed ? 'error' : 'tool',
          summary: extractCodexJsonlToolName(call.name),
          payload_json: JSON.stringify({ item, source: 'codex-jsonl' }),
          created_at: createdAt
        } satisfies SessionActivityCreate
      })
  }

  private persistJsonlSupplementalActivities(session: CodexSessionState, snapshot: unknown): void {
    if (!this.dbService) return

    const activities = this.readJsonlSupplementalActivities(session, snapshot)
    const scannedAt = new Date().toISOString()

    try {
      for (const activity of activities) {
        this.dbService.upsertSessionActivity(activity)
      }

      this.dbService.upsertSessionActivity({
        id: `codex-jsonl-recovery:${session.hiveSessionId}:${session.threadId}`,
        session_id: session.hiveSessionId,
        agent_session_id: session.threadId,
        thread_id: session.threadId,
        kind: 'session.info',
        tone: 'info',
        summary: `Codex JSONL recovery scanned ${activities.length} tool activities`,
        payload_json: JSON.stringify({
          kind: 'codex_jsonl_recovery',
          toolActivityCount: activities.length
        }),
        created_at: scannedAt
      })
    } catch (error) {
      log.warn('Failed to persist Codex JSONL supplemental activities', {
        hiveSessionId: session.hiveSessionId,
        count: activities.length,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private getJsonlTimestampForThreadItem(
    turnTimeline: CodexJsonlTurnTimeline | undefined,
    itemObj: Record<string, unknown>,
    itemType: string | undefined
  ): string | null {
    if (!turnTimeline) return null

    if (itemType === 'userMessage') {
      const content = itemObj.content as unknown[] | undefined
      const text = Array.isArray(content)
        ? content
            .map((entry) => asObject(entry))
            .map((entry) => asString(entry?.text) ?? '')
            .filter(Boolean)
            .join('\n')
        : ''
      return shiftMatchingCodexJsonlTextTimestamp(turnTimeline.userMessages, text)
    }

    if (itemType === 'agentMessage' || itemType === 'plan') {
      return shiftMatchingCodexJsonlTextTimestamp(
        turnTimeline.assistantMessages,
        asString(itemObj.text) ?? ''
      )
    }

    if (itemType === 'reasoning') {
      const summary = Array.isArray(itemObj.summary)
        ? itemObj.summary.filter((entry): entry is string => typeof entry === 'string')
        : []
      const content = Array.isArray(itemObj.content)
        ? itemObj.content.filter((entry): entry is string => typeof entry === 'string')
        : []
      return shiftMatchingCodexJsonlTextTimestamp(
        turnTimeline.reasoningMessages,
        [...summary, ...content].join('\n').trim()
      )
    }

    const itemId = asString(itemObj.id)
    if (itemId && turnTimeline.toolCallTimestampsById.has(itemId)) {
      return turnTimeline.toolCallTimestampsById.get(itemId) ?? null
    }

    return null
  }

  /** Parse a thread/read snapshot into a message array for getMessages() */
  private parseThreadSnapshot(
    snapshot: unknown,
    itemTimestampsByTurn?: Map<string, string[]>
  ): unknown[] {
    const obj = asObject(snapshot)
    if (!obj) return []

    const threadObj = asObject(obj.thread) ?? obj
    const turns = threadObj.turns as unknown[] | undefined
    const messages: Array<{ message: unknown; sortTime: number; order: number }> = []
    let order = 0
    const jsonlTimelineByTurn = this.readJsonlItemTimelineByTurn(snapshot)
    const jsonlSupplementalMessages = this.readJsonlSupplementalMessages(snapshot)
    const pushMessage = (message: unknown, timestamp: string | null | undefined): void => {
      const parsedTimestamp = timestamp ? Date.parse(timestamp) : Number.NaN
      messages.push({
        message,
        sortTime: Number.isFinite(parsedTimestamp) ? parsedTimestamp : Number.MAX_SAFE_INTEGER,
        order: order++
      })
    }

    for (const turn of Array.isArray(turns) ? turns : []) {
      const turnObj = asObject(turn)
      if (!turnObj) continue

      const turnId = asString(turnObj.id)
      // Codex turns expose `startedAt` as Unix epoch seconds. Older code looked
      // at `createdAt` / `updatedAt`, so items often fell back to read time and
      // sorted after synthetic activity emitted during the same turn.
      const startedAtSec = asNumber(turnObj.startedAt)
      const turnStartIso = startedAtSec ? new Date(startedAtSec * 1000).toISOString() : undefined
      const turnTimestamp =
        turnStartIso ?? asString(turnObj.createdAt) ?? asString(turnObj.updatedAt)
      const items = turnObj.items as unknown[] | undefined
      if (Array.isArray(items) && items.length > 0) {
        let assistantItemOrdinal = 0
        let userItemOrdinal = 0

        const makeUserMessageId = (itemId?: string): string | undefined => {
          if (!turnId) return itemId
          if (userItemOrdinal === 0) {
            userItemOrdinal += 1
            return `${turnId}:user`
          }
          const suffix = itemId ?? `item-${userItemOrdinal + 1}`
          userItemOrdinal += 1
          return `${turnId}:user:${suffix}`
        }

        const makeAssistantMessageId = (itemId?: string): string | undefined => {
          if (!turnId) return itemId
          if (assistantItemOrdinal === 0) {
            assistantItemOrdinal += 1
            return `${turnId}:assistant`
          }
          const suffix = itemId ?? `item-${assistantItemOrdinal + 1}`
          assistantItemOrdinal += 1
          return `${turnId}:assistant:${suffix}`
        }

        // Resolve per-turn timestamps. Codex `thread/read` may return a
        // summarized item list whose item positions do not match the JSONL
        // `response_item` stream, so JSONL timestamps are matched by content
        // first. Positional fallback is only used when the sequence lengths
        // match exactly.
        const turnJsonlTimeline = turnId ? jsonlTimelineByTurn.get(turnId) : undefined
        const livePositionalTimestamps = turnId ? (itemTimestampsByTurn?.get(turnId) ?? []) : []
        const livePositionReliable = livePositionalTimestamps.length === items.length
        const jsonlPositionReliable = turnJsonlTimeline?.positional.length === items.length
        let itemPositionInTurn = 0

        for (const item of items) {
          const itemObj = asObject(item)
          if (!itemObj) continue

          const itemType = asString(itemObj.type)
          const itemId = asString(itemObj.id)
          const jsonlItemTimestamp = this.getJsonlTimestampForThreadItem(
            turnJsonlTimeline,
            itemObj,
            itemType
          )
          const positionalTs =
            (livePositionReliable ? livePositionalTimestamps[itemPositionInTurn] : undefined) ??
            (jsonlPositionReliable ? turnJsonlTimeline?.positional[itemPositionInTurn] : undefined)
          const itemTimestamp =
            eventTimestampFromPayload(itemObj) ??
            jsonlItemTimestamp ??
            positionalTs ??
            turnTimestamp ??
            new Date().toISOString()
          itemPositionInTurn += 1

          if (itemType === 'userMessage') {
            const content = itemObj.content as unknown[] | undefined
            const textParts: unknown[] = []

            if (Array.isArray(content)) {
              for (const entry of content) {
                const entryObj = asObject(entry)
                if (entryObj?.type === 'text' && typeof entryObj.text === 'string') {
                  textParts.push({
                    type: 'text',
                    text: stripFieldContextEnvelope(entryObj.text),
                    timestamp: itemTimestamp
                  })
                }
              }
            }

            if (textParts.length > 0) {
              const messageId = makeUserMessageId(itemId)
              pushMessage(
                {
                  ...(messageId ? { id: messageId } : {}),
                  role: 'user',
                  parts: textParts,
                  timestamp: itemTimestamp
                },
                itemTimestamp
              )
            }
            continue
          }

          if (itemType === 'agentMessage' || itemType === 'plan') {
            const text = asString(itemObj.text)
            if (text) {
              const messageId = makeAssistantMessageId(itemId)
              pushMessage(
                {
                  ...(messageId ? { id: messageId } : {}),
                  role: 'assistant',
                  parts: [
                    {
                      type: 'text',
                      text,
                      timestamp: itemTimestamp
                    }
                  ],
                  timestamp: itemTimestamp
                },
                itemTimestamp
              )
            }
            continue
          }

          if (itemType === 'reasoning') {
            const summary = Array.isArray(itemObj.summary)
              ? itemObj.summary.filter((entry): entry is string => typeof entry === 'string')
              : []
            const content = Array.isArray(itemObj.content)
              ? itemObj.content.filter((entry): entry is string => typeof entry === 'string')
              : []
            const reasoningText = [...summary, ...content].join('\n').trim()

            if (reasoningText) {
              const messageId = makeAssistantMessageId(itemId)
              pushMessage(
                {
                  ...(messageId ? { id: messageId } : {}),
                  role: 'assistant',
                  parts: [
                    {
                      type: 'reasoning',
                      text: reasoningText,
                      timestamp: itemTimestamp
                    }
                  ],
                  timestamp: itemTimestamp
                },
                itemTimestamp
              )
            }
          }
        }

        continue
      }

      // Extract user input
      const input = turnObj.input as unknown[] | undefined
      if (Array.isArray(input)) {
        const textParts: unknown[] = []
        for (const item of input) {
          const itemObj = asObject(item)
          if (itemObj?.type === 'text' && typeof itemObj.text === 'string') {
            textParts.push({
              type: 'text',
              text: stripFieldContextEnvelope(itemObj.text),
              timestamp: asString(turnObj.createdAt) ?? new Date().toISOString()
            })
          }
        }
        if (textParts.length > 0) {
          const timestamp = asString(turnObj.createdAt) ?? new Date().toISOString()
          pushMessage(
            {
              ...(turnId ? { id: `${turnId}:user` } : {}),
              role: 'user',
              parts: textParts,
              timestamp
            },
            timestamp
          )
        }
      }

      // Extract assistant output
      const output = turnObj.output as unknown[] | undefined
      const outputText = asString(turnObj.outputText)
      if (outputText) {
        const timestamp = asString(turnObj.updatedAt) ?? new Date().toISOString()
        pushMessage(
          {
            ...(turnId ? { id: `${turnId}:assistant` } : {}),
            role: 'assistant',
            parts: [
              {
                type: 'text',
                text: outputText,
                timestamp
              }
            ],
            timestamp
          },
          timestamp
        )
      } else if (Array.isArray(output)) {
        const assistantParts: unknown[] = []
        for (const item of output) {
          const itemObj = asObject(item)
          if (!itemObj) continue
          if (itemObj.type === 'text' && typeof itemObj.text === 'string') {
            assistantParts.push({
              type: 'text',
              text: itemObj.text,
              timestamp: asString(turnObj.updatedAt) ?? new Date().toISOString()
            })
          }
        }
        if (assistantParts.length > 0) {
          const timestamp = asString(turnObj.updatedAt) ?? new Date().toISOString()
          pushMessage(
            {
              ...(turnId ? { id: `${turnId}:assistant` } : {}),
              role: 'assistant',
              parts: assistantParts,
              timestamp
            },
            timestamp
          )
        }
      }
    }

    for (const supplementalMessage of jsonlSupplementalMessages) {
      const alreadyPresent = messages.some((entry) => {
        const record = asObject(entry.message)
        if (record?.role !== supplementalMessage.role) return false
        return (
          normalizeCodexTimelineText(extractCodexTimelineMessageText(entry.message)) ===
          supplementalMessage.normalizedText
        )
      })

      if (!alreadyPresent) {
        pushMessage(supplementalMessage.message, supplementalMessage.timestamp)
      }
    }

    return messages
      .sort((a, b) => {
        if (a.sortTime !== b.sortTime) return a.sortTime - b.sortTime
        return a.order - b.order
      })
      .map((entry) => entry.message)
  }

  /**
   * Phase 21.5: emit an agent.* field event when a Codex tool item completes.
   * Called from handleManagerEvent on `item/completed` notifications.
   *
   * Codex tool lifecycle items are `commandExecution` (Bash) and `fileChange`
   * (apply_patch); anything else is ignored by `isToolLifecycleItem`.
   */
  private emitAgentToolField(session: CodexSessionState, event: CodexManagerEvent): void {
    if (!this.dbService) return

    const payload = asObject(event.payload)
    const item = asObject(payload?.item)
    if (!item) return

    const itemType = asString(item?.type)?.toLowerCase()
    // Only emit for the tool lifecycle itemTypes Codex uses. Non-tool items
    // (agentMessage / reasoning / plan) are ignored.
    if (itemType !== 'commandexecution' && itemType !== 'filechange') return

    const toolName =
      asString(item?.toolName) ??
      asString(item?.name) ??
      // Fall back to a canonical name derived from the itemType so the
      // router in emit-agent-tool.ts knows how to categorize it.
      (itemType === 'commandexecution' ? 'exec_command' : 'apply_patch')

    const toolUseId =
      asString(item?.id) ?? asString(event.itemId) ?? asString(payload?.itemId) ?? ''
    if (!toolUseId) return

    const input = (item?.input as Record<string, unknown> | undefined) ?? {}
    const status = asString(item?.status)
    const isError = status === 'failed'
    const outputText = asString(item?.output) ?? asString(item?.aggregatedOutput) ?? undefined
    const exitCode = asNumber(item?.exitCode) ?? (isError ? 1 : undefined)
    const durationMs = asNumber(item?.durationMs) ?? undefined

    const worktreeRow = this.dbService.getWorktreeByPath(session.worktreePath)
    if (!worktreeRow) return

    void import('../field/emit-agent-tool').then(({ emitAgentToolEvent }) => {
      emitAgentToolEvent({
        worktreeId: worktreeRow.id,
        projectId: worktreeRow.project_id ?? null,
        sessionId: session.hiveSessionId,
        worktreePath: session.worktreePath,
        toolName,
        toolUseId,
        // Codex does not surface sub-agent nesting today; V1 stays null.
        parentToolUseId: null,
        input,
        output: {
          text: isError ? undefined : outputText,
          error: isError ? outputText : undefined,
          exitCode,
          durationMs
        }
      })
    })
  }

  /**
   * Reverse-lookup helper used by the Hub bridge: given a hive session id,
   * find the live in-memory codex session and return the routing tuple.
   * Mirrors `ClaudeCodeImplementer.findRoutingByHive` so the controller can
   * iterate runtimes uniformly. Returns null when the session isn't loaded
   * in this process — the controller then falls back to a DB-driven
   * lazy-materialize via `reconnect()`.
   */
  findRoutingByHive(
    hiveSessionId: string
  ): { worktreePath: string; agentSessionId: string } | null {
    for (const session of this.sessions.values()) {
      if (session.hiveSessionId === hiveSessionId) {
        return {
          worktreePath: session.worktreePath,
          agentSessionId: session.threadId
        }
      }
    }
    return null
  }
}
