export type TaskRunAutonomy = 'short' | 'long' | 'overnight'

export type TaskRunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'aborted'

export type UserRoundOrigin = 'user-originated' | 'agent-continuation' | 'recovery-continuation'

export type UserRoundStatus = 'running' | 'completed' | 'failed' | 'aborted'

export interface AgentTaskRun {
  id: string
  sessionId: string
  worktreeId: string | null
  projectId: string
  originMessageId: string | null
  status: TaskRunStatus
  autonomy: TaskRunAutonomy
  objective: string | null
  leaseExpiresAt: string | null
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  epochCount: number
  startedAt: string
  completedAt: string | null
  errorMessage: string | null
}

export interface AgentUserRound {
  id: string
  taskRunId: string
  sessionId: string
  ordinal: number
  origin: UserRoundOrigin
  status: UserRoundStatus
  userMessageId: string | null
  promptText: string | null
  providerRequestCount: number
  contextSegmentCount: number
  startedAt: string
  completedAt: string | null
  errorMessage: string | null
}

export type EpochStatus = 'running' | 'checkpointed' | 'compacted' | 'closed' | 'failed'

export type EpochCloseReason = 'checkpoint' | 'compact' | 'watchdog' | 'turn_end'

export interface AgentEpoch {
  id: string
  taskRunId: string
  sessionId: string
  userRoundId: string | null
  ordinal: number
  status: EpochStatus
  checkpointId: string | null
  providerCallCount: number
  startFillRatio: number | null
  endFillRatio: number | null
  closeReason: EpochCloseReason | null
  startedAt: string
  closedAt: string | null
}

export type ContextSegmentStatus = EpochStatus

export type ContextSegmentCloseReason = EpochCloseReason

/**
 * Product-facing name for the runtime context segment.
 *
 * The DB table remains `agent_epochs` for compatibility with existing
 * migrations and IPC consumers, but UI and new repository APIs should prefer
 * ContextSegment terminology.
 */
export type AgentContextSegment = AgentEpoch

export interface AgentProviderRequestSummary {
  id: string
  turnId: string
  sessionId: string
  taskRunId: string | null
  userRoundId: string | null
  contextSegmentId: string | null
  contextSegmentOrdinal: number | null
  providerCallSeq: number
  providerRequestHash: string
  prefixHash: string | null
  managedApproxTokens: number
  providerEstimatedInputTokens: number
  maxContextTokens: number
  createdAt: string
}

export interface AgentProviderRequestReplay extends AgentProviderRequestSummary {
  xfpPacketId: string | null
  managedContextJson: string
  providerMessagesJson: string
  providerToolsJson: string
  providerConfigJson: string
  decisionsJson: string
}
