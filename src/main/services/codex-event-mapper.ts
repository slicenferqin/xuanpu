import type { OpenCodeStreamEvent } from '@shared/types/opencode'
import type {
  CanonicalToolName,
  ToolStatus,
  ToolPart,
  ToolState,
  ToolMetadata
} from '@shared/types/agent-protocol'
import { classifyCodexItem, type ClassifiedCodexItem } from '@shared/lib/codex-classify'
import type { CodexManagerEvent } from './codex-app-server-manager'
import { asObject, asString, asNumber } from './codex-utils'

// Re-export for callers that previously imported from this module.
export { classifyCodexItem }
export type { ClassifiedCodexItem }

// ── Mapper state — per-session output buffers + start times ──────
//
// codex emits commandExecution output as a stream of `outputDelta` chunks
// followed by item/completed (which echoes the same content as
// `aggregatedOutput`). The renderer's runtime store does last-write-wins on
// `state.output` per callID, so the mapper must always emit the FULL
// accumulated output, not just the delta — otherwise each delta clobbers
// the previous content.
//
// Pass a CodexMapperState bound to a session into mapCodexEventToStreamEvents
// to enable accumulation. Without a state, deltas are still mapped but
// each delta carries only its own slice (useful for unit tests of single
// frames).

const MAX_OUTPUT_BUFFER = 256 * 1024
const KEEP_PREFIX = 64 * 1024

export interface CodexMapperState {
  outputBuffers: Map<string, string>
  toolStartTimes: Map<string, number>
}

export function createCodexMapperState(): CodexMapperState {
  return { outputBuffers: new Map(), toolStartTimes: new Map() }
}

// ── Content stream kind classification (deltas only) ─────────────

export type ContentStreamKind = 'assistant' | 'reasoning' | 'reasoning_summary'

/**
 * Maps codex JSON-RPC delta methods to a content-stream kind. Returns null
 * for non-content methods.
 *
 * NOTE: `item/commandExecution/outputDelta` and `item/fileChange/outputDelta`
 * are intentionally NOT classified here. They feed tool-part state.output
 * via the tool-lifecycle dispatch (see `handleCommandOutputDelta`).
 */
export function contentStreamKindFromMethod(method: string): ContentStreamKind | null {
  switch (method) {
    case 'item/agentMessage/delta':
      return 'assistant'
    case 'item/reasoning/textDelta':
      return 'reasoning'
    case 'item/reasoning/summaryTextDelta':
      return 'reasoning_summary'
    default:
      return null
  }
}

// ── Plan helpers (preserved API) ─────────────────────────────────

export interface CodexPlanTodo {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
  /** New: codex passes step text in `step` rather than `content`. */
  step?: string
}

function normalizePlanStatus(
  value: unknown,
  item?: Record<string, unknown>
): CodexPlanTodo['status'] {
  switch (value) {
    case 'pending':
      return 'pending'
    case 'in_progress':
    case 'in-progress':
    case 'inProgress':
    case 'running':
      return 'in_progress'
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    default:
      if (item?.completed === true || item?.done === true) return 'completed'
      if (item?.cancelled === true || item?.canceled === true) return 'cancelled'
      if (item?.current === true || item?.active === true || item?.inProgress === true) {
        return 'in_progress'
      }
      return 'pending'
  }
}

function extractPlanItemContent(item: Record<string, unknown>): string {
  const candidates = [
    item.step,
    item.content,
    item.title,
    item.text,
    item.label,
    item.task,
    item.subject,
    item.activeForm,
    item.description
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }
  return ''
}

function extractPlanItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const record = asObject(value)
  if (!record) return []
  const collections = [
    record.plan,
    record.todos,
    record.items,
    record.steps,
    record.checklist,
    record.checklistItems,
    record.updates
  ]
  for (const collection of collections) {
    if (Array.isArray(collection)) return collection
  }
  return []
}

