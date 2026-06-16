import { randomUUID } from 'node:crypto'
import { getDatabase } from './database'
import type { DatabaseService } from './database'
import type {
  AgentProviderRequestReplay,
  AgentProviderRequestSummary
} from '@shared/types/agent-task-run'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AgentTurnStatus = 'running' | 'completed' | 'failed' | 'aborted'

export interface AgentTurnCreate {
  sessionId: string
  worktreeId?: string | null
  projectId: string
  runtimeId: string
  taskRunId?: string | null
  userRoundId?: string | null
  epochId?: string | null
  userMessageId?: string | null
  modelProviderId?: string | null
  modelId?: string | null
  modelVariant?: string | null
}

export interface AgentTurnRecord extends AgentTurnCreate {
  id: string
  status: AgentTurnStatus
  assistantMessageId: string | null
  startedAt: string
  completedAt: string | null
  errorMessage: string | null
}

export interface AgentTurnContextSnapshotCreate {
  turnId: string
  sessionId: string
  xfpPacketId?: string | null
  taskRunId?: string | null
  userRoundId?: string | null
  contextSegmentId?: string | null
  contextSegmentOrdinal?: number | null
  providerCallSeq?: number | null
  providerRequestHash: string
  prefixHash?: string | null
  managedContextJson: string
  providerMessagesJson: string
  providerToolsJson: string
  providerConfigJson: string
  decisionsJson: string
  managedApproxTokens?: number
  providerEstimatedInputTokens?: number
  maxContextTokens?: number
}

export interface AgentTurnContextSnapshotRecord extends AgentTurnContextSnapshotCreate {
  id: string
  createdAt: string
}

export interface AgentTurnUsageEventCreate {
  turnId: string
  sessionId: string
  sourceEventId: string
  providerId?: string | null
  modelId?: string | null
  inputTokens?: number
  outputTokens?: number
  cacheWriteTokens?: number
  cacheReadTokens?: number
  totalTokens?: number
  cost?: number
  rawUsageJson: string
  epochId?: string | null
  providerCallSeq?: number | null
  reasoningEffort?: string | null
  actualPrefixHash?: string | null
  occurredAt: string
}

