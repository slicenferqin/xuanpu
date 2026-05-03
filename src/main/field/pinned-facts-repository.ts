/**
 * Pinned Facts repository — v1.4.1.
 *
 * One row per worktree (PK = worktree_id) holding user-authored permanent
 * facts as freeform markdown. The application enforces a 2000-char cap;
 * the DB itself is uncapped to keep future cap changes migration-free.
 *
 * See docs/plans/2026-05-03-field-memory-implementation.md
 */
import { getDatabase } from '../db'

export const PINNED_FACTS_MAX_CHARS = 2000

export interface PinnedFactsRecord {
  worktreeId: string
  contentMd: string
  updatedAt: number
  createdAt: number
}

interface Row {
  worktree_id: string
  content_md: string
  updated_at: number
  created_at: number
}

function rowToRecord(row: Row): PinnedFactsRecord {
  return {
    worktreeId: row.worktree_id,
    contentMd: row.content_md,
    updatedAt: row.updated_at,
    createdAt: row.created_at
  }
}

/** Returns the pinned facts row for a worktree, or null if none. */
export function getPinnedFacts(worktreeId: string): PinnedFactsRecord | null {
  const sql = `
    SELECT worktree_id, content_md, updated_at, created_at
      FROM field_pinned_facts
     WHERE worktree_id = ?
     LIMIT 1
  `
  const row = getDatabase().getDbHandle().prepare(sql).get(worktreeId) as Row | undefined
  return row ? rowToRecord(row) : null
}

/**
 * Upsert pinned facts for a worktree. Empty / whitespace-only content is
 * stored as an empty string (not deleted) so we keep the row's createdAt
 * stable across edits.
 *
 * Throws if `contentMd` exceeds {@link PINNED_FACTS_MAX_CHARS}.
 */
export function upsertPinnedFacts(worktreeId: string, contentMd: string): PinnedFactsRecord {
  if (contentMd.length > PINNED_FACTS_MAX_CHARS) {
    throw new Error(
      `Pinned Facts content exceeds ${PINNED_FACTS_MAX_CHARS} chars (got ${contentMd.length})`
    )
  }
  const now = Date.now()
  const sql = `
    INSERT INTO field_pinned_facts (worktree_id, content_md, updated_at, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(worktree_id) DO UPDATE SET
      content_md = excluded.content_md,
      updated_at = excluded.updated_at
  `
  getDatabase().getDbHandle().prepare(sql).run(worktreeId, contentMd, now, now)
  // Re-read so callers always see the canonical createdAt.
  const record = getPinnedFacts(worktreeId)
  if (!record) {
    throw new Error(`Failed to upsert pinned facts for worktree ${worktreeId}`)
  }
  return record
}

/** Test helper — remove the pinned facts row for a worktree. */
export function deletePinnedFacts(worktreeId: string): number {
  const result = getDatabase()
    .getDbHandle()
    .prepare(`DELETE FROM field_pinned_facts WHERE worktree_id = ?`)
    .run(worktreeId)
  return result.changes
}
