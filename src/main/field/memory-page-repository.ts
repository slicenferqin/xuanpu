import { randomUUID } from 'node:crypto'

import { getDatabase } from '../db'
import type {
  FieldMemoryEntity,
  FieldMemoryKind,
  FieldMemoryPageListQuery,
  FieldMemoryPageRecord,
  FieldMemoryPageUpdate,
  FieldMemoryProposalCreate,
  FieldMemoryRawRef,
  FieldMemoryScope,
  FieldMemoryStatus
} from '../../shared/types/field-memory'

export type {
  FieldMemoryEntity,
  FieldMemoryKind,
  FieldMemoryPageListQuery,
  FieldMemoryPageRecord,
  FieldMemoryPageUpdate,
  FieldMemoryProposalCreate,
  FieldMemoryRawRef,
  FieldMemoryScope,
  FieldMemoryStatus
}

interface FieldMemoryPageRow {
  id: string
  scope: FieldMemoryScope
  scope_id: string
  project_id: string | null
  worktree_id: string | null
  session_id: string | null
  episode_id: string | null
  command_trace_id: string | null
  kind: FieldMemoryKind
  status: FieldMemoryStatus
  title: string
  body_markdown: string
  entities_json: string
  raw_refs_json: string
  retrieval_hints_json: string
  source: string
  proposed_by: string
  proposal_reason: string | null
  created_at: number
  updated_at: number
  accepted_at: number | null
  rejected_at: number | null
  archived_at: number | null
}

const VALID_SCOPES = new Set<FieldMemoryScope>([
  'user',
  'project',
  'worktree',
  'session',
  'episode',
  'command'
])
const VALID_KINDS = new Set<FieldMemoryKind>(['fact', 'decision', 'assumption', 'constraint'])
const VALID_STATUSES = new Set<FieldMemoryStatus>(['proposed', 'accepted', 'rejected', 'archived'])