export function normalizeCodexPlanUpdateTodos(payload: unknown): CodexPlanTodo[] {
  return extractPlanItems(payload).flatMap((item, index) => {
    if (typeof item === 'string' && item.trim()) {
      return [
        {
          id: `plan-${index}-${item.trim()}`,
          content: item.trim(),
          step: item.trim(),
          status: 'pending' as const,
          priority: 'medium' as const
        }
      ]
    }
    const record = asObject(item)
    if (!record) return []
    const content = extractPlanItemContent(record)
    if (!content) return []
    const status = normalizePlanStatus(record.status ?? record.state, record)
    return [
      {
        id: (typeof record.id === 'string' && record.id.trim()) || `plan-${index}-${content}`,
        content,
        step: content,
        status,
        priority: 'medium' as const
      }
    ]
  })
}

export function buildCodexUpdatePlanCallId(event: CodexManagerEvent): string {
  const payload = asObject(event.payload)
  const turnId =
    event.turnId ?? asString(payload?.turnId) ?? asString(asObject(payload?.turn)?.id)
  return `update_plan-${turnId ?? event.threadId}`
}

/**
 * Build a one-line human summary of a plan update. Preserved API for
 * `codex-activity-mapper.ts` (used to label plan updates in the live activity
 * stream).
 */
export function buildCodexPlanUpdateSummary(todos: CodexPlanTodo[]): string {
  if (todos.length === 0) return 'Plan updated'
  const completed = todos.filter((t) => t.status === 'completed').length
  const inProgress = todos.filter((t) => t.status === 'in_progress').length
  const cancelled = todos.filter((t) => t.status === 'cancelled').length
  const fragments = [`${completed}/${todos.length} completed`]
  if (inProgress > 0) fragments.push(`${inProgress} in progress`)
  if (cancelled > 0) fragments.push(`${cancelled} cancelled`)
  return fragments.join(', ')
}

// ── Status normalization ─────────────────────────────────────────

function normalizeCodexStatus(value: unknown): ToolStatus {
  switch (value) {
    case 'inProgress':
    case 'in_progress':
    case 'in-progress':
    case 'running':
      return 'running'
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed'
    case 'failed':
    case 'error':
      return 'error'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    case 'pending':
      return 'pending'
    default:
      return 'running'
  }
}

// ── Output buffer with truncation ────────────────────────────────

function appendOutput(
  state: CodexMapperState | undefined,
  callID: string,
  delta: string
): { output: string; metadata?: ToolMetadata } {
  if (!state) {
    return { output: delta }
  }
  const prev = state.outputBuffers.get(callID) ?? ''
  let next = prev + delta
  let truncated = false
  let truncatedBytes = 0
  if (next.length > MAX_OUTPUT_BUFFER) {
    truncatedBytes = next.length - KEEP_PREFIX
    next = next.slice(0, KEEP_PREFIX) + `\n…[truncated ${truncatedBytes} bytes]…\n`
    truncated = true
  }
  state.outputBuffers.set(callID, next)
  return {
    output: next,
    ...(truncated ? { metadata: { truncated, truncatedBytes } } : {})
  }
}

function consumeOutput(
  state: CodexMapperState | undefined,
  callID: string,
  fallback: string | undefined
): string | undefined {
  if (!state) return fallback
  const buffered = state.outputBuffers.get(callID)
  state.outputBuffers.delete(callID)
  return buffered ?? fallback
}

function trackStart(state: CodexMapperState | undefined, callID: string): number {
  const now = Date.now()
  if (!state) return now
  const existing = state.toolStartTimes.get(callID)
  if (existing !== undefined) return existing
  state.toolStartTimes.set(callID, now)
  return now
}

function clearStart(state: CodexMapperState | undefined, callID: string): void {
  state?.toolStartTimes.delete(callID)
}

// ── commandExecution: classify + promote via commandActions[] ────
//
// Classification logic lives in @shared/lib/codex-classify so the durable
// timeline reader (timeline-mappers) can apply the same shape-coercion as
// the live event stream. Here we just keep the local helpers needed for
// the streaming-only state machine (status transitions, output buffering).

interface ClassifyCommandLocal {
  tool: CanonicalToolName
  input: Record<string, unknown>
}

