/**
 * Session Checkpoint repository — Phase 24C.
 *
 * CRUD over `field_session_checkpoints`. Generator writes; verifier reads.
 * Idempotency is enforced by the UNIQUE (worktree_id, packet_hash) index +
 * INSERT OR IGNORE — repeated triggers within the same minute won't duplicate
 * (because packet_hash includes session_id + created_at_minute).
 *
 * See docs/prd/phase-24c-session-checkpoint.md
 */
import { getDatabase } from '../db'

export interface CheckpointRecord {
  id: string
  createdAt: number
  worktreeId: string
  sessionId: string
  branch: string | null
  repoHead: string | null
  source: 'abort' | 'shutdown'
  summary: string
  currentGoal: string | null
  nextAction: string | null
  blockingReason: string | null
  hotFiles: string[]
  /** path -> sha1 hex; null entries mean digest could not be computed */
  hotFileDigests: Record<string, string | null> | null
  packetHash: string
}

interface Row {
  id: string
  created_at: number
  worktree_id: string
  session_id: string
  branch: string | null
  repo_head: string | null
  source: 'abort' | 'shutdown'
  summary: string
  current_goal: string | null
  next_action: string | null
  blocking_reason: string | null
  hot_files_json: string
  hot_file_digests_json: string | null
  packet_hash: string
}

function rowToRecord(row: Row): CheckpointRecord {
  let hotFiles: string[] = []
  try {
    const parsed = JSON.parse(row.hot_files_json)
    if (Array.isArray(parsed)) hotFiles = parsed.filter((p): p is string => typeof p === 'string')
  } catch {
    // Bad JSON — treat as empty; verifier will see no hot files and skip digest check
  }

  let hotFileDigests: Record<string, string | null> | null = null
  if (row.hot_file_digests_json) {
    try {
      const parsed = JSON.parse(row.hot_file_digests_json)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        hotFileDigests = parsed as Record<string, string | null>
      }
    } catch {
      hotFileDigests = null
    }
  }

  return {
    id: row.id,
    createdAt: row.created_at,
    worktreeId: row.worktree_id,
    sessionId: row.session_id,
    branch: row.branch,
    repoHead: row.repo_head,
    source: row.source,
    summary: row.summary,
    currentGoal: row.current_goal,
    nextAction: row.next_action,
    blockingReason: row.blocking_reason,
    hotFiles,
    hotFileDigests,
    packetHash: row.packet_hash
  }
}

/**
 * Insert a new checkpoint. Returns true if inserted, false if a row with the
 * same (worktree_id, packet_hash) already exists (idempotent no-op).
 */
export function insertCheckpoint(record: CheckpointRecord): boolean {
  const sql = `
    INSERT OR IGNORE INTO field_session_checkpoints (
      id, created_at, worktree_id, session_id,
      branch, repo_head, source,
      summary, current_goal, next_action, blocking_reason,
      hot_files_json, hot_file_digests_json,
      packet_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  const result = getDatabase()
    .getDbHandle()
    .prepare(sql)
    .run(
      record.id,
      record.createdAt,
      record.worktreeId,
      record.sessionId,
      record.branch,
      record.repoHead,
      record.source,
      record.summary,
      record.currentGoal,
      record.nextAction,
      record.blockingReason,
      JSON.stringify(record.hotFiles),
      record.hotFileDigests ? JSON.stringify(record.hotFileDigests) : null,
      record.packetHash
    )
  return result.changes > 0
}

/**
 * Latest checkpoint for a worktree, or null if none. Verifier's read-only
 * entry point.
 */
export function getLatestCheckpoint(worktreeId: string): CheckpointRecord | null {
  const sql = `
    SELECT id, created_at, worktree_id, session_id,
           branch, repo_head, source,
           summary, current_goal, next_action, blocking_reason,
           hot_files_json, hot_file_digests_json,
           packet_hash
      FROM field_session_checkpoints
     WHERE worktree_id = ?
     ORDER BY created_at DESC
     LIMIT 1
  `
  const row = getDatabase().getDbHandle().prepare(sql).get(worktreeId) as Row | undefined
  return row ? rowToRecord(row) : null
}

/** Test helper — clear all checkpoints for a worktree. Not exposed to runtime code. */
export function deleteCheckpointsForWorktree(worktreeId: string): number {
  const result = getDatabase()
    .getDbHandle()
    .prepare(`DELETE FROM field_session_checkpoints WHERE worktree_id = ?`)
    .run(worktreeId)
  return result.changes
}
