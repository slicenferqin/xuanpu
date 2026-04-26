/**
 * @deprecated since v1.4.4. Use `RawAgentEvent` from
 * `@shared/types/agent-protocol` instead. The two are structurally
 * compatible, but `RawAgentEvent` is a typed union that prevents the
 * "stdout leaked into a text part" class of bug. New code MUST emit
 * `RawAgentEvent`; existing call sites are scheduled for migration in a
 * follow-up PR.
 *
 * Why kept around: removing it now would touch ~25 import sites across
 * the renderer, hub bridge, and a few tests. Doing it lazily lets each
 * affected file migrate independently without a blocking refactor.
 */
export interface OpenCodeStreamEvent {
  type: string
  sessionId: string
  data: unknown
  childSessionId?: string
  statusPayload?: {
    type: 'idle' | 'busy' | 'retry'
    attempt?: number
    message?: string
    next?: number
  }
}

export interface OpenCodeCommand {
  name: string
  description?: string
  template: string
  agent?: string
  model?: string
  source?: 'command' | 'mcp' | 'skill'
  subtask?: boolean
  hints?: string[]
}

export interface PermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: {
    messageID: string
    callID: string
  }
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; url: string; filename?: string }