export function createMemoryPageProposal(data: FieldMemoryProposalCreate): FieldMemoryPageRecord {
  validateProposal(data)
  const now = Date.now()
  const record: FieldMemoryPageRecord = {
    id: randomUUID(),
    scope: data.scope,
    scopeId: data.scopeId,
    projectId: data.projectId ?? null,
    worktreeId: data.worktreeId ?? null,
    sessionId: data.sessionId ?? null,
    episodeId: data.episodeId ?? null,
    commandTraceId: data.commandTraceId ?? null,
    kind: data.kind,
    status: 'proposed',
    title: normalizeTitle(data.title),
    bodyMarkdown: data.bodyMarkdown.trim(),
    entities: data.entities ?? [],
    rawRefs: data.rawRefs,
    retrievalHints: uniqueStrings(data.retrievalHints ?? []),
    source: data.source,
    proposedBy: data.proposedBy ?? 'xuanpu-agent',
    proposalReason: data.proposalReason ?? null,
    createdAt: now,
    updatedAt: now,
    acceptedAt: null,
    rejectedAt: null,
    archivedAt: null
  }

  getDatabase()
    .getDb()
    .prepare(
      `INSERT INTO field_memory_pages (
        id,
        scope,
        scope_id,
        project_id,
        worktree_id,
        session_id,
        episode_id,
        command_trace_id,
        kind,
        status,
        title,
        body_markdown,
        entities_json,
        raw_refs_json,
        retrieval_hints_json,
        source,
        proposed_by,
        proposal_reason,
        created_at,
        updated_at,
        accepted_at,
        rejected_at,
        archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.scope,
      record.scopeId,
      record.projectId ?? null,
      record.worktreeId ?? null,
      record.sessionId ?? null,
      record.episodeId ?? null,
      record.commandTraceId ?? null,
      record.kind,
      record.status,
      record.title,
      record.bodyMarkdown,
      JSON.stringify(record.entities),
      JSON.stringify(record.rawRefs),
      JSON.stringify(record.retrievalHints),
      record.source,
      record.proposedBy,
      record.proposalReason ?? null,
      record.createdAt,
      record.updatedAt,
      record.acceptedAt ?? null,
      record.rejectedAt ?? null,
      record.archivedAt ?? null
    )

  return record
}

export function getMemoryPage(id: string): FieldMemoryPageRecord | null {
  const row = getDatabase().getDb().prepare(selectMemoryPageSql('WHERE id = ?')).get(id) as
    | FieldMemoryPageRow
    | undefined
  return row ? hydrateRow(row) : null
}

export function listMemoryPages(query: FieldMemoryPageListQuery = {}): FieldMemoryPageRecord[] {
  const clauses: string[] = []
  const params: unknown[] = []

  if (query.scope) {
    clauses.push('scope = ?')
    params.push(query.scope)
  }
  if (query.scopeId) {
    clauses.push('scope_id = ?')
    params.push(query.scopeId)
  }
  if (query.projectId) {
    clauses.push('project_id = ?')
    params.push(query.projectId)
  }
  if (query.worktreeId) {
    clauses.push('worktree_id = ?')
    params.push(query.worktreeId)
  }
  if (query.sessionId) {
    clauses.push('session_id = ?')
    params.push(query.sessionId)
  }

  const statuses = query.status ? [query.status] : query.statuses
  if (statuses && statuses.length > 0) {
    const validStatuses = statuses.filter((status) => VALID_STATUSES.has(status))
    if (validStatuses.length > 0) {
      clauses.push(`status IN (${validStatuses.map(() => '?').join(', ')})`)
      params.push(...validStatuses)
    }
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return runListQuery(where, params, query.limit)
}

export function listMemoryPagesForContext(input: {
  projectId?: string | null
  worktreeId?: string | null
  sessionId?: string | null
  limit?: number
}): FieldMemoryPageRecord[] {
  const clauses = ["status = 'accepted'"]
  const scopeClauses = ["scope = 'user'"]
  const params: unknown[] = []

  if (input.projectId) {
    scopeClauses.push('project_id = ?')
    params.push(input.projectId)
  }
  if (input.worktreeId) {
    scopeClauses.push('worktree_id = ?')
    params.push(input.worktreeId)
  }
  if (input.sessionId) {
    scopeClauses.push('session_id = ?')
    params.push(input.sessionId)
  }

  clauses.push(`(${scopeClauses.join(' OR ')})`)
  return runListQuery(`WHERE ${clauses.join(' AND ')}`, params, input.limit)
}

export function acceptMemoryPageProposal(
  id: string,
  patch: FieldMemoryPageUpdate = {}
): FieldMemoryPageRecord {
  const current = requireMemoryPage(id)
  if (current.status !== 'proposed') {
    throw new Error(`Memory page ${id} is not a proposal`)
  }
  const now = Date.now()
  const next = applyPatch(current, patch, {
    status: 'accepted',
    acceptedAt: now,
    updatedAt: now
  })
  validateRecord(next)
  updateRow(next)
  return next
}

export function rejectMemoryPageProposal(
  id: string,
  reason?: string | null
): FieldMemoryPageRecord {
  const current = requireMemoryPage(id)
  if (current.status !== 'proposed') {
    throw new Error(`Memory page ${id} is not a proposal`)
  }
  const now = Date.now()
  const next: FieldMemoryPageRecord = {
    ...current,
    status: 'rejected',
    proposalReason: reason ?? current.proposalReason ?? null,
    updatedAt: now,
    rejectedAt: now
  }
  updateRow(next)
  return next
}

export function updateMemoryPage(id: string, patch: FieldMemoryPageUpdate): FieldMemoryPageRecord {
  const current = requireMemoryPage(id)
  if (current.status === 'rejected' || current.status === 'archived') {
    throw new Error(`Memory page ${id} is not editable`)
  }
  const next = applyPatch(current, patch, { updatedAt: Date.now() })
  validateRecord(next)
  updateRow(next)
  return next
}

export function deleteMemoryPage(id: string): boolean {
  const result = getDatabase()
    .getDb()
    .prepare('DELETE FROM field_memory_pages WHERE id = ?')
    .run(id)
  return result.changes > 0
}

function requireMemoryPage(id: string): FieldMemoryPageRecord {
  const record = getMemoryPage(id)
  if (!record) throw new Error(`Memory page ${id} not found`)
  return record
}

function applyPatch(
  current: FieldMemoryPageRecord,
  patch: FieldMemoryPageUpdate,
  statusPatch: Partial<FieldMemoryPageRecord>
): FieldMemoryPageRecord {
  return {
    ...current,
    ...statusPatch,
    title: patch.title === undefined ? current.title : normalizeTitle(patch.title),
    bodyMarkdown:
      patch.bodyMarkdown === undefined ? current.bodyMarkdown : patch.bodyMarkdown.trim(),
    kind: patch.kind ?? current.kind,
    entities: patch.entities ?? current.entities,
    rawRefs: patch.rawRefs ?? current.rawRefs,
    retrievalHints: uniqueStrings(patch.retrievalHints ?? current.retrievalHints)
  }
}

function updateRow(record: FieldMemoryPageRecord): void {
  getDatabase()
    .getDb()
    .prepare(
      `UPDATE field_memory_pages
          SET kind = ?,
              status = ?,
              title = ?,
              body_markdown = ?,
              entities_json = ?,
              raw_refs_json = ?,
              retrieval_hints_json = ?,
              proposal_reason = ?,
              updated_at = ?,
              accepted_at = ?,
              rejected_at = ?,
              archived_at = ?
        WHERE id = ?`
    )
    .run(
      record.kind,
      record.status,
      record.title,
      record.bodyMarkdown,
      JSON.stringify(record.entities),
      JSON.stringify(record.rawRefs),
      JSON.stringify(record.retrievalHints),
      record.proposalReason ?? null,
      record.updatedAt,
      record.acceptedAt ?? null,
      record.rejectedAt ?? null,
      record.archivedAt ?? null,
      record.id
    )
}

function runListQuery(where: string, params: unknown[], limit?: number): FieldMemoryPageRecord[] {
  const rows = getDatabase()
    .getDb()
    .prepare(`${selectMemoryPageSql(where)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(...params, normalizeLimit(limit)) as FieldMemoryPageRow[]
  return rows.map(hydrateRow)
}

function selectMemoryPageSql(where: string): string {
  return `SELECT
      id,
      scope,
      scope_id,
      project_id,
      worktree_id,
      session_id,
      episode_id,
      command_trace_id,
      kind,
      status,
      title,
      body_markdown,
      entities_json,
      raw_refs_json,
      retrieval_hints_json,
      source,
      proposed_by,
      proposal_reason,
      created_at,
      updated_at,
      accepted_at,
      rejected_at,
      archived_at
    FROM field_memory_pages
    ${where}`
}

function validateProposal(data: FieldMemoryProposalCreate): void {
  validateRecord({
    id: 'proposal',
    scope: data.scope,
    scopeId: data.scopeId,
    projectId: data.projectId ?? null,
    worktreeId: data.worktreeId ?? null,
    sessionId: data.sessionId ?? null,
    episodeId: data.episodeId ?? null,
    commandTraceId: data.commandTraceId ?? null,
    kind: data.kind,
    status: 'proposed',
    title: data.title,
    bodyMarkdown: data.bodyMarkdown,
    entities: data.entities ?? [],
    rawRefs: data.rawRefs,
    retrievalHints: data.retrievalHints ?? [],
    source: data.source,
    proposedBy: data.proposedBy ?? 'xuanpu-agent',
    proposalReason: data.proposalReason ?? null,
    createdAt: 0,
    updatedAt: 0
  })
}

function validateRecord(record: FieldMemoryPageRecord): void {
  if (!VALID_SCOPES.has(record.scope)) throw new Error(`Invalid memory scope: ${record.scope}`)
  if (!record.scopeId.trim()) throw new Error('Memory page requires scopeId')
  if (!VALID_KINDS.has(record.kind)) throw new Error(`Invalid memory kind: ${record.kind}`)
  if (!VALID_STATUSES.has(record.status)) throw new Error(`Invalid memory status: ${record.status}`)
  if (!normalizeTitle(record.title)) throw new Error('Memory page requires title')
  if (!record.bodyMarkdown.trim()) throw new Error('Memory page requires bodyMarkdown')
  if (record.rawRefs.length === 0) throw new Error('Memory page requires rawRefs')
  for (const ref of record.rawRefs) {
    if (!ref.id?.trim()) throw new Error('Memory raw ref requires id')
  }
}

function hydrateRow(row: FieldMemoryPageRow): FieldMemoryPageRecord {
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    sessionId: row.session_id,
    episodeId: row.episode_id,
    commandTraceId: row.command_trace_id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    bodyMarkdown: row.body_markdown,
    entities: parseJson<FieldMemoryEntity[]>(row.entities_json, []),
    rawRefs: parseJson<FieldMemoryRawRef[]>(row.raw_refs_json, []),
    retrievalHints: parseJson<string[]>(row.retrieval_hints_json, []),
    source: row.source,
    proposedBy: row.proposed_by,
    proposalReason: row.proposal_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at,
    rejectedAt: row.rejected_at,
    archivedAt: row.archived_at
  }
}

function normalizeTitle(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed
}

function normalizeLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return 50
  return Math.min(Math.max(Math.trunc(limit as number), 1), 200)
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).slice(0, 50)
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
