import { randomUUID } from 'node:crypto'
import type {
  AgentTaskState,
  TaskStateStep,
  TaskStateDecision,
  TaskStateContext
} from '@shared/types/agent-task-state'
import {
  createTaskState,
  getTaskState,
  addStep,
  addDecision,
  addContext,
  setBlocker
} from '../../db/task-state-repository'
import type { DatabaseService } from '../../db/database'

export interface TaskStateManagerInput {
  taskRunId: string
  sessionId: string
  /** Kept optional for older tests/call sites; initialize(objective) is the source of truth. */
  objective?: string
  db?: DatabaseService | null
}

export interface TurnInfo {
  userMessage: string
  assistantMessage: string
  toolCalls: Array<{
    name: string
    args: Record<string, unknown>
    result: string
    isError?: boolean
  }>
  filesChanged: string[]
  errors: string[]
}

const DECISION_KEYWORDS = [
  'decided',
  'chose',
  'selected',
  'determined',
  'concluded',
  '决定',
  '选择',
  '采用',
  '确认',
  '判断',
  '结论'
]

export class TaskStateManager {
  private taskRunId: string
  private sessionId: string
  private db?: DatabaseService | null

  constructor(input: TaskStateManagerInput) {
    this.taskRunId = input.taskRunId
    this.sessionId = input.sessionId
    this.db = input.db
  }

  initialize(objective: string): AgentTaskState {
    const existing = this.getState()
    if (existing) return existing

    return createTaskState(
      {
        taskRunId: this.taskRunId,
        sessionId: this.sessionId,
        objective
      },
      this.db
    )
  }

  getState(): AgentTaskState | null {
    return getTaskState(this.taskRunId, this.db)
  }

  updateFromTurn(turnInfo: TurnInfo): AgentTaskState | null {
    const state = this.getState()
    if (!state) return null

    const newSteps = this.extractSteps(turnInfo)
    for (const step of newSteps) {
      addStep(this.taskRunId, step, this.db)
    }

    const newDecisions = this.extractDecisions(turnInfo)
    for (const decision of newDecisions) {
      addDecision(this.taskRunId, decision, this.db)
    }

    const newContext = this.extractContext(turnInfo)
    for (const context of newContext) {
      addContext(this.taskRunId, context, this.db)
    }

    setBlocker(this.taskRunId, turnInfo.errors[0] ?? null, this.db)

    return this.getState()
  }

  private extractSteps(turnInfo: TurnInfo): TaskStateStep[] {
    return turnInfo.toolCalls.map((toolCall) => {
      const timestamp = new Date().toISOString()
      return {
        id: `${this.taskRunId}-step-${randomUUID()}`,
        description: `Execute ${toolCall.name}`,
        status: toolCall.isError ? 'failed' : 'completed',
        startedAt: timestamp,
        completedAt: timestamp,
        result: this.summarizeToolResult(toolCall.result)
      }
    })
  }

  private extractDecisions(turnInfo: TurnInfo): TaskStateDecision[] {
    const decisions: TaskStateDecision[] = []
    const sentences = turnInfo.assistantMessage
      .split(/(?<=[.!?。！？])\s+|[\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)

    for (const sentence of sentences) {
      const lowerSentence = sentence.toLowerCase()
      if (!DECISION_KEYWORDS.some((keyword) => lowerSentence.includes(keyword))) continue

      decisions.push({
        id: `${this.taskRunId}-decision-${randomUUID()}`,
        context: 'Assistant reasoning',
        decision: this.summarizeToolResult(sentence),
        reason: 'Extracted from assistant message',
        timestamp: new Date().toISOString()
      })
    }

    return decisions
  }

  private extractContext(turnInfo: TurnInfo): TaskStateContext[] {
    const context: TaskStateContext[] = []

    for (const file of turnInfo.filesChanged) {
      context.push({
        id: `${this.taskRunId}-file-${randomUUID()}`,
        type: 'file',
        content: file,
        relevance: 0.8,
        timestamp: new Date().toISOString()
      })
    }

    for (const error of turnInfo.errors) {
      context.push({
        id: `${this.taskRunId}-error-${randomUUID()}`,
        type: 'error',
        content: this.summarizeToolResult(error),
        relevance: 0.9,
        timestamp: new Date().toISOString()
      })
    }

    return context
  }

  private summarizeToolResult(result: string): string {
    const normalized = result.trim()
    if (normalized.length > 240) {
      return `${normalized.slice(0, 240)}...`
    }
    return normalized
  }

  buildContextSummary(): string {
    const state = this.getState()
    if (!state) return ''

    const parts: string[] = []

    parts.push(`## Task Objective\n${state.objective}`)

    if (state.currentBlocker) {
      parts.push(`## Current Blocker\n${state.currentBlocker}`)
    }

    const recentSteps = state.steps.slice(-5)
    if (recentSteps.length > 0) {
      parts.push('## Recent Steps')
      for (const step of recentSteps) {
        const status = step.status === 'completed' ? '✓' : step.status === 'failed' ? '✗' : '...'
        const result = step.result ? ` — ${step.result}` : ''
        parts.push(`- ${status} ${step.description}${result}`)
      }
    }

    const recentDecisions = state.decisions.slice(-3)
    if (recentDecisions.length > 0) {
      parts.push('## Key Decisions')
      for (const decision of recentDecisions) {
        parts.push(`- ${decision.decision}`)
      }
    }

    const recentContext = state.relevantContext.slice(-5)
    if (recentContext.length > 0) {
      parts.push('## Relevant Context')
      for (const ctx of recentContext) {
        parts.push(`- [${ctx.type}] ${ctx.content}`)
      }
    }

    return parts.join('\n\n')
  }
}
