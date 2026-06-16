import { randomUUID } from 'node:crypto'
import { getDatabase } from './database'
import type { DatabaseService } from './database'
import type {
  AgentTaskState,
  AgentTaskStateCreate,
  AgentTaskStateUpdate,
  TaskStateStep,
  TaskStateDecision,
  TaskStateContext
} from '@shared/types/agent-task-state'

const MAX_STEPS = 120
const MAX_DECISIONS = 60
const MAX_CONTEXT_ITEMS = 100

function resolveDb(db?: DatabaseService | null): ReturnType<DatabaseService['getDb']> {
  return db?.getDb() ?? getDatabase().getDb()
}

function mapTaskState(row: Record<string, unknown>): AgentTaskState {
  return {
    id: row.id as string,
    taskRunId: row.taskRunId as string,
    sessionId: row.sessionId as string,
    objective: row.objective as string,
    steps: JSON.parse((row.steps as string) ?? '[]') as TaskStateStep[],
    currentBlocker: (row.currentBlocker as string | null) ?? null,
    decisions: JSON.parse((row.decisions as string) ?? '[]') as TaskStateDecision[],
    relevantContext: JSON.parse((row.relevantContext as string) ?? '[]') as TaskStateContext[],
    updatedAt: row.updatedAt as string
  }
}

export function createTaskState(data: AgentTaskStateCreate, db?: DatabaseService | null): AgentTaskState {
  const record: AgentTaskState = {
    id: randomUUID(),
    taskRunId: data.taskRunId,
    sessionId: data.sessionId,
    objective: data.objective,
    steps: [],
    currentBlocker: null,
    decisions: [],
    relevantContext: [],
    updatedAt: new Date().toISOString()
  }

  resolveDb(db)
    .prepare(
      `INSERT INTO agent_task_states (
        id, task_run_id, session_id, objective, steps, current_blocker,
        decisions, relevant_context, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.taskRunId,
      record.sessionId,
      record.objective,
      JSON.stringify(record.steps),
      record.currentBlocker,
      JSON.stringify(record.decisions),
      JSON.stringify(record.relevantContext),
      record.updatedAt
    )

  return record
}

export function getTaskState(taskRunId: string, db?: DatabaseService | null): AgentTaskState | null {
  const row = resolveDb(db)
    .prepare(
      `SELECT id,
              task_run_id AS taskRunId,
              session_id AS sessionId,
              objective,
              steps,
              current_blocker AS currentBlocker,
              decisions,
              relevant_context AS relevantContext,
              updated_at AS updatedAt
         FROM agent_task_states
        WHERE task_run_id = ?`
    )
    .get(taskRunId) as Record<string, unknown> | undefined

  return row ? mapTaskState(row) : null
}

export function updateTaskState(
  taskRunId: string,
  update: AgentTaskStateUpdate,
  db?: DatabaseService | null
): AgentTaskState | null {
  const existing = getTaskState(taskRunId, db)
  if (!existing) return null

  const updated: AgentTaskState = {
    ...existing,
    objective: update.objective ?? existing.objective,
    steps: update.steps ?? existing.steps,
    currentBlocker: update.currentBlocker !== undefined ? update.currentBlocker : existing.currentBlocker,
    decisions: update.decisions ?? existing.decisions,
    relevantContext: update.relevantContext ?? existing.relevantContext,
    updatedAt: new Date().toISOString()
  }

  resolveDb(db)
    .prepare(
      `UPDATE agent_task_states
          SET objective = ?,
              steps = ?,
              current_blocker = ?,
              decisions = ?,
              relevant_context = ?,
              updated_at = ?
        WHERE task_run_id = ?`
    )
    .run(
      updated.objective,
      JSON.stringify(updated.steps),
      updated.currentBlocker,
      JSON.stringify(updated.decisions),
      JSON.stringify(updated.relevantContext),
      updated.updatedAt,
      taskRunId
    )

  return updated
}

export function deleteTaskState(taskRunId: string, db?: DatabaseService | null): void {
  resolveDb(db)
    .prepare(`DELETE FROM agent_task_states WHERE task_run_id = ?`)
    .run(taskRunId)
}

export function addStep(
  taskRunId: string,
  step: TaskStateStep,
  db?: DatabaseService | null
): AgentTaskState | null {
  const existing = getTaskState(taskRunId, db)
  if (!existing) return null

  const steps = [...existing.steps, step].slice(-MAX_STEPS)
  return updateTaskState(taskRunId, { steps }, db)
}

export function updateStep(
  taskRunId: string,
  stepId: string,
  update: Partial<TaskStateStep>,
  db?: DatabaseService | null
): AgentTaskState | null {
  const existing = getTaskState(taskRunId, db)
  if (!existing) return null

  const steps = existing.steps.map(s =>
    s.id === stepId ? { ...s, ...update } : s
  )
  return updateTaskState(taskRunId, { steps }, db)
}

export function addDecision(
  taskRunId: string,
  decision: TaskStateDecision,
  db?: DatabaseService | null
): AgentTaskState | null {
  const existing = getTaskState(taskRunId, db)
  if (!existing) return null

  const decisions = [...existing.decisions, decision].slice(-MAX_DECISIONS)
  return updateTaskState(taskRunId, { decisions }, db)
}

export function addContext(
  taskRunId: string,
  context: TaskStateContext,
  db?: DatabaseService | null
): AgentTaskState | null {
  const existing = getTaskState(taskRunId, db)
  if (!existing) return null

  const relevantContext = [...existing.relevantContext, context].slice(-MAX_CONTEXT_ITEMS)
  return updateTaskState(taskRunId, { relevantContext }, db)
}

export function setBlocker(
  taskRunId: string,
  blocker: string | null,
  db?: DatabaseService | null
): AgentTaskState | null {
  return updateTaskState(taskRunId, { currentBlocker: blocker }, db)
}
