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
}

export function createFieldContextPackage(
  data: FieldContextPackageCreate
): FieldContextPackageRecord {
  const record: FieldContextPackageRecord = {
    ...data,
    id: randomUUID(),
    createdAt: Date.now()
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
