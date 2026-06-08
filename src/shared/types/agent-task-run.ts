export type TaskRunAutonomy = 'short' | 'long' | 'overnight'

export type TaskRunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'aborted'

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

export type EpochStatus = 'running' | 'checkpointed' | 'compacted' | 'closed' | 'failed'

export type EpochCloseReason = 'checkpoint' | 'compact' | 'watchdog' | 'turn_end'

export interface AgentEpoch {
  id: string
  taskRunId: string
  sessionId: string
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
