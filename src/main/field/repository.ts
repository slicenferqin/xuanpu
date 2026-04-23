/**
 * Field Event Stream — read API.
 *
 * Phase 21 — see docs/prd/phase-21-field-events.md §7
 *
 * The dump script (M10) and Phase 22 memory layer both consume this API.
 * Ordering is always by (timestamp, seq) — seq breaks ties within the same
 * millisecond for deterministic replay.
 */
import { getDatabase } from '../db'
import type { FieldEventType, FieldEvent } from '../../shared/types'
import { getFieldEventSink, type SinkCounters } from './sink'

export interface FieldEventQuery {
  worktreeId?: string | null
  projectId?: string | null
  sessionId?: string | null
  type?: FieldEventType | FieldEventType[]
  /** Lower bound, unix ms, inclusive. */
  since?: number
  /** Upper bound, unix ms, exclusive. */
  until?: number
  /** Default 100, hard max 1000. */
  limit?: number
  /** Ordering on (timestamp, seq). Default 'desc'. */
  order?: 'asc' | 'desc'
}

/**
 * A field event as returned from the DB. Shape differs from `FieldEvent` in
 * that `seq` is present and `payload` is already parsed.
 */
export type StoredFieldEvent = FieldEvent & { seq: number }

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

interface Row {
  seq: number
  id: string
  timestamp: number
  worktree_id: string | null
  project_id: string | null
  session_id: string | null
  type: string
  related_event_id: string | null
  payload_json: string
}

function rowToStored(row: Row): StoredFieldEvent {
  let payload: unknown
  try {
    payload = JSON.parse(row.payload_json)
  } catch {
    payload = null
  }
  // The DB column set and FieldEvent discriminated union are aligned by design.
  return {
    seq: row.seq,
    id: row.id,
    timestamp: row.timestamp,
    worktreeId: row.worktree_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    relatedEventId: row.related_event_id,
    type: row.type as FieldEventType,
    payload
  } as StoredFieldEvent
}

export function getRecentFieldEvents(query: FieldEventQuery = {}): StoredFieldEvent[] {
  const clauses: string[] = []
  const params: unknown[] = []

  if (query.worktreeId !== undefined) {
    if (query.worktreeId === null) {
      clauses.push('worktree_id IS NULL')
    } else {
      clauses.push('worktree_id = ?')
      params.push(query.worktreeId)
    }
  }

  if (query.projectId !== undefined) {
    if (query.projectId === null) {
      clauses.push('project_id IS NULL')
    } else {
      clauses.push('project_id = ?')
      params.push(query.projectId)
    }
  }

  if (query.sessionId !== undefined) {
    if (query.sessionId === null) {
      clauses.push('session_id IS NULL')
    } else {
      clauses.push('session_id = ?')
      params.push(query.sessionId)
    }
  }

  if (query.type !== undefined) {
    if (Array.isArray(query.type)) {
      if (query.type.length === 0) return []
      const placeholders = query.type.map(() => '?').join(', ')
      clauses.push(`type IN (${placeholders})`)
      params.push(...query.type)
    } else {
      clauses.push('type = ?')
      params.push(query.type)
    }
  }

  if (query.since !== undefined) {
    clauses.push('timestamp >= ?')
    params.push(query.since)
  }

  if (query.until !== undefined) {
    clauses.push('timestamp < ?')
    params.push(query.until)
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const order = query.order === 'asc' ? 'ASC' : 'DESC'
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)

  const sql = `SELECT seq, id, timestamp, worktree_id, project_id, session_id,
                      type, related_event_id, payload_json
               FROM field_events
               ${where}
               ORDER BY timestamp ${order}, seq ${order}
               LIMIT ?`

  const rows = getDatabase().getDbHandle().prepare(sql).all(...params, limit) as Row[]
  return rows.map(rowToStored)
}

/** Forward the sink's observability counters. */
export function getFieldEventCounters(): SinkCounters {
  return getFieldEventSink().getCounters()
}
