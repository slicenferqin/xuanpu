/**
 * OpenCode activity mapper — converts live OpenCode SDK events into durable
 * `SessionActivity` records, mirroring `codex-activity-mapper.ts` so OpenCode
 * sessions get the same history-replay treatment Codex enjoys after 1.4.4.
 *
 * Input shape: the same `event` object that `OpenCodeService.handleEvent`
 * receives from the SDK iterator — `{ type, properties: { ... } }`. Only the
 * subset that matters for activity persistence is mapped. Unknown / noisy
 * events return `null`.
 *
 * Output shape: `SessionActivityCreate` consumed by
 * `DatabaseService.upsertSessionActivity`.
 *
 * Mapping table:
 *   message.part.updated (part.type === 'tool')
 *     state.status:
 *       running    → tool.started   (only first time we see this callID)
 *       running    → tool.updated   (subsequent running updates)
 *       completed  → tool.completed
 *       error      → tool.failed
 *       cancelled  → tool.failed (treated as failure, tone=error)
 *   session.idle               → session.info ("Session idle")
 *   session.error              → session.error
 *   question.asked             → user-input.requested
 *   permission.asked           → approval.requested
 *   command.approval_needed    → approval.requested
 *   anything else              → null
 */
import { randomUUID } from 'node:crypto'
import type {
  SessionActivityCreate,
  SessionActivityKind,
  SessionActivityTone
} from '../db/types'

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------
//
// We don't import OpenCode SDK types here to keep this module renderable in
// pure-node tests without the full SDK dependency tree. The event shape is
// permissive: any object with a `type` and `properties` is accepted.

export interface OpenCodeRawEvent {
  type?: string
  properties?: Record<string, unknown>
}

// Tool callIDs we've already emitted a `tool.started` for. Used to flip
// subsequent `running` updates into `tool.updated`. The caller (per-session)
// owns this set so it survives across many events but resets per session.
export type ToolStartedTracker = Set<string>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function stringifyPayload(payload: unknown): string | null {
  if (payload === undefined) return null
  try {
    return JSON.stringify(payload)
  } catch {
    return null
  }
}

function buildActivity(
  hiveSessionId: string,
  agentSessionId: string | null,
  kind: SessionActivityKind,
  tone: SessionActivityTone,
  summary: string,
  payload: unknown,
  options?: {
    id?: string
    itemId?: string | null
    requestId?: string | null
    createdAt?: string
  }
): SessionActivityCreate {
  return {
    id: options?.id ?? randomUUID(),
    session_id: hiveSessionId,
    agent_session_id: agentSessionId,
    thread_id: null,
    turn_id: null,
    item_id: options?.itemId ?? null,
    request_id: options?.requestId ?? null,
    kind,
    tone,
    summary,
    payload_json: stringifyPayload(payload),
    created_at: options?.createdAt ?? new Date().toISOString()
  }
}

// ---------------------------------------------------------------------------
// Tool-part mapping
// ---------------------------------------------------------------------------

interface ToolMappingResult {
  kind: SessionActivityKind
  tone: SessionActivityTone
}

