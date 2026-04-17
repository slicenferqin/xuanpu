export type SharedAgentRuntimeId = 'opencode' | 'claude-code' | 'codex' | 'terminal'
export type SharedAgentRuntimeAvailability = Record<SharedAgentRuntimeId, boolean>

export interface AgentStatusPayload {
  type: 'idle' | 'busy' | 'retry'
  attempt?: number
  message?: string
  next?: number
}

export interface AgentSessionMaterializedData {
  newSessionId: string
  wasFork: boolean
}

export interface AgentSessionUpdatedData {
  title?: string
  info?: {
    title?: string
  }
  revertMessageID?: string | null
}

export interface AgentSessionContextUsageData {
  tokens: {
    input: number
    cacheRead?: number
    cacheWrite?: number
    output: number
    reasoning?: number
  }
  model?: {
    providerID: string
    modelID: string
    variant?: string
  }
  contextWindow?: number
}

export interface AgentPartUpdatedData {
  part?: Record<string, unknown>
  delta?: string
  type?: 'task'
  taskId?: string
  status?: string
  message?: string
  progress?: number
}

export interface AgentMessageUpdatedData {
  usage?: Record<string, unknown>
  cost?: number
  info?: Record<string, unknown>
  parts?: unknown[]
}

export interface AgentQuestionData {
  requestId: string
  id: string
  questions: unknown[]
}

export interface AgentQuestionResolutionData {
  requestId: string
  id: string
}

export interface AgentPermissionData {
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

export interface AgentPermissionResolutionData {
  requestId: string
  id: string
  decision?: 'once' | 'always' | 'reject'
}

export interface AgentPlanReadyData {
  id: string
  requestId: string
  plan: string
  toolUseID: string
}

export interface AgentPlanResolvedData {
  requestId?: string
  id?: string
}

// ---------------------------------------------------------------------------
// Event Envelope — added by every emitAgentEvent() call and by the preload
// normalizer for legacy events that lack these fields.
// ---------------------------------------------------------------------------
export interface EventEnvelope {
  /** Unique identifier for deduplication (UUID v4). */
  eventId: string
  /** Monotonically increasing counter per session, for ordering. */
  sessionSequence: number
  /** Which IPC channel the event arrived on (set by preload normalizer). */
  sourceChannel?: 'agent:stream'
}

// ---------------------------------------------------------------------------
// Model limits data — emitted by Claude Code implementer on session init
// ---------------------------------------------------------------------------
export interface AgentModelLimitsData {
  models: Array<{
    modelID: string
    providerID: string
    contextLimit: number
  }>
}

// ---------------------------------------------------------------------------
// Command approval problem data
// ---------------------------------------------------------------------------
export interface AgentCommandApprovalProblemData {
  requestId: string
  commandStr: string
  reason: string
  suggestion?: string
}

// ---------------------------------------------------------------------------
// Canonical Agent Event — the union consumed by renderer
// ---------------------------------------------------------------------------
export type CanonicalAgentEvent = EventEnvelope & (
  | {
      type: 'session.materialized'
      sessionId: string
      runtimeId?: SharedAgentRuntimeId
      data: AgentSessionMaterializedData
      childSessionId?: string
    }
  | {
      type: 'session.status'
      sessionId: string
      runtimeId?: SharedAgentRuntimeId
      data: { status: AgentStatusPayload }
      /** Canonical location for status payload (normalizer ensures this). */
      statusPayload?: AgentStatusPayload
      childSessionId?: string
    }
  | {
      type: 'session.updated'
      sessionId: string
      runtimeId?: SharedAgentRuntimeId
      data: AgentSessionUpdatedData
      childSessionId?: string
    }
  | {
      type:
        | 'session.warning'
        | 'session.error'
        | 'session.context_compacted'
        | 'session.compaction_started'
        | 'session.idle'
      sessionId: string
      runtimeId?: SharedAgentRuntimeId
      data: Record<string, unknown>
      childSessionId?: string
    }
  | {
      type: 'session.commands_available'
      sessionId: string
      runtimeId?: SharedAgentRuntimeId
      data: Record<string, unknown>
      childSessionId?: string
    }
  | {
      type: 'session.model_limits'
      sessionId: string
      runtimeId?: SharedAgentRuntimeId
      data: AgentModelLimitsData
      childSessionId?: string
    }
  | {
      type: 'session.context_usage'
      sessionId: string
      runtimeId?: SharedAgentRuntimeId
      data: AgentSessionContextUsageData
      childSessionId?: string
    }
  | {
      type: 'message.part.updated'
      sessionId: string
      runtimeId?: SharedAgentRuntimeId
      data: AgentPartUpdatedData
      childSessionId?: string
    }
  | {
      type: 'message.updated'
      sessionId: string
      runtimeId?: SharedAgentRuntimeId
      data: AgentMessageUpdatedData
      childSessionId?: string
    }
  | {
      type: 'question.asked'
      sessionId: string
      runtimeId?: SharedAgentRuntimeId
      data: AgentQuestionData
      childSessionId?: string
    }
  | {
      type: 'question.replied' | 'question.rejected'
      sessionId: string
      runtimeId?: SharedAgentRuntimeId
      data: AgentQuestionResolutionData
      childSessionId?: string
    }
  | {
      type: 'permission.asked'
      sessionId: string
      runtimeId?: SharedAgentRuntimeId
      data: AgentPermissionData
      childSessionId?: string
    }
  | {
      type: 'permission.replied'
      sessionId: string
      runtimeId?: SharedAgentRuntimeId
      data: AgentPermissionResolutionData
      childSessionId?: string
    }
  | {
      type: 'command.approval_needed' | 'command.approval_replied'
      sessionId: string
      runtimeId?: SharedAgentRuntimeId
      data: Record<string, unknown>
      childSessionId?: string
    }
  | {
      type: 'command.approval_problem'
      sessionId: string
      runtimeId?: SharedAgentRuntimeId
      data: AgentCommandApprovalProblemData
      childSessionId?: string
    }
  | {
      type: 'plan.ready'
      sessionId: string
      runtimeId?: SharedAgentRuntimeId
      data: AgentPlanReadyData
      childSessionId?: string
    }
  | {
      type: 'plan.resolved'
      sessionId: string
      runtimeId?: SharedAgentRuntimeId
      data: AgentPlanResolvedData
      childSessionId?: string
    }
)

// ---------------------------------------------------------------------------
// Legacy event shape — what implementers emit before the envelope is added.
// Used by emitAgentEvent() and normalizeAgentEvent() as input type.
// ---------------------------------------------------------------------------
export type RawAgentEvent = Omit<CanonicalAgentEvent, keyof EventEnvelope> &
  Partial<EventEnvelope>

export interface AgentCommand {
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
