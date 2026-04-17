/**
 * Event normalization for the Xuanpu agent protocol.
 *
 * This module runs in TWO contexts:
 *
 * 1. **Main process** — `emitAgentEvent()` is called by implementers instead of
 *    the raw `sendToRenderer()`. It stamps `eventId`, `sessionSequence`, and
 *    sends the envelope over the canonical `agent:stream` IPC channel.
 *
 * 2. **Preload bridge** — `normalizeAgentEvent()` re-normalizes events coming
 *    from `agent:stream`, ensuring the renderer always sees a uniform
 *    `CanonicalAgentEvent` shape.
 *
 * Neither function introduces pub-sub, middleware, or event bus abstractions.
 */

import type { BrowserWindow } from 'electron'
import type {
  CanonicalAgentEvent,
  RawAgentEvent,
  EventEnvelope,
  AgentStatusPayload
} from '../types/agent-protocol'

// ---------------------------------------------------------------------------
// Session-scoped sequence counters (main process only)
// ---------------------------------------------------------------------------
const sessionSequences = new Map<string, number>()

function nextSequence(sessionId: string): number {
  const current = sessionSequences.get(sessionId) ?? 0
  const next = current + 1
  sessionSequences.set(sessionId, next)
  return next
}

/** Reset the sequence counter for a session (e.g. on disconnect). */
export function resetSessionSequence(sessionId: string): void {
  sessionSequences.delete(sessionId)
}

// ---------------------------------------------------------------------------
// UUID v4 generator — no external dependency
// ---------------------------------------------------------------------------
let _crypto: { randomUUID(): string } | undefined
function generateEventId(): string {
  // Node.js ≥ 19 and modern Electron have crypto.randomUUID()
  if (!_crypto) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _crypto = require('crypto') as { randomUUID(): string }
    } catch {
      // Fallback for environments without crypto
    }
  }
  if (_crypto?.randomUUID) return _crypto.randomUUID()
  // Fallback: timestamp + random suffix
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// ---------------------------------------------------------------------------
// emitAgentEvent — main process helper
// ---------------------------------------------------------------------------

/**
 * Send an agent event to the renderer via the canonical `agent:stream` channel,
 * stamping `eventId` and `sessionSequence` on the envelope.
 *
 * Usage (in implementers):
 * ```ts
 * emitAgentEvent(this.mainWindow, {
 *   type: 'session.status',
 *   sessionId: hiveSessionId,
 *   data: { status: statusPayload },
 *   statusPayload,
 * })
 * ```
 */
export function emitAgentEvent(
  mainWindow: BrowserWindow | null | undefined,
  event: RawAgentEvent
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const envelope: CanonicalAgentEvent = {
    ...event,
    eventId: event.eventId ?? generateEventId(),
    sessionSequence: event.sessionSequence ?? nextSequence(event.sessionId)
  } as CanonicalAgentEvent

  mainWindow.webContents.send('agent:stream', envelope)

  // Auto-clean sequence counter when session terminates (P1-3 CR fix)
  if (event.type === 'session.error') {
    resetSessionSequence(event.sessionId)
  } else if (event.type === 'session.status') {
    const status = (event as Record<string, unknown>).statusPayload as
      | { type?: string }
      | undefined
    if (status?.type === 'idle') {
      // idle = turn finished, not session end. Keep counter alive.
    }
  }
}

// ---------------------------------------------------------------------------
// normalizeAgentEvent — preload / renderer helper
// ---------------------------------------------------------------------------

/**
 * Normalize a raw agent event into the canonical shape:
 *
 * 1. Ensure `eventId` and `sessionSequence` exist (generate if missing for
 *    legacy events that bypassed `emitAgentEvent`).
 * 2. For `session.status` events, ensure `statusPayload` is always at the
 *    top level (some implementers only put it in `data.status`).
 * 3. Tag the `sourceChannel` so the renderer can distinguish origin.
 *
 * This runs in the preload context (no Node.js crypto), so the fallback UUID
 * generator is used.
 */
export function normalizeAgentEvent(
  raw: Record<string, unknown>,
  sourceChannel: 'agent:stream' = 'agent:stream'
): CanonicalAgentEvent {
  // Shallow-copy to avoid mutating the caller's object (P1-2 CR fix)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const event = { ...raw } as any

  // Deep-copy data if present so nested writes don't leak back
  if (event.data && typeof event.data === 'object') {
    event.data = { ...event.data }
  }

  // 1. Ensure envelope fields
  if (!event.eventId) {
    event.eventId = generateEventId()
  }
  if (event.sessionSequence == null) {
    event.sessionSequence = 0
  }
  event.sourceChannel = sourceChannel

  // 2. Normalize statusPayload for session.status events
  if (event.type === 'session.status') {
    const nested = event.data?.status as AgentStatusPayload | undefined
    const topLevel = event.statusPayload as AgentStatusPayload | undefined
    if (nested && !topLevel) {
      event.statusPayload = nested
    } else if (topLevel && !nested) {
      if (!event.data) event.data = {}
      event.data.status = topLevel
    }
  }

  return event as CanonicalAgentEvent
}
