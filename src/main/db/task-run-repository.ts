import { randomUUID } from 'node:crypto'
import { getDatabase } from './database'
import type { DatabaseService } from './database'
import type {
  AgentContextSegment,
  AgentEpoch,
  AgentTaskRun,
  AgentUserRound,
  EpochCloseReason,
  EpochStatus,
  TaskRunAutonomy,
  TaskRunStatus,
  UserRoundOrigin,
  UserRoundStatus
} from '@shared/types/agent-task-run'

export interface AgentTaskRunCreate {
  sessionId: string
  worktreeId?: string | null
  projectId: string
  originMessageId?: string | null
  autonomy?: TaskRunAutonomy
  objective?: string | null
  leaseExpiresAt?: string | null
}

export interface AgentEpochCreate {
  taskRunId: string
  sessionId: string
  userRoundId?: string | null
  startFillRatio?: number | null
}

export interface AgentUserRoundCreate {
  taskRunId: string
  sessionId: string
  origin: UserRoundOrigin
  userMessageId?: string | null
  promptText?: string | null
}

export interface AgentTaskRunUsageDelta {
  inputTokens?: number
  outputTokens?: number
  cost?: number
}

function resolveDb(db?: DatabaseService | null): ReturnType<DatabaseService['getDb']> {
  return db?.getDb() ?? getDatabase().getDb()
}

function mapTaskRun(row: Record<string, unknown>): AgentTaskRun {
  return {
    id: row.id as string,
    sessionId: row.sessionId as string,
    worktreeId: (row.worktreeId as string | null) ?? null,
    projectId: row.projectId as string,
    originMessageId: (row.originMessageId as string | null) ?? null,
    status: row.status as TaskRunStatus,
    autonomy: row.autonomy as TaskRunAutonomy,
    objective: (row.objective as string | null) ?? null,
    leaseExpiresAt: (row.leaseExpiresAt as string | null) ?? null,
    totalInputTokens: (row.totalInputTokens as number) ?? 0,
    totalOutputTokens: (row.totalOutputTokens as number) ?? 0,
    totalCost: (row.totalCost as number) ?? 0,
    epochCount: (row.epochCount as number) ?? 0,
    startedAt: row.startedAt as string,
    completedAt: (row.completedAt as string | null) ?? null,
    errorMessage: (row.errorMessage as string | null) ?? null
  }
}

function mapEpoch(row: Record<string, unknown>): AgentEpoch {
  return {
    id: row.id as string,
    taskRunId: row.taskRunId as string,
    sessionId: row.sessionId as string,
    userRoundId: (row.userRoundId as string | null) ?? null,
    ordinal: row.ordinal as number,
    status: row.status as EpochStatus,
    checkpointId: (row.checkpointId as string | null) ?? null,
    providerCallCount: (row.providerCallCount as number) ?? 0,
    startFillRatio: (row.startFillRatio as number | null) ?? null,
    endFillRatio: (row.endFillRatio as number | null) ?? null,
    closeReason: (row.closeReason as EpochCloseReason | null) ?? null,
    startedAt: row.startedAt as string,
    closedAt: (row.closedAt as string | null) ?? null
  }
}

function mapUserRound(row: Record<string, unknown>): AgentUserRound {
  return {
    id: row.id as string,
    taskRunId: row.taskRunId as string,
    sessionId: row.sessionId as string,
    ordinal: row.ordinal as number,
    origin: row.origin as UserRoundOrigin,
    status: row.status as UserRoundStatus,
    userMessageId: (row.userMessageId as string | null) ?? null,
    promptText: (row.promptText as string | null) ?? null,
    providerRequestCount: (row.providerRequestCount as number) ?? 0,
    contextSegmentCount: (row.contextSegmentCount as number) ?? 0,
    startedAt: row.startedAt as string,
    completedAt: (row.completedAt as string | null) ?? null,
    errorMessage: (row.errorMessage as string | null) ?? null
  }
}

