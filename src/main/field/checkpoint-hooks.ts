/**
 * Session Checkpoint hook helpers — Phase 24C.
 *
 * Bridges the IPC layer (which has worktreePath + runtimeSessionId) to the
 * generator (which needs worktreeId + hive sessionId). All entry points are
 * fire-and-forget — a checkpoint failure must NEVER block the user-visible
 * action that triggered it (abort, app shutdown).
 */
import { getDatabase } from '../db'
import { isFieldCollectionEnabled } from './privacy'
import { createLogger } from '../services/logger'
import { generateCheckpoint } from './checkpoint-generator'
import { insertCheckpoint } from './checkpoint-repository'

const log = createLogger({ component: 'CheckpointHooks' })

/**
 * Resolve a runtime/agent session id (or hive session id) to the canonical
 * `sessions.id` (hive PK). Returns null if no match.
 */
function resolveHiveSessionId(idLike: string): string | null {
  const db = getDatabase()
  // Direct hit on hive PK
  if (db.getSession(idLike)) return idLike
  // Otherwise try as opencode_session_id
  const sess = db.getSessionByOpenCodeSessionId(idLike)
  return sess?.id ?? null
}

/**
 * Generate + persist a checkpoint for a session abort. Fire-and-forget.
 *
 * Safe to call from anywhere — privacy-gated, swallows all errors,
 * resolves quickly even when there's nothing to checkpoint.
 */
export async function recordCheckpointOnAbort(
  worktreePath: string,
  runtimeSessionId: string
): Promise<void> {
  if (!isFieldCollectionEnabled()) return
  try {
    const db = getDatabase()
    const worktree = db.getWorktreeByPath(worktreePath)
    if (!worktree) {
      log.debug('recordCheckpointOnAbort: no worktree for path', { worktreePath })
      return
    }
    const hiveSessionId = resolveHiveSessionId(runtimeSessionId)
    if (!hiveSessionId) {
      log.debug('recordCheckpointOnAbort: no hive session for runtime id', {
        runtimeSessionId
      })
      return
    }
    const record = await generateCheckpoint({
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      sessionId: hiveSessionId,
      source: 'abort'
    })
    if (!record) {
      log.debug('recordCheckpointOnAbort: nothing to checkpoint', {
        worktreeId: worktree.id
      })
      return
    }
    const inserted = insertCheckpoint(record)
    log.info('recordCheckpointOnAbort: persisted', {
      worktreeId: worktree.id,
      sessionId: hiveSessionId,
      inserted,
      hotFiles: record.hotFiles.length,
      hasGitContext: record.repoHead !== null
    })
  } catch (err) {
    log.warn('recordCheckpointOnAbort: failed', {
      err: err instanceof Error ? err.message : String(err),
      worktreePath,
      runtimeSessionId
    })
  }
}

/**
 * Generate + persist a checkpoint for app shutdown. Fire-and-forget but
 * caller may await for graceful shutdown ordering.
 *
 * Iterates all active sessions across all worktrees. Bounded by 2-second
 * total budget (controlled by caller via Promise.race).
 */
export async function recordCheckpointsOnShutdown(): Promise<void> {
  if (!isFieldCollectionEnabled()) return
  try {
    const db = getDatabase()
    // Sessions table is small — we can scan once and group by worktree.
    const allSessions = db
      .getDbHandle()
      .prepare(
        `SELECT id, worktree_id FROM sessions WHERE status = 'active' AND worktree_id IS NOT NULL`
      )
      .all() as Array<{ id: string; worktree_id: string }>

    if (allSessions.length === 0) return

    // Generate sequentially to keep DB pressure low; total time bounded by
    // caller. Each generate is independent — one slow git probe doesn't block
    // the next worktree's checkpoint indefinitely (subprocess timeout 5s).
    for (const s of allSessions) {
      try {
        const worktree = db.getWorktree(s.worktree_id)
        if (!worktree) continue
        const record = await generateCheckpoint({
          worktreeId: worktree.id,
          worktreePath: worktree.path,
          sessionId: s.id,
          source: 'shutdown'
        })
        if (record) insertCheckpoint(record)
      } catch (err) {
        log.warn('recordCheckpointsOnShutdown: per-session failure', {
          sessionId: s.id,
          err: err instanceof Error ? err.message : String(err)
        })
      }
    }
  } catch (err) {
    log.warn('recordCheckpointsOnShutdown: failed', {
      err: err instanceof Error ? err.message : String(err)
    })
  }
}