export interface AgentTurnUsageEventRecord extends AgentTurnUsageEventCreate {
  id: string
  createdAt: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper — resolve DB from optional injected service or global singleton
// ─────────────────────────────────────────────────────────────────────────────

function resolveDb(
  db?: DatabaseService | { getDb?: unknown } | null
): ReturnType<DatabaseService['getDb']> {
  // Prefer injected DB; fall back to global singleton.
  // db may be a mock without getDb() in tests — in that case use global.
  if (db && typeof db.getDb === 'function') {
    return db.getDb() as ReturnType<DatabaseService['getDb']>
  }
  return getDatabase().getDb()
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Turns
// ─────────────────────────────────────────────────────────────────────────────

export function createAgentTurn(
  data: AgentTurnCreate,
  db?: DatabaseService | null
): AgentTurnRecord {
  const record: AgentTurnRecord = {
    ...data,
    id: randomUUID(),
    status: 'running',
    assistantMessageId: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    errorMessage: null
  }

  resolveDb(db)
    .prepare(
      `INSERT INTO agent_turns (
        id, session_id, worktree_id, project_id, runtime_id,
        task_run_id, user_round_id, epoch_id,
        user_message_id, assistant_message_id, status,
        model_provider_id, model_id, model_variant,
        started_at, completed_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.sessionId,
      record.worktreeId ?? null,
      record.projectId,
      record.runtimeId,
      record.taskRunId ?? null,
      record.userRoundId ?? null,
      record.epochId ?? null,
      record.userMessageId ?? null,
      record.assistantMessageId,
      record.status,
      record.modelProviderId ?? null,
      record.modelId ?? null,
      record.modelVariant ?? null,
      record.startedAt,
      record.completedAt,
      record.errorMessage
    )

  return record
}

export function updateAgentTurnStatus(
  turnId: string,
  status: AgentTurnStatus,
  options?: {
    assistantMessageId?: string | null
    errorMessage?: string | null
  },
  db?: DatabaseService | null
): void {
  const completedAt = status !== 'running' ? new Date().toISOString() : null

  resolveDb(db)
    .prepare(
      `UPDATE agent_turns
       SET status = ?,
           completed_at = ?,
           assistant_message_id = COALESCE(?, assistant_message_id),
           error_message = ?
       WHERE id = ?`
    )
    .run(
      status,
      completedAt,
      options?.assistantMessageId ?? null,
      options?.errorMessage ?? null,
      turnId
    )
}

export function getAgentTurn(turnId: string, db?: DatabaseService | null): AgentTurnRecord | null {
  const row = resolveDb(db)
    .prepare(
      `SELECT id, session_id AS sessionId, worktree_id AS worktreeId,
              project_id AS projectId, runtime_id AS runtimeId,
              task_run_id AS taskRunId, user_round_id AS userRoundId, epoch_id AS epochId,
              user_message_id AS userMessageId,
              assistant_message_id AS assistantMessageId,
              status,
              model_provider_id AS modelProviderId,
              model_id AS modelId,
              model_variant AS modelVariant,
              started_at AS startedAt,
              completed_at AS completedAt,
              error_message AS errorMessage
       FROM agent_turns WHERE id = ?`
    )
    .get(turnId) as AgentTurnRecord | undefined

  return row ?? null
}

export function listAgentTurns(
  sessionId: string,
  options?: { limit?: number },
  db?: DatabaseService | null
): AgentTurnRecord[] {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200)

  return resolveDb(db)
    .prepare(
      `SELECT id, session_id AS sessionId, worktree_id AS worktreeId,
              project_id AS projectId, runtime_id AS runtimeId,
              task_run_id AS taskRunId, user_round_id AS userRoundId, epoch_id AS epochId,
              user_message_id AS userMessageId,
              assistant_message_id AS assistantMessageId,
              status,
              model_provider_id AS modelProviderId,
              model_id AS modelId,
              model_variant AS modelVariant,
              started_at AS startedAt,
              completed_at AS completedAt,
              error_message AS errorMessage
       FROM agent_turns
       WHERE session_id = ?
       ORDER BY started_at ASC
       LIMIT ?`
    )
    .all(sessionId, limit) as AgentTurnRecord[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Snapshots
// ─────────────────────────────────────────────────────────────────────────────

export function createAgentTurnContextSnapshot(
  data: AgentTurnContextSnapshotCreate,
  db?: DatabaseService | null
): AgentTurnContextSnapshotRecord {
  const record: AgentTurnContextSnapshotRecord = {
    ...data,
    id: randomUUID(),
    createdAt: new Date().toISOString()
  }

  resolveDb(db)
    .prepare(
      `INSERT INTO agent_turn_context_snapshots (
        id, turn_id, session_id, xfp_packet_id,
        task_run_id, user_round_id, context_segment_id,
        context_segment_ordinal, provider_call_seq,
        provider_request_hash, prefix_hash,
        managed_context_json, provider_messages_json,
        provider_tools_json, provider_config_json,
        decisions_json,
        managed_approx_tokens, provider_estimated_input_tokens,
        max_context_tokens,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.turnId,
      record.sessionId,
      record.xfpPacketId ?? null,
      record.taskRunId ?? null,
      record.userRoundId ?? null,
      record.contextSegmentId ?? null,
      record.contextSegmentOrdinal ?? null,
      record.providerCallSeq ?? 0,
      record.providerRequestHash,
      record.prefixHash ?? null,
      record.managedContextJson,
      record.providerMessagesJson,
      record.providerToolsJson,
      record.providerConfigJson,
      record.decisionsJson,
      record.managedApproxTokens ?? 0,
      record.providerEstimatedInputTokens ?? 0,
      record.maxContextTokens ?? 0,
      record.createdAt
    )

  return record
}

export function getAgentTurnContextSnapshot(
  turnId: string,
  db?: DatabaseService | null
): AgentTurnContextSnapshotRecord | null {
  const row = resolveDb(db)
    .prepare(
      `SELECT id, turn_id AS turnId, session_id AS sessionId,
              xfp_packet_id AS xfpPacketId,
              task_run_id AS taskRunId,
              user_round_id AS userRoundId,
              context_segment_id AS contextSegmentId,
              context_segment_ordinal AS contextSegmentOrdinal,
              provider_call_seq AS providerCallSeq,
              provider_request_hash AS providerRequestHash,
              prefix_hash AS prefixHash,
              managed_context_json AS managedContextJson,
              provider_messages_json AS providerMessagesJson,
              provider_tools_json AS providerToolsJson,
              provider_config_json AS providerConfigJson,
              decisions_json AS decisionsJson,
              managed_approx_tokens AS managedApproxTokens,
              provider_estimated_input_tokens AS providerEstimatedInputTokens,
              max_context_tokens AS maxContextTokens,
              created_at AS createdAt
       FROM agent_turn_context_snapshots
       WHERE turn_id = ?`
    )
    .get(turnId) as AgentTurnContextSnapshotRecord | undefined

  return row ?? null
}

export function listProviderRequestSummariesForTaskRun(
  taskRunId: string,
  options: { limit?: number } = {},
  db?: DatabaseService | null
): AgentProviderRequestSummary[] {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200))
  const rows = resolveDb(db)
    .prepare(
      `SELECT snapshots.id,
              snapshots.turn_id AS turnId,
              snapshots.session_id AS sessionId,
              COALESCE(snapshots.task_run_id, turns.task_run_id) AS taskRunId,
              COALESCE(snapshots.user_round_id, turns.user_round_id) AS userRoundId,
              COALESCE(snapshots.context_segment_id, turns.epoch_id) AS contextSegmentId,
              snapshots.context_segment_ordinal AS contextSegmentOrdinal,
              COALESCE(snapshots.provider_call_seq, 0) AS providerCallSeq,
              snapshots.provider_request_hash AS providerRequestHash,
              snapshots.prefix_hash AS prefixHash,
              snapshots.managed_approx_tokens AS managedApproxTokens,
              snapshots.provider_estimated_input_tokens AS providerEstimatedInputTokens,
              snapshots.max_context_tokens AS maxContextTokens,
              snapshots.created_at AS createdAt
         FROM agent_turn_context_snapshots snapshots
         LEFT JOIN agent_turns turns ON turns.id = snapshots.turn_id
        WHERE COALESCE(snapshots.task_run_id, turns.task_run_id) = ?
        ORDER BY snapshots.created_at ASC
        LIMIT ?`
    )
    .all(taskRunId, limit) as Record<string, unknown>[]

  return rows.map((row) => ({
    id: row.id as string,
    turnId: row.turnId as string,
    sessionId: row.sessionId as string,
    taskRunId: (row.taskRunId as string | null) ?? null,
    userRoundId: (row.userRoundId as string | null) ?? null,
    contextSegmentId: (row.contextSegmentId as string | null) ?? null,
    contextSegmentOrdinal: (row.contextSegmentOrdinal as number | null) ?? null,
    providerCallSeq: (row.providerCallSeq as number | null) ?? 0,
    providerRequestHash: row.providerRequestHash as string,
    prefixHash: (row.prefixHash as string | null) ?? null,
    managedApproxTokens: (row.managedApproxTokens as number) ?? 0,
    providerEstimatedInputTokens: (row.providerEstimatedInputTokens as number) ?? 0,
    maxContextTokens: (row.maxContextTokens as number) ?? 0,
    createdAt: row.createdAt as string
  }))
}

export function getProviderRequestReplay(
  snapshotId: string,
  db?: DatabaseService | null
): AgentProviderRequestReplay | null {
  const row = resolveDb(db)
    .prepare(
      `SELECT snapshots.id,
              snapshots.turn_id AS turnId,
              snapshots.session_id AS sessionId,
              snapshots.xfp_packet_id AS xfpPacketId,
              COALESCE(snapshots.task_run_id, turns.task_run_id) AS taskRunId,
              COALESCE(snapshots.user_round_id, turns.user_round_id) AS userRoundId,
              COALESCE(snapshots.context_segment_id, turns.epoch_id) AS contextSegmentId,
              snapshots.context_segment_ordinal AS contextSegmentOrdinal,
              COALESCE(snapshots.provider_call_seq, 0) AS providerCallSeq,
              snapshots.provider_request_hash AS providerRequestHash,
              snapshots.prefix_hash AS prefixHash,
              snapshots.managed_context_json AS managedContextJson,
              snapshots.provider_messages_json AS providerMessagesJson,
              snapshots.provider_tools_json AS providerToolsJson,
              snapshots.provider_config_json AS providerConfigJson,
              snapshots.decisions_json AS decisionsJson,
              snapshots.managed_approx_tokens AS managedApproxTokens,
              snapshots.provider_estimated_input_tokens AS providerEstimatedInputTokens,
              snapshots.max_context_tokens AS maxContextTokens,
              snapshots.created_at AS createdAt
         FROM agent_turn_context_snapshots snapshots
         LEFT JOIN agent_turns turns ON turns.id = snapshots.turn_id
        WHERE snapshots.id = ?`
    )
    .get(snapshotId) as Record<string, unknown> | undefined

  if (!row) return null

  return {
    id: row.id as string,
    turnId: row.turnId as string,
    sessionId: row.sessionId as string,
    xfpPacketId: (row.xfpPacketId as string | null) ?? null,
    taskRunId: (row.taskRunId as string | null) ?? null,
    userRoundId: (row.userRoundId as string | null) ?? null,
    contextSegmentId: (row.contextSegmentId as string | null) ?? null,
    contextSegmentOrdinal: (row.contextSegmentOrdinal as number | null) ?? null,
    providerCallSeq: (row.providerCallSeq as number | null) ?? 0,
    providerRequestHash: row.providerRequestHash as string,
    prefixHash: (row.prefixHash as string | null) ?? null,
    managedContextJson: row.managedContextJson as string,
    providerMessagesJson: row.providerMessagesJson as string,
    providerToolsJson: row.providerToolsJson as string,
    providerConfigJson: row.providerConfigJson as string,
    decisionsJson: row.decisionsJson as string,
    managedApproxTokens: (row.managedApproxTokens as number) ?? 0,
    providerEstimatedInputTokens: (row.providerEstimatedInputTokens as number) ?? 0,
    maxContextTokens: (row.maxContextTokens as number) ?? 0,
    createdAt: row.createdAt as string
  }
}

/**
 * Update the decisions_json on an existing context snapshot.
 * Used for post-hoc annotations such as emergency shrink metadata
 * that can only be recorded after the provider call completes.
 */
export function updateAgentTurnContextSnapshot(
  turnId: string,
  decisionsJson: string,
  db?: DatabaseService | null
): void {
  resolveDb(db)
    .prepare(
      `UPDATE agent_turn_context_snapshots
       SET decisions_json = ?
       WHERE turn_id = ?`
    )
    .run(decisionsJson, turnId)
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage Events
// ─────────────────────────────────────────────────────────────────────────────

export function createAgentTurnUsageEvent(
  data: AgentTurnUsageEventCreate,
  db?: DatabaseService | null
): AgentTurnUsageEventRecord {
  const record: AgentTurnUsageEventRecord = {
    ...data,
    id: randomUUID(),
    createdAt: new Date().toISOString()
  }

  resolveDb(db)
    .prepare(
      `INSERT OR IGNORE INTO agent_turn_usage_events (
        id, turn_id, session_id, source_event_id,
        provider_id, model_id,
        input_tokens, output_tokens,
        cache_write_tokens, cache_read_tokens,
        total_tokens, cost,
        raw_usage_json,
        epoch_id, provider_call_seq, reasoning_effort, actual_prefix_hash,
        occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.turnId,
      record.sessionId,
      record.sourceEventId,
      record.providerId ?? null,
      record.modelId ?? null,
      record.inputTokens ?? 0,
      record.outputTokens ?? 0,
      record.cacheWriteTokens ?? 0,
      record.cacheReadTokens ?? 0,
      record.totalTokens ?? 0,
      record.cost ?? 0,
      record.rawUsageJson,
      record.epochId ?? null,
      record.providerCallSeq ?? null,
      record.reasoningEffort ?? null,
      record.actualPrefixHash ?? null,
      record.occurredAt,
      record.createdAt
    )

  return record
}

export function listAgentTurnUsageEvents(
  turnId: string,
  db?: DatabaseService | null
): AgentTurnUsageEventRecord[] {
  return resolveDb(db)
    .prepare(
      `SELECT id, turn_id AS turnId, session_id AS sessionId,
              source_event_id AS sourceEventId,
              provider_id AS providerId, model_id AS modelId,
              input_tokens AS inputTokens, output_tokens AS outputTokens,
              cache_write_tokens AS cacheWriteTokens,
              cache_read_tokens AS cacheReadTokens,
              total_tokens AS totalTokens, cost,
              raw_usage_json AS rawUsageJson,
              epoch_id AS epochId,
              provider_call_seq AS providerCallSeq,
              reasoning_effort AS reasoningEffort,
              actual_prefix_hash AS actualPrefixHash,
              occurred_at AS occurredAt, created_at AS createdAt
       FROM agent_turn_usage_events
       WHERE turn_id = ?
       ORDER BY occurred_at ASC`
    )
    .all(turnId) as AgentTurnUsageEventRecord[]
}

export function sumAgentTurnUsageTokens(
  sessionId: string,
  db?: DatabaseService | null
): {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheWriteTokens: number
  totalCacheReadTokens: number
  totalTokens: number
} {
  const row = resolveDb(db)
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS totalInputTokens,
              COALESCE(SUM(output_tokens), 0) AS totalOutputTokens,
              COALESCE(SUM(cache_write_tokens), 0) AS totalCacheWriteTokens,
              COALESCE(SUM(cache_read_tokens), 0) AS totalCacheReadTokens,
              COALESCE(SUM(total_tokens), 0) AS totalTokens
       FROM agent_turn_usage_events
       WHERE session_id = ?`
    )
    .get(sessionId) as
    | {
        totalInputTokens: number
        totalOutputTokens: number
        totalCacheWriteTokens: number
        totalCacheReadTokens: number
        totalTokens: number
      }
    | undefined

  return (
    row ?? {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheWriteTokens: 0,
      totalCacheReadTokens: 0,
      totalTokens: 0
    }
  )
}