export function createTaskRun(data: AgentTaskRunCreate, db?: DatabaseService | null): AgentTaskRun {
  const record: AgentTaskRun = {
    id: randomUUID(),
    sessionId: data.sessionId,
    worktreeId: data.worktreeId ?? null,
    projectId: data.projectId,
    originMessageId: data.originMessageId ?? null,
    status: 'running',
    autonomy: data.autonomy ?? 'short',
    objective: data.objective ?? null,
    leaseExpiresAt: data.leaseExpiresAt ?? null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    epochCount: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    errorMessage: null
  }

  resolveDb(db)
    .prepare(
      `INSERT INTO agent_task_runs (
        id, session_id, worktree_id, project_id, origin_message_id,
        status, autonomy, objective, lease_expires_at,
        total_input_tokens, total_output_tokens, total_cost, epoch_count,
        started_at, completed_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.sessionId,
      record.worktreeId,
      record.projectId,
      record.originMessageId,
      record.status,
      record.autonomy,
      record.objective,
      record.leaseExpiresAt,
      record.totalInputTokens,
      record.totalOutputTokens,
      record.totalCost,
      record.epochCount,
      record.startedAt,
      record.completedAt,
      record.errorMessage
    )

  return record
}

export function getTaskRun(taskRunId: string, db?: DatabaseService | null): AgentTaskRun | null {
  const row = resolveDb(db)
    .prepare(
      `SELECT id,
              session_id AS sessionId,
              worktree_id AS worktreeId,
              project_id AS projectId,
              origin_message_id AS originMessageId,
              status,
              autonomy,
              objective,
              lease_expires_at AS leaseExpiresAt,
              total_input_tokens AS totalInputTokens,
              total_output_tokens AS totalOutputTokens,
              total_cost AS totalCost,
              epoch_count AS epochCount,
              started_at AS startedAt,
              completed_at AS completedAt,
              error_message AS errorMessage
         FROM agent_task_runs
        WHERE id = ?`
    )
    .get(taskRunId) as Record<string, unknown> | undefined

  return row ? mapTaskRun(row) : null
}

export function getActiveTaskRun(
  sessionId: string,
  db?: DatabaseService | null
): AgentTaskRun | null {
  const row = resolveDb(db)
    .prepare(
      `SELECT id,
              session_id AS sessionId,
              worktree_id AS worktreeId,
              project_id AS projectId,
              origin_message_id AS originMessageId,
              status,
              autonomy,
              objective,
              lease_expires_at AS leaseExpiresAt,
              total_input_tokens AS totalInputTokens,
              total_output_tokens AS totalOutputTokens,
              total_cost AS totalCost,
              epoch_count AS epochCount,
              started_at AS startedAt,
              completed_at AS completedAt,
              error_message AS errorMessage
         FROM agent_task_runs
        WHERE session_id = ?
          AND status IN ('running', 'paused')
        ORDER BY started_at DESC
        LIMIT 1`
    )
    .get(sessionId) as Record<string, unknown> | undefined

  return row ? mapTaskRun(row) : null
}

export function listTaskRunsForSession(
  sessionId: string,
  options: { limit?: number } = {},
  db?: DatabaseService | null
): AgentTaskRun[] {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100))
  const rows = resolveDb(db)
    .prepare(
      `SELECT id,
              session_id AS sessionId,
              worktree_id AS worktreeId,
              project_id AS projectId,
              origin_message_id AS originMessageId,
              status,
              autonomy,
              objective,
              lease_expires_at AS leaseExpiresAt,
              total_input_tokens AS totalInputTokens,
              total_output_tokens AS totalOutputTokens,
              total_cost AS totalCost,
              epoch_count AS epochCount,
              started_at AS startedAt,
              completed_at AS completedAt,
              error_message AS errorMessage
         FROM agent_task_runs
        WHERE session_id = ?
        ORDER BY started_at DESC
        LIMIT ?`
    )
    .all(sessionId, limit) as Record<string, unknown>[]

  return rows.map(mapTaskRun)
}

export function createUserRound(
  data: AgentUserRoundCreate,
  db?: DatabaseService | null
): AgentUserRound {
  const database = resolveDb(db)
  const ordinalRow = database
    .prepare(
      `SELECT COALESCE(MAX(ordinal), -1) + 1 AS nextOrdinal
         FROM agent_user_rounds
        WHERE task_run_id = ?`
    )
    .get(data.taskRunId) as { nextOrdinal: number } | undefined

  const record: AgentUserRound = {
    id: randomUUID(),
    taskRunId: data.taskRunId,
    sessionId: data.sessionId,
    ordinal: ordinalRow?.nextOrdinal ?? 0,
    origin: data.origin,
    status: 'running',
    userMessageId: data.userMessageId ?? null,
    promptText: data.promptText ?? null,
    providerRequestCount: 0,
    contextSegmentCount: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    errorMessage: null
  }

  database
    .prepare(
      `INSERT INTO agent_user_rounds (
        id, task_run_id, session_id, ordinal, origin, status,
        user_message_id, prompt_text,
        provider_request_count, context_segment_count,
        started_at, completed_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.taskRunId,
      record.sessionId,
      record.ordinal,
      record.origin,
      record.status,
      record.userMessageId,
      record.promptText,
      record.providerRequestCount,
      record.contextSegmentCount,
      record.startedAt,
      record.completedAt,
      record.errorMessage
    )

  return record
}

export function getUserRound(
  userRoundId: string,
  db?: DatabaseService | null
): AgentUserRound | null {
  const row = resolveDb(db)
    .prepare(
      `SELECT id,
              task_run_id AS taskRunId,
              session_id AS sessionId,
              ordinal,
              origin,
              status,
              user_message_id AS userMessageId,
              prompt_text AS promptText,
              provider_request_count AS providerRequestCount,
              context_segment_count AS contextSegmentCount,
              started_at AS startedAt,
              completed_at AS completedAt,
              error_message AS errorMessage
         FROM agent_user_rounds
        WHERE id = ?`
    )
    .get(userRoundId) as Record<string, unknown> | undefined

  return row ? mapUserRound(row) : null
}

export function listUserRoundsForTaskRun(
  taskRunId: string,
  db?: DatabaseService | null
): AgentUserRound[] {
  const rows = resolveDb(db)
    .prepare(
      `SELECT id,
              task_run_id AS taskRunId,
              session_id AS sessionId,
              ordinal,
              origin,
              status,
              user_message_id AS userMessageId,
              prompt_text AS promptText,
              provider_request_count AS providerRequestCount,
              context_segment_count AS contextSegmentCount,
              started_at AS startedAt,
              completed_at AS completedAt,
              error_message AS errorMessage
         FROM agent_user_rounds
        WHERE task_run_id = ?
        ORDER BY ordinal ASC`
    )
    .all(taskRunId) as Record<string, unknown>[]

  return rows.map(mapUserRound)
}

export function updateUserRoundStatus(
  userRoundId: string,
  status: UserRoundStatus,
  options?: { errorMessage?: string | null },
  db?: DatabaseService | null
): void {
  const completedAt = status === 'running' ? null : new Date().toISOString()
  resolveDb(db)
    .prepare(
      `UPDATE agent_user_rounds
          SET status = ?,
              completed_at = ?,
              error_message = ?
        WHERE id = ?`
    )
    .run(status, completedAt, options?.errorMessage ?? null, userRoundId)
}

export function incrementUserRoundProviderRequestCount(
  userRoundId: string,
  db?: DatabaseService | null
): void {
  resolveDb(db)
    .prepare(
      `UPDATE agent_user_rounds
          SET provider_request_count = provider_request_count + 1
        WHERE id = ?`
    )
    .run(userRoundId)
}

export function appendEpoch(data: AgentEpochCreate, db?: DatabaseService | null): AgentEpoch {
  const database = resolveDb(db)
  const ordinalRow = database
    .prepare(
      `SELECT COALESCE(MAX(ordinal), -1) + 1 AS nextOrdinal
         FROM agent_epochs
        WHERE task_run_id = ?`
    )
    .get(data.taskRunId) as { nextOrdinal: number } | undefined

  const record: AgentEpoch = {
    id: randomUUID(),
    taskRunId: data.taskRunId,
    sessionId: data.sessionId,
    userRoundId: data.userRoundId ?? null,
    ordinal: ordinalRow?.nextOrdinal ?? 0,
    status: 'running',
    checkpointId: null,
    providerCallCount: 0,
    startFillRatio: data.startFillRatio ?? null,
    endFillRatio: null,
    closeReason: null,
    startedAt: new Date().toISOString(),
    closedAt: null
  }

  database
    .prepare(
      `INSERT INTO agent_epochs (
        id, task_run_id, session_id, user_round_id, ordinal, status, checkpoint_id,
        provider_call_count, start_fill_ratio, end_fill_ratio, close_reason,
        started_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.taskRunId,
      record.sessionId,
      record.userRoundId,
      record.ordinal,
      record.status,
      record.checkpointId,
      record.providerCallCount,
      record.startFillRatio,
      record.endFillRatio,
      record.closeReason,
      record.startedAt,
      record.closedAt
    )

  database
    .prepare(`UPDATE agent_task_runs SET epoch_count = epoch_count + 1 WHERE id = ?`)
    .run(data.taskRunId)
  if (record.userRoundId) {
    database
      .prepare(
        `UPDATE agent_user_rounds
            SET context_segment_count = context_segment_count + 1
          WHERE id = ?`
      )
      .run(record.userRoundId)
  }

  return record
}

export const appendContextSegment = appendEpoch

export function updateEpochStartFillRatio(
  epochId: string,
  fillRatio: number | null,
  db?: DatabaseService | null
): void {
  resolveDb(db)
    .prepare(`UPDATE agent_epochs SET start_fill_ratio = ? WHERE id = ?`)
    .run(fillRatio, epochId)
}

export function incrementEpochProviderCallCount(
  epochId: string,
  db?: DatabaseService | null
): void {
  resolveDb(db)
    .prepare(
      `UPDATE agent_epochs
          SET provider_call_count = provider_call_count + 1
        WHERE id = ?`
    )
    .run(epochId)
}

export const incrementContextSegmentProviderCallCount = incrementEpochProviderCallCount

export function closeEpoch(
  epochId: string,
  options: {
    status?: EpochStatus
    checkpointId?: string | null
    endFillRatio?: number | null
    closeReason?: EpochCloseReason | null
  } = {},
  db?: DatabaseService | null
): void {
  resolveDb(db)
    .prepare(
      `UPDATE agent_epochs
          SET status = ?,
              checkpoint_id = COALESCE(?, checkpoint_id),
              end_fill_ratio = ?,
              close_reason = ?,
              closed_at = ?
        WHERE id = ?`
    )
    .run(
      options.status ?? 'closed',
      options.checkpointId ?? null,
      options.endFillRatio ?? null,
      options.closeReason ?? null,
      new Date().toISOString(),
      epochId
    )
}

export function updateTaskRunStatus(
  taskRunId: string,
  status: TaskRunStatus,
  options?: { errorMessage?: string | null; leaseExpiresAt?: string | null },
  db?: DatabaseService | null
): void {
  const completedAt = status === 'running' || status === 'paused' ? null : new Date().toISOString()
  resolveDb(db)
    .prepare(
      `UPDATE agent_task_runs
          SET status = ?,
              completed_at = ?,
              error_message = ?,
              lease_expires_at = COALESCE(?, lease_expires_at)
        WHERE id = ?`
    )
    .run(
      status,
      completedAt,
      options?.errorMessage ?? null,
      options?.leaseExpiresAt ?? null,
      taskRunId
    )
}

export function renewLease(
  taskRunId: string,
  leaseExpiresAt: string,
  db?: DatabaseService | null
): void {
  resolveDb(db)
    .prepare(`UPDATE agent_task_runs SET lease_expires_at = ? WHERE id = ?`)
    .run(leaseExpiresAt, taskRunId)
}

export function accumulateUsage(
  taskRunId: string,
  delta: AgentTaskRunUsageDelta,
  db?: DatabaseService | null
): void {
  resolveDb(db)
    .prepare(
      `UPDATE agent_task_runs
          SET total_input_tokens = total_input_tokens + ?,
              total_output_tokens = total_output_tokens + ?,
              total_cost = total_cost + ?
        WHERE id = ?`
    )
    .run(delta.inputTokens ?? 0, delta.outputTokens ?? 0, delta.cost ?? 0, taskRunId)
}

export function bindTurnToTaskRun(
  turnId: string,
  taskRunId: string,
  epochId: string,
  userRoundIdOrDb?: string | null | DatabaseService,
  db?: DatabaseService | null
): void {
  const userRoundId =
    typeof userRoundIdOrDb === 'string' || userRoundIdOrDb === null ? userRoundIdOrDb : null
  const database = userRoundIdOrDb && typeof userRoundIdOrDb === 'object' ? userRoundIdOrDb : db
  resolveDb(database)
    .prepare(
      `UPDATE agent_turns
          SET task_run_id = ?,
              user_round_id = ?,
              epoch_id = ?
        WHERE id = ?`
    )
    .run(taskRunId, userRoundId, epochId, turnId)
}

export function getEpoch(epochId: string, db?: DatabaseService | null): AgentEpoch | null {
  const row = resolveDb(db)
    .prepare(
      `SELECT id,
              task_run_id AS taskRunId,
              session_id AS sessionId,
              user_round_id AS userRoundId,
              ordinal,
              status,
              checkpoint_id AS checkpointId,
              provider_call_count AS providerCallCount,
              start_fill_ratio AS startFillRatio,
              end_fill_ratio AS endFillRatio,
              close_reason AS closeReason,
              started_at AS startedAt,
              closed_at AS closedAt
         FROM agent_epochs
        WHERE id = ?`
    )
    .get(epochId) as Record<string, unknown> | undefined

  return row ? mapEpoch(row) : null
}

export function listEpochsForTaskRun(taskRunId: string, db?: DatabaseService | null): AgentEpoch[] {
  const rows = resolveDb(db)
    .prepare(
      `SELECT id,
              task_run_id AS taskRunId,
              session_id AS sessionId,
              user_round_id AS userRoundId,
              ordinal,
              status,
              checkpoint_id AS checkpointId,
              provider_call_count AS providerCallCount,
              start_fill_ratio AS startFillRatio,
              end_fill_ratio AS endFillRatio,
              close_reason AS closeReason,
              started_at AS startedAt,
              closed_at AS closedAt
         FROM agent_epochs
        WHERE task_run_id = ?
        ORDER BY ordinal ASC`
    )
    .all(taskRunId) as Record<string, unknown>[]

  return rows.map(mapEpoch)
}

export const getContextSegment = getEpoch

export function listContextSegmentsForTaskRun(
  taskRunId: string,
  db?: DatabaseService | null
): AgentContextSegment[] {
  return listEpochsForTaskRun(taskRunId, db)
}
