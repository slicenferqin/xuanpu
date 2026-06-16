export interface TaskStateStep {
  id: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  startedAt?: string
  completedAt?: string
  result?: string
}

export interface TaskStateDecision {
  id: string
  context: string
  decision: string
  reason: string
  timestamp: string
}

export interface TaskStateContext {
  id: string
  type: 'file' | 'command' | 'error' | 'reference'
  content: string
  relevance: number
  timestamp: string
}

export interface AgentTaskState {
  id: string
  taskRunId: string
  sessionId: string
  objective: string
  steps: TaskStateStep[]
  currentBlocker: string | null
  decisions: TaskStateDecision[]
  relevantContext: TaskStateContext[]
  updatedAt: string
}

export interface AgentTaskStateCreate {
  taskRunId: string
  sessionId: string
  objective: string
}

export interface AgentTaskStateUpdate {
  objective?: string
  steps?: TaskStateStep[]
  currentBlocker?: string | null
  decisions?: TaskStateDecision[]
  relevantContext?: TaskStateContext[]
}
