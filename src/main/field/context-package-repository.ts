import { randomUUID } from 'node:crypto'

import { getDatabase } from '../db'

export interface FieldContextPackageSection {
  id: string
  kind: 'anchor' | 'frozen_episodes' | 'retrieved_episodes' | 'working_set' | 'current_field'
  title: string
  included: boolean
  approxTokens: number
  source?: string
  reason?: string
  metadata?: Record<string, unknown>
}

export interface FieldContextPackageCreate {
  sessionId: string
  worktreeId: string
  runtimeId: string
  modelProviderId?: string | null
  modelId?: string | null
  budgetProfile: 'focused' | 'balanced' | 'extended' | 'max'
  approxTokens: number
  sections: FieldContextPackageSection[]
  renderedMarkdown?: string | null
  decisions: Record<string, unknown>
}

export interface FieldContextPackageRecord extends FieldContextPackageCreate {
  id: string
  createdAt: number
  renderedMarkdownStored?: boolean
}

interface FieldContextPackageRow {
  id: string
  session_id: string
  worktree_id: string
  runtime_id: string
  model_provider_id: string | null
  model_id: string | null
  created_at: number
  budget_profile: FieldContextPackageCreate['budgetProfile']
  approx_tokens: number
  sections_json: string
  rendered_markdown: string | null
  decisions_json: string
}

export interface FieldContextPackageReadOptions {
  includeRenderedMarkdown?: boolean
}

export interface FieldContextPackageQuery extends FieldContextPackageReadOptions {
  sessionId?: string
  worktreeId?: string
  runtimeId?: string
  limit?: number
  order?: 'asc' | 'desc'
}

export function createFieldContextPackage(
  data: FieldContextPackageCreate
): FieldContextPackageRecord {
  const record: FieldContextPackageRecord = {
    ...data,
    id: randomUUID(),
    createdAt: Date.now(),
    renderedMarkdownStored: Boolean(data.renderedMarkdown)
  }

  getDatabase()
    .getDb()
    .prepare(
      `INSERT INTO field_context_packages (
        id,
        session_id,
        worktree_id,
        runtime_id,
        model_provider_id,
        model_id,
        created_at,
        budget_profile,
        approx_tokens,
        sections_json,
        rendered_markdown,
        decisions_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.sessionId,
      record.worktreeId,
      record.runtimeId,
      record.modelProviderId ?? null,
      record.modelId ?? null,
      record.createdAt,
      record.budgetProfile,
      record.approxTokens,
      JSON.stringify(record.sections),
      record.renderedMarkdown ?? null,
      JSON.stringify(record.decisions)
    )

  return record
}

export function getFieldContextPackage(
  id: string,
  options: FieldContextPackageReadOptions = {}
): FieldContextPackageRecord | null {
  const row = getDatabase()
    .getDb()
    .prepare(
      `SELECT
        id,
        session_id,
        worktree_id,
        runtime_id,
        model_provider_id,
        model_id,
        created_at,
        budget_profile,
        approx_tokens,
        sections_json,
        rendered_markdown,
        decisions_json
      FROM field_context_packages
      WHERE id = ?`
    )
    .get(id) as FieldContextPackageRow | undefined

  return row ? hydrateRow(row, options) : null
}

export function listFieldContextPackages(
  query: FieldContextPackageQuery = {}
): FieldContextPackageRecord[] {
  const clauses: string[] = []
  const params: unknown[] = []

  if (query.sessionId) {
    clauses.push('session_id = ?')
    params.push(query.sessionId)
  }
  if (query.worktreeId) {
    clauses.push('worktree_id = ?')
    params.push(query.worktreeId)
  }
  if (query.runtimeId) {
    clauses.push('runtime_id = ?')
    params.push(query.runtimeId)
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const order = query.order === 'asc' ? 'ASC' : 'DESC'
  const limit = normalizeLimit(query.limit)

  const rows = getDatabase()
    .getDb()
    .prepare(
      `SELECT
        id,
        session_id,
        worktree_id,
        runtime_id,
        model_provider_id,
        model_id,
        created_at,
        budget_profile,
        approx_tokens,
        sections_json,
        rendered_markdown,
        decisions_json
      FROM field_context_packages
      ${where}
      ORDER BY created_at ${order}, id ${order}
      LIMIT ?`
    )
    .all(...params, limit) as FieldContextPackageRow[]

  return rows.map((row) => hydrateRow(row, query))
}

function hydrateRow(
  row: FieldContextPackageRow,
  options: FieldContextPackageReadOptions
): FieldContextPackageRecord {
  const renderedMarkdownStored = row.rendered_markdown !== null
  return {
    id: row.id,
    sessionId: row.session_id,
    worktreeId: row.worktree_id,
    runtimeId: row.runtime_id,
    modelProviderId: row.model_provider_id,
    modelId: row.model_id,
    createdAt: row.created_at,
    budgetProfile: row.budget_profile,
    approxTokens: row.approx_tokens,
    sections: parseJson<FieldContextPackageSection[]>(row.sections_json, []),
    renderedMarkdown: options.includeRenderedMarkdown ? row.rendered_markdown : null,
    renderedMarkdownStored,
    decisions: parseJson<Record<string, unknown>>(row.decisions_json, {})
  }
}

function normalizeLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return 50
  return Math.min(Math.max(Math.trunc(limit as number), 1), 200)
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
