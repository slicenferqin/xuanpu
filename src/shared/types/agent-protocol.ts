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
  breakdown?: {
    usedTokens: number
    maxTokens: number
    rawMaxTokens?: number
    percentage: number
    categories?: Array<{
      name: string
      tokens: number
      color?: string
      isDeferred?: boolean
    }>
  }
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

// ---------------------------------------------------------------------------
// ToolPart contract — typed shape for `part: { type: 'tool', ... }`
// ---------------------------------------------------------------------------
//
// Runtimes (codex, claude-code, opencode) all emit message.part.updated with
// part.type === 'tool'. This is the canonical shape they MUST adhere to.
// AgentPartUpdatedData.part is intentionally left as Record<string, unknown>
// for forward-compat (we don't want to lock out experimental fields), but
// every concrete tool emission should match ToolPart.
//
// Tool-name normalization rules (see CanonicalToolName below):
//   - Use first-letter-uppercased canonical names (Bash / Read / Edit / etc.)
//   - For codex `commandExecution` items, mappers should "promote" via
//     `commandActions[]` so a single-action `cat` becomes Read, `rg` becomes
//     Grep, etc. Multi-action commands stay as Bash with `input.actions`.
//   - For codex `mcpToolCall`, use 'McpTool' and put the original name in
//     toolDisplay + the server in mcpServer.
//   - For codex `turn/plan/updated`, use 'TodoWrite' with synthetic
//     callID = `update_plan-<turnId>`.

/** Canonical tool name across runtimes. */
export type CanonicalToolName =
  | 'Bash'
  | 'Read'
  | 'Grep'
  | 'Glob'
  | 'Write'
  | 'Edit'
  | 'WebSearch'
  | 'WebFetch'
  | 'TodoWrite'
  | 'Task'
  | 'McpTool'
  | 'Unknown'

/** Tool lifecycle status. Implementers must normalize before emitting. */
export type ToolStatus = 'pending' | 'running' | 'completed' | 'error' | 'cancelled'

/**
 * Tool input. Each CanonicalToolName has expected fields documented below;
 * the type stays a Record so runtimes can pass through extra metadata without
 * runtime narrowing churn.
 *
 *   Bash:      { command: string; cwd?: string; actions?: unknown[] }
 *   Read:      { file_path: string; lineRange?: [number, number]; displayName?: string }
 *   Grep:      { pattern: string; path?: string; flags?: string[] }
 *   Glob:      { pattern: string; path?: string }
 *   Write:     { file_path: string; content?: string }
 *   Edit:      { file_path?: string; old_string?: string; new_string?: string }
 *              | { changes: Array<{ path: string; diff: string; kind: 'create'|'update'|'delete'|'move' }> }
 *   WebSearch: { query: string; queries?: string[] }
 *   WebFetch:  { url: string }
 *   TodoWrite: { todos: Array<{ step?: string; content?: string; status: string }>; explanation?: string }
 *   Task:      { description?: string; agent?: string }
 *   McpTool:   { arguments?: unknown }
 *   Unknown:   passthrough
 */
export type ToolInput = Record<string, unknown>

/** Tool completion metadata. */
export interface ToolMetadata {
  exitCode?: number
  durationMs?: number
  filesAffected?: string[]
  truncated?: boolean
  truncatedBytes?: number
}

/** Tool state machine. status discriminates the union. */
export type ToolState =
  | { status: 'pending'; input?: ToolInput; time?: { start: number } }
  | { status: 'running'; input?: ToolInput; output?: string; time?: { start: number } }
  | {
      status: 'completed'
      input?: ToolInput
      output?: string
      result?: unknown
      metadata?: ToolMetadata
      time?: { start: number; end: number }
    }
  | {
      status: 'error'
      input?: ToolInput
      output?: string
      error: string
      metadata?: ToolMetadata
      time?: { start: number; end: number }
    }
  | {
      status: 'cancelled'
      input?: ToolInput
      output?: string
      metadata?: ToolMetadata
      time?: { start: number; end: number }
    }

/** Canonical tool part as carried in AgentPartUpdatedData.part. */
export interface ToolPart {
  type: 'tool'
  callID: string
  tool: CanonicalToolName
  /** Original (un-normalized) name; used for display and MCP-server context. */
  toolDisplay?: string
  /** MCP server name when tool === 'McpTool'. */
  mcpServer?: string
  state: ToolState
}

// ---------------------------------------------------------------------------
// session.turn_diff — codex-only event carrying turn-cumulative git diff.
// Persisted but not rendered yet (future "turn summary" UI will consume).
// ---------------------------------------------------------------------------
export interface AgentSessionTurnDiffData {
  turnId: string
  /** Unified git diff text. */
  diff: string
}

export interface AgentMessageUpdatedData {
  id?: string
  requestId?: string
  messageIndex?: number
  role?: string
  content?: unknown
  isError?: boolean
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
  /** Monotonically increasing run identifier per hive session. */
  runEpoch: number
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
export type CanonicalAgentEvent = EventEnvelope &
  (
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
        type: 'session.turn_diff'
        sessionId: string
        runtimeId?: SharedAgentRuntimeId
        data: AgentSessionTurnDiffData
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
export type RawAgentEvent = Omit<CanonicalAgentEvent, keyof EventEnvelope> & Partial<EventEnvelope>

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