function classifyCommand(item: Record<string, unknown>): ClassifyCommandLocal {
  // Reuse the shared classifier (it returns Read/Grep/Bash for commandExecution).
  const classified = classifyCodexItem({ ...item, type: 'commandExecution' })
  if (classified && classified.tool && (classified.tool === 'Read' || classified.tool === 'Grep' || classified.tool === 'Bash')) {
    return { tool: classified.tool, input: classified.input ?? {} }
  }
  // Fallback (should not happen in practice).
  return { tool: 'Bash', input: { command: asString(item.command) ?? '' } }
}

// ── ToolState builder ────────────────────────────────────────────

function buildToolState(
  status: ToolStatus,
  input: Record<string, unknown> | undefined,
  output: string | undefined,
  result: unknown,
  errorMsg: string | undefined,
  metadata: ToolMetadata | undefined,
  start: number
): ToolState {
  const now = Date.now()
  const baseTime = { start, end: now }
  const meta: ToolMetadata | undefined =
    metadata && Object.keys(metadata).length > 0 ? metadata : undefined

  switch (status) {
    case 'pending':
      return {
        status: 'pending',
        ...(input ? { input } : {}),
        time: { start }
      }
    case 'running':
      return {
        status: 'running',
        ...(input ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        time: { start }
      }
    case 'completed':
      return {
        status: 'completed',
        ...(input ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(result !== undefined ? { result } : {}),
        ...(meta ? { metadata: meta } : {}),
        time: baseTime
      }
    case 'error':
      return {
        status: 'error',
        ...(input ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        error: errorMsg ?? 'Tool failed',
        ...(meta ? { metadata: meta } : {}),
        time: baseTime
      }
    case 'cancelled':
      return {
        status: 'cancelled',
        ...(input ? { input } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(meta ? { metadata: meta } : {}),
        time: baseTime
      }
  }
}

// ── Item dispatch ─────────────────────────────────────────────────
//
// For item/started, item/updated, item/completed events, decide whether to
// emit a tool part and what its shape should be. Returns null when the
// item type should not surface as a tool (e.g. agentMessage, reasoning,
// userMessage — those are handled by deltas or text part flow).

function itemToolPart(
  item: Record<string, unknown>,
  status: ToolStatus,
  state: CodexMapperState | undefined
): ToolPart | null {
  const itemType = asString(item.type)
  const callID = asString(item.id)
  if (!callID) return null

  const start = trackStart(state, callID)
  const isTerminal = status === 'completed' || status === 'error' || status === 'cancelled'

  switch (itemType) {
    case 'commandExecution': {
      const { tool, input } = classifyCommand(item)
      const exitCode = asNumber(item.exitCode)
      const durationMs = asNumber(item.durationMs)
      const aggregated = asString(item.aggregatedOutput)
      const output = isTerminal
        ? consumeOutput(state, callID, aggregated)
        : (state?.outputBuffers.get(callID) ?? aggregated)
      const meta: ToolMetadata = {}
      if (exitCode !== undefined) meta.exitCode = exitCode
      if (durationMs !== undefined) meta.durationMs = durationMs

      const errMessage = status === 'error' ? `command failed (exit ${exitCode ?? '?'})` : undefined

      const toolState = buildToolState(status, input, output, undefined, errMessage, meta, start)
      if (isTerminal) clearStart(state, callID)

      return { type: 'tool', callID, tool, state: toolState }
    }

    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const input: Record<string, unknown> = { changes }
      // Surface a file_path for single-file convenience (renderer cards).
      if (changes.length === 1) {
        const c = asObject(changes[0])
        const p = asString(c?.path)
        if (p) input.file_path = p
        const d = asString(c?.diff)
        if (d) input.diff = d
      }
      const filesAffected = changes
        .map((c) => asString(asObject(c)?.path))
        .filter((p): p is string => typeof p === 'string')
      const meta: ToolMetadata = {}
      if (filesAffected.length > 0) meta.filesAffected = filesAffected

      const toolState = buildToolState(status, input, undefined, undefined, undefined, meta, start)
      if (isTerminal) clearStart(state, callID)
      return { type: 'tool', callID, tool: 'Edit', state: toolState }
    }

    case 'webSearch': {
      const action = asObject(item.action)
      const queries = Array.isArray(action?.queries) ? (action!.queries as string[]) : undefined
      const query =
        asString(item.query) ??
        asString(action?.query) ??
        (queries && queries.length > 0 ? queries[0] : undefined)
      const input: Record<string, unknown> = {}
      if (query) input.query = query
      if (queries && queries.length > 0) input.queries = queries
      const toolState = buildToolState(
        status,
        Object.keys(input).length > 0 ? input : undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        start
      )
      if (isTerminal) clearStart(state, callID)
      return { type: 'tool', callID, tool: 'WebSearch', state: toolState }
    }

    case 'mcpToolCall': {
      const server = asString(item.server)
      const toolDisplay = asString(item.tool)
      const args = item.arguments
      const result = item.result
      const errorMsg = asString(item.error) ?? undefined
      const input: Record<string, unknown> = {}
      if (args !== undefined) input.arguments = args

      const toolState = buildToolState(
        status,
        Object.keys(input).length > 0 ? input : undefined,
        undefined,
        isTerminal && status === 'completed' ? result : undefined,
        errorMsg,
        undefined,
        start
      )
      if (isTerminal) clearStart(state, callID)

      return {
        type: 'tool',
        callID,
        tool: 'McpTool',
        ...(server ? { mcpServer: server } : {}),
        ...(toolDisplay ? { toolDisplay } : {}),
        state: toolState
      }
    }

    case 'agentMessage':
    case 'reasoning':
    case 'userMessage':
      // Text content is delivered via deltas + final message.updated.
      // Item lifecycle for these is not surfaced as a tool card.
      return null

    default: {
      // Unknown item type → surface as Unknown so it's visible in UI rather
      // than silently dropped. This helps catch protocol additions.
      const toolState = buildToolState(status, undefined, undefined, undefined, undefined, undefined, start)
      if (isTerminal) clearStart(state, callID)
      return {
        type: 'tool',
        callID,
        tool: 'Unknown',
        ...(itemType ? { toolDisplay: itemType } : {}),
        state: toolState
      }
    }
  }
}

// ── Helpers for outgoing stream events ───────────────────────────

function toTextPart(text: string): { part: { type: 'text'; text: string }; delta: string } {
  return { part: { type: 'text', text }, delta: text }
}

function toReasoningPart(text: string): {
  part: { type: 'reasoning'; text: string }
  delta: string
} {
  return { part: { type: 'reasoning', text }, delta: text }
}

function emitToolPart(
  hiveSessionId: string,
  toolPart: ToolPart
): OpenCodeStreamEvent {
  return {
    type: 'message.part.updated',
    sessionId: hiveSessionId,
    data: { part: toolPart as unknown as Record<string, unknown> }
  }
}

// ── Turn payload extraction (preserved API) ──────────────────────

interface TurnCompletedInfo {
  status: string
  error?: string
  usage?: Record<string, unknown>
  cost?: number
}

function extractTurnCompletedInfo(event: CodexManagerEvent): TurnCompletedInfo {
  const payload = asObject(event.payload)
  const turnObj = asObject(payload?.turn)
  const status = asString(turnObj?.status) ?? asString(payload?.state) ?? 'completed'
  const error = asString(turnObj?.error) ?? asString(payload?.error) ?? event.message
  const usage = asObject(turnObj?.usage) ?? asObject(payload?.usage)
  const cost = asNumber(turnObj?.cost) ?? asNumber(payload?.cost)
  return {
    status,
    ...(error ? { error } : {}),
    ...(usage ? { usage } : {}),
    ...(cost !== undefined ? { cost } : {})
  }
}

// ── Token usage extraction ───────────────────────────────────────

function tokenUsageEvent(
  event: CodexManagerEvent,
  hiveSessionId: string
): OpenCodeStreamEvent | null {
  const payload = asObject(event.payload)
  const tokenUsage = asObject(payload?.tokenUsage)
  if (!tokenUsage) return null
  const total = asObject(tokenUsage.total)
  const contextWindow = asNumber(tokenUsage.modelContextWindow)
  const inputTokens = asNumber(total?.inputTokens) ?? 0
  const outputTokens = asNumber(total?.outputTokens) ?? 0
  const cachedInputTokens = asNumber(total?.cachedInputTokens)
  const reasoningTokens = asNumber(total?.reasoningOutputTokens)
  return {
    type: 'session.context_usage',
    sessionId: hiveSessionId,
    data: {
      tokens: {
        input: inputTokens,
        output: outputTokens,
        ...(cachedInputTokens !== undefined ? { cacheRead: cachedInputTokens } : {}),
        ...(reasoningTokens !== undefined ? { reasoning: reasoningTokens } : {})
      },
      ...(contextWindow !== undefined ? { contextWindow } : {})
    }
  }
}

// ── Main mapper ──────────────────────────────────────────────────

export function mapCodexEventToStreamEvents(
  event: CodexManagerEvent,
  hiveSessionId: string,
  mapperState?: CodexMapperState
): OpenCodeStreamEvent[] {
  const { method } = event

  // ── Manager-level error ──────────────────────────────────────
  if (event.kind === 'error') {
    if (event.method === 'process/error') {
      return [
        {
          type: 'session.error',
          sessionId: hiveSessionId,
          data: { error: event.message ?? 'Unknown error' }
        }
      ]
    }
    return []
  }

  // ── Stderr is informational ──────────────────────────────────
  if (method === 'process/stderr') {
    return []
  }

  // ── Content deltas ───────────────────────────────────────────
  const streamKind = contentStreamKindFromMethod(method)
  if (streamKind) {
    const text =
      event.textDelta ??
      asString(asObject(event.payload)?.delta) ??
      asString(asObject(asObject(event.payload)?.delta)?.text)
    if (!text) return []
    return [
      {
        type: 'message.part.updated',
        sessionId: hiveSessionId,
        data:
          streamKind === 'reasoning' || streamKind === 'reasoning_summary'
            ? toReasoningPart(text)
            : toTextPart(text)
      }
    ]
  }

  // ── commandExecution outputDelta → tool part state.output ────
  if (method === 'item/commandExecution/outputDelta') {
    const callID = event.itemId ?? asString(asObject(event.payload)?.itemId)
    const delta = asString(asObject(event.payload)?.delta)
    if (!callID || !delta) return []
    const start = trackStart(mapperState, callID)
    const { output, metadata } = appendOutput(mapperState, callID, delta)
    // We don't yet know the canonical tool name (Bash vs Read vs Grep) until
    // item/started fires. Most flows are: item/started arrives BEFORE the
    // first outputDelta. So by the time a delta comes in, we've seen the
    // started item and the renderer has a tool part already keyed by
    // callID. The store does partial-update merge: if we send a tool part
    // with no `tool` field, the previous tool name is preserved.
    //
    // However our typed ToolPart REQUIRES `tool`. So we send a Bash
    // placeholder; the store's merge logic will keep the previously-seen
    // tool name (e.g. Read promoted from commandActions). This is safe.
    const placeholder: ToolPart = {
      type: 'tool',
      callID,
      tool: 'Bash',
      state: buildToolState('running', undefined, output, undefined, undefined, metadata, start)
    }
    return [emitToolPart(hiveSessionId, placeholder)]
  }

  // ── fileChange outputDelta is just "Success." text — drop ────
  if (method === 'item/fileChange/outputDelta') {
    return []
  }

  // ── Item lifecycle (started / updated / completed) ───────────
  if (
    method === 'item/started' ||
    method === 'item.started' ||
    method === 'item/updated' ||
    method === 'item.updated' ||
    method === 'item/completed' ||
    method === 'item.completed'
  ) {
    const item = asObject(asObject(event.payload)?.item)
    if (!item) return []
    const isCompleted =
      method === 'item/completed' || method === 'item.completed'
    const isStarted = method === 'item/started' || method === 'item.started'
    let status: ToolStatus
    if (isCompleted) {
      status = normalizeCodexStatus(item.status ?? 'completed')
    } else if (isStarted) {
      status = normalizeCodexStatus(item.status ?? 'inProgress')
    } else {
      status = normalizeCodexStatus(item.status ?? 'inProgress')
    }
    const toolPart = itemToolPart(item, status, mapperState)
    if (!toolPart) return []
    return [emitToolPart(hiveSessionId, toolPart)]
  }

  // ── Turn lifecycle ───────────────────────────────────────────
  if (method === 'turn/started') {
    return [
      {
        type: 'session.status',
        sessionId: hiveSessionId,
        data: { status: { type: 'busy' } },
        statusPayload: { type: 'busy' }
      }
    ]
  }

  if (method === 'turn/completed') {
    const info = extractTurnCompletedInfo(event)
    const out: OpenCodeStreamEvent[] = []
    if (info.status === 'failed') {
      out.push({
        type: 'session.error',
        sessionId: hiveSessionId,
        data: { error: info.error ?? 'Turn failed' }
      })
    }
    if (info.usage || info.cost !== undefined) {
      out.push({
        type: 'message.updated',
        sessionId: hiveSessionId,
        data: {
          ...(info.usage ? { usage: info.usage } : {}),
          ...(info.cost !== undefined ? { cost: info.cost } : {})
        }
      })
    }
    out.push({
      type: 'session.status',
      sessionId: hiveSessionId,
      data: { status: { type: 'idle' } },
      statusPayload: { type: 'idle' }
    })
    return out
  }

  // ── Plan update → synthesised TodoWrite tool part ────────────
  if (method === 'turn/plan/updated') {
    const todos = normalizeCodexPlanUpdateTodos(event.payload)
    const callID = buildCodexUpdatePlanCallId(event)
    const explanation = asString(asObject(event.payload)?.explanation)
    const start = trackStart(mapperState, callID)
    const input: Record<string, unknown> = { todos }
    if (explanation) input.explanation = explanation
    const toolPart: ToolPart = {
      type: 'tool',
      callID,
      tool: 'TodoWrite',
      state: buildToolState('completed', input, undefined, undefined, undefined, undefined, start)
    }
    return [emitToolPart(hiveSessionId, toolPart)]
  }

  // ── Turn-cumulative diff (codex-only; persist + future UI) ───
  if (method === 'turn/diff/updated') {
    const payload = asObject(event.payload)
    const diff = asString(payload?.diff)
    const turnId = asString(payload?.turnId) ?? event.turnId
    if (!diff || !turnId) return []
    return [
      {
        type: 'session.turn_diff',
        sessionId: hiveSessionId,
        data: { turnId, diff }
      }
    ]
  }

  // ── Token usage → context_usage ──────────────────────────────
  if (method === 'thread/tokenUsage/updated') {
    const ev = tokenUsageEvent(event, hiveSessionId)
    return ev ? [ev] : []
  }

  // ── Thread status → session.status (active = busy, idle = idle) ─
  if (method === 'thread/status/changed') {
    const status = asObject(asObject(event.payload)?.status)
    const t = asString(status?.type)
    if (t === 'active') {
      return [
        {
          type: 'session.status',
          sessionId: hiveSessionId,
          data: { status: { type: 'busy' } },
          statusPayload: { type: 'busy' }
        }
      ]
    }
    if (t === 'idle') {
      return [
        {
          type: 'session.status',
          sessionId: hiveSessionId,
          data: { status: { type: 'idle' } },
          statusPayload: { type: 'idle' }
        }
      ]
    }
    return []
  }

  // ── Thread name → session.updated ────────────────────────────
  if (method === 'thread/name/updated') {
    const title = asString(asObject(event.payload)?.threadName)
    if (!title) return []
    return [
      {
        type: 'session.updated',
        sessionId: hiveSessionId,
        data: { title, info: { title } }
      }
    ]
  }

  // ── Reasoning summary part marker — drop (no UI signal) ──────
  if (method === 'item/reasoning/summaryPartAdded') {
    return []
  }

  // ── Unknown / informational — drop ───────────────────────────
  return []
}