function mapToolStatus(
  status: string | undefined,
  alreadyStarted: boolean
): ToolMappingResult | null {
  switch (status) {
    case 'pending':
    case 'running':
      return alreadyStarted
        ? { kind: 'tool.updated', tone: 'tool' }
        : { kind: 'tool.started', tone: 'tool' }
    case 'completed':
      return { kind: 'tool.completed', tone: 'tool' }
    case 'error':
    case 'cancelled':
      return { kind: 'tool.failed', tone: 'error' }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map a single OpenCode raw event to a SessionActivity record. Returns `null`
 * when the event isn't relevant to activity persistence.
 *
 * `toolStartedTracker` is mutated in place when a tool transitions through
 * `running` so subsequent updates emit `tool.updated` instead of `tool.started`.
 * Pass a fresh `Set()` per session if you want clean replay semantics.
 */
export function mapOpenCodeEventToActivity(
  hiveSessionId: string,
  agentSessionId: string | null,
  event: OpenCodeRawEvent,
  toolStartedTracker: ToolStartedTracker
): SessionActivityCreate | null {
  const eventType = event.type
  if (!eventType) return null

  const properties = asObject(event.properties)

  // ---------------------------------------------------------------------
  // message.part.updated — tool lifecycle
  // ---------------------------------------------------------------------
  if (eventType === 'message.part.updated') {
    const part = asObject(properties?.part)
    if (!part || part.type !== 'tool') return null

    const callId = asString(part.callID) ?? asString(part.id)
    if (!callId) return null

    const state = asObject(part.state) ?? {}
    const status = asString(state.status)
    const alreadyStarted = toolStartedTracker.has(callId)
    const mapping = mapToolStatus(status, alreadyStarted)
    if (!mapping) return null

    if (mapping.kind === 'tool.started') {
      toolStartedTracker.add(callId)
    }
    if (mapping.kind === 'tool.completed' || mapping.kind === 'tool.failed') {
      // Free the slot so a fresh callID re-using the same string starts clean.
      toolStartedTracker.delete(callId)
    }

    const toolName =
      asString(part.toolDisplay) ?? asString(part.tool) ?? asString(part.name) ?? 'tool'

    return buildActivity(
      hiveSessionId,
      agentSessionId,
      mapping.kind,
      mapping.tone,
      toolName,
      part,
      {
        id: `${callId}:${mapping.kind}`,
        itemId: callId
      }
    )
  }

  // ---------------------------------------------------------------------
  // session.idle — turn finished
  // ---------------------------------------------------------------------
  if (eventType === 'session.idle') {
    return buildActivity(
      hiveSessionId,
      agentSessionId,
      'session.info',
      'info',
      'Session idle',
      properties ?? {}
    )
  }

  // ---------------------------------------------------------------------
  // session.error — runtime failure
  // ---------------------------------------------------------------------
  if (eventType === 'session.error') {
    const errorObj = asObject(properties?.error)
    const message =
      asString(errorObj?.message) ??
      asString(properties?.message) ??
      asString(properties?.error) ??
      'Session error'
    return buildActivity(
      hiveSessionId,
      agentSessionId,
      'session.error',
      'error',
      message,
      properties ?? {}
    )
  }

  // ---------------------------------------------------------------------
  // question.asked — interactive question prompt
  // ---------------------------------------------------------------------
  if (eventType === 'question.asked') {
    const requestId = asString(properties?.requestId) ?? asString(properties?.id)
    const id = asString(properties?.id) ?? requestId ?? randomUUID()
    return buildActivity(
      hiveSessionId,
      agentSessionId,
      'user-input.requested',
      'approval',
      'User input requested',
      properties ?? {},
      {
        id: `${id}:user-input.requested`,
        itemId: id,
        requestId: requestId ?? null
      }
    )
  }

  // ---------------------------------------------------------------------
  // permission.asked — tool permission gate
  // ---------------------------------------------------------------------
  if (eventType === 'permission.asked') {
    const id = asString(properties?.id) ?? randomUUID()
    const summary =
      asString(properties?.permission) ??
      (Array.isArray(properties?.patterns) && (properties.patterns as unknown[]).length > 0
        ? `Permission requested: ${(properties.patterns as unknown[]).join(', ')}`
        : 'Permission requested')
    return buildActivity(
      hiveSessionId,
      agentSessionId,
      'approval.requested',
      'approval',
      summary,
      properties ?? {},
      {
        id: `${id}:approval.requested`,
        itemId: id
      }
    )
  }

  // ---------------------------------------------------------------------
  // command.approval_needed — command filter approval
  // ---------------------------------------------------------------------
  if (eventType === 'command.approval_needed') {
    const requestId = asString(properties?.requestId) ?? randomUUID()
    const summary =
      asString(properties?.commandStr) ??
      asString(properties?.command) ??
      'Command approval required'
    return buildActivity(
      hiveSessionId,
      agentSessionId,
      'approval.requested',
      'approval',
      summary,
      properties ?? {},
      {
        id: `${requestId}:approval.requested`,
        requestId
      }
    )
  }

  return null
}
