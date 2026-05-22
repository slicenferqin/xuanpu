import { randomUUID } from 'crypto'
import type {
  XfpAuditEvent,
  XfpAuditListInput,
  XfpFieldDeliveryMode,
  XfpAuditPrivacy,
  XfpAuditRuntimeId
} from '@shared/types/xfp-audit'

const MAX_EVENTS = 300
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200
const DEFAULT_SUMMARY_CHARS = 320

export interface XfpAuditRecordInput {
  worktreeId?: string | null
  sessionId?: string | null
  runtimeId: XfpAuditRuntimeId
  kind: XfpAuditEvent['kind']
  toolName: string
  input?: Record<string, unknown>
  outputSummary: string
  outputChars: number
  truncated?: boolean
  privacy?: XfpAuditPrivacy
}

export interface XfpAuditOutputSummary {
  outputSummary: string
  outputChars: number
  truncated: boolean
}

export interface XfpPromptObservationInput {
  worktreeId?: string | null
  sessionId?: string | null
  runtimeId: XfpAuditRuntimeId
  fieldDeliveryMode: XfpFieldDeliveryMode
  promptChars: number
  displayChars?: number
  fallbackChars?: number
  legacyInjectionChars?: number
  hasFieldContextEnvelope: boolean
  hasXfpFallbackPrefix: boolean
  hasFileAttachments: boolean
  attachmentCount?: number
  mcpAttached?: boolean
}

const events: XfpAuditEvent[] = []

export function summarizeXfpAuditOutput(
  value: unknown,
  maxChars = DEFAULT_SUMMARY_CHARS
): XfpAuditOutputSummary {
  const text = typeof value === 'string' ? value : safeStringify(value)
  const truncated = text.length > maxChars
  return {
    outputSummary: truncated ? `${text.slice(0, maxChars).trimEnd()}…` : text,
    outputChars: text.length,
    truncated
  }
}

export function inferXfpAuditPrivacy(value: unknown): XfpAuditPrivacy {
  if (isRecord(value) && value.disabled === true) return 'disabled'
  return 'allowed'
}

export function hasXfpTruncatedOutput(value: unknown): boolean {
  if (isRecord(value) && value.truncated === true) return true
  if (Array.isArray(value)) return value.some(hasXfpTruncatedOutput)
  if (!isRecord(value)) return false
  return Object.values(value).some(hasXfpTruncatedOutput)
}

export function recordXfpAuditEvent(input: XfpAuditRecordInput): XfpAuditEvent {
  const event: XfpAuditEvent = {
    id: randomUUID(),
    worktreeId: input.worktreeId ?? null,
    sessionId: input.sessionId ?? null,
    runtimeId: input.runtimeId,
    kind: input.kind,
    toolName: input.toolName,
    input: input.input ?? {},
    outputSummary: input.outputSummary,
    outputChars: Math.max(0, Math.floor(input.outputChars)),
    truncated: input.truncated ?? false,
    privacy: input.privacy ?? 'allowed',
    createdAt: Date.now()
  }

  events.push(event)
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS)
  }
  return event
}

export function recordXfpPromptObservation(input: XfpPromptObservationInput): XfpAuditEvent {
  const outputSummary = [
    `field delivery: ${input.fieldDeliveryMode}`,
    `${Math.max(0, Math.floor(input.promptChars))} runtime chars`,
    input.displayChars == null
      ? null
      : `${Math.max(0, Math.floor(input.displayChars))} display chars`,
    input.fallbackChars ? `${Math.max(0, Math.floor(input.fallbackChars))} fallback chars` : null,
    input.legacyInjectionChars
      ? `${Math.max(0, Math.floor(input.legacyInjectionChars))} legacy injection chars`
      : null,
    input.hasFileAttachments ? `${input.attachmentCount ?? 0} attachment(s)` : null
  ]
    .filter(Boolean)
    .join(' • ')

  return recordXfpAuditEvent({
    worktreeId: input.worktreeId ?? null,
    sessionId: input.sessionId ?? null,
    runtimeId: input.runtimeId,
    kind: 'prompt',
    toolName: 'field_delivery',
    input: {
      mode: input.fieldDeliveryMode,
      promptChars: Math.max(0, Math.floor(input.promptChars)),
      displayChars:
        input.displayChars == null ? undefined : Math.max(0, Math.floor(input.displayChars)),
      fallbackChars:
        input.fallbackChars == null ? undefined : Math.max(0, Math.floor(input.fallbackChars)),
      legacyInjectionChars:
        input.legacyInjectionChars == null
          ? undefined
          : Math.max(0, Math.floor(input.legacyInjectionChars)),
      hasFieldContextEnvelope: input.hasFieldContextEnvelope,
      hasXfpFallbackPrefix: input.hasXfpFallbackPrefix,
      hasFileAttachments: input.hasFileAttachments,
      attachmentCount: input.attachmentCount ?? 0,
      mcpAttached: input.mcpAttached
    },
    outputSummary,
    outputChars: outputSummary.length,
    truncated: false,
    privacy: 'allowed'
  })
}

export function listXfpAuditEvents(input: XfpAuditListInput = {}): XfpAuditEvent[] {
  const limit = normalizeLimit(input.limit)
  const filtered = events.filter((event) => {
    if (input.worktreeId && event.worktreeId !== input.worktreeId) return false
    if (input.sessionId && event.sessionId !== input.sessionId) return false
    return true
  })
  return filtered.slice(-limit).reverse()
}

export function clearXfpAuditEvents(input: XfpAuditListInput = {}): { deleted: number } {
  let deleted = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (input.worktreeId && event.worktreeId !== input.worktreeId) continue
    if (input.sessionId && event.sessionId !== input.sessionId) continue
    events.splice(index, 1)
    deleted += 1
  }
  return { deleted }
}

export function __resetXfpAuditForTest(): void {
  events.splice(0, events.length)
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIST_LIMIT
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(value)))
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
