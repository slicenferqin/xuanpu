import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/db', () => ({
  getDatabase: () => {
    const g = globalThis as unknown as { __memoryPageTestDb?: FakeDatabaseService }
    if (!g.__memoryPageTestDb) throw new Error('test DB not initialized')
    return g.__memoryPageTestDb
  }
}))

import {
  acceptMemoryPageProposal,
  createMemoryPageProposal,
  deleteMemoryPage,
  getMemoryPage,
  listMemoryPages,
  updateMemoryPage,
  type FieldMemoryProposalCreate
} from '../../src/main/field/memory-page-repository'
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../src/main/db/schema'

interface FakeMemoryPageRow {
  id: string
  scope: string
  scope_id: string
  project_id: string | null
  worktree_id: string | null
  session_id: string | null
  episode_id: string | null
  command_trace_id: string | null
  kind: string
  status: string
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

class FakeDatabaseService {
  readonly rows: FakeMemoryPageRow[] = []

  getDb(): FakeDb {
    return new FakeDb(this.rows)
  }
}

class FakeDb {
  constructor(private readonly rows: FakeMemoryPageRow[]) {}

  prepare(sql: string): FakeStatement {
    return new FakeStatement(sql, this.rows)
  }
}

class FakeStatement {
  constructor(
    private readonly sql: string,
    private readonly rows: FakeMemoryPageRow[]
  ) {}

  run(...params: unknown[]): { changes: number } {
    if (this.sql.includes('INSERT INTO field_memory_pages')) {
      this.rows.push({
        id: String(params[0]),
        scope: String(params[1]),
        scope_id: String(params[2]),
        project_id: nullableString(params[3]),
        worktree_id: nullableString(params[4]),
        session_id: nullableString(params[5]),
        episode_id: nullableString(params[6]),
        command_trace_id: nullableString(params[7]),
        kind: String(params[8]),
        status: String(params[9]),
        title: String(params[10]),
        body_markdown: String(params[11]),
        entities_json: String(params[12]),
        raw_refs_json: String(params[13]),
        retrieval_hints_json: String(params[14]),
        source: String(params[15]),
        proposed_by: String(params[16]),
        proposal_reason: nullableString(params[17]),
        created_at: Number(params[18]),
        updated_at: Number(params[19]),
        accepted_at: nullableNumber(params[20]),
        rejected_at: nullableNumber(params[21]),
        archived_at: nullableNumber(params[22])
      })
      return { changes: 1 }
    }

    if (this.sql.includes('UPDATE field_memory_pages')) {
      const id = String(params[12])
      const row = this.rows.find((item) => item.id === id)
      if (!row) return { changes: 0 }
      row.kind = String(params[0])
      row.status = String(params[1])
      row.title = String(params[2])
      row.body_markdown = String(params[3])
      row.entities_json = String(params[4])
      row.raw_refs_json = String(params[5])
      row.retrieval_hints_json = String(params[6])
      row.proposal_reason = nullableString(params[7])
      row.updated_at = Number(params[8])
      row.accepted_at = nullableNumber(params[9])
      row.rejected_at = nullableNumber(params[10])
      row.archived_at = nullableNumber(params[11])
      return { changes: 1 }
    }

    if (this.sql.includes('DELETE FROM field_memory_pages')) {
      const id = String(params[0])
      const before = this.rows.length
      const kept = this.rows.filter((row) => row.id !== id)
      this.rows.splice(0, this.rows.length, ...kept)
      return { changes: before - kept.length }
    }

    throw new Error(`Unexpected run SQL: ${this.sql}`)
  }

  get(id: string): FakeMemoryPageRow | undefined {
    if (!this.sql.includes('FROM field_memory_pages') || !this.sql.includes('WHERE id = ?')) {
      throw new Error(`Unexpected get SQL: ${this.sql}`)
    }
    return this.rows.find((row) => row.id === id)
  }

  all(...params: unknown[]): FakeMemoryPageRow[] {
    if (!this.sql.includes('FROM field_memory_pages')) {
      throw new Error(`Unexpected all SQL: ${this.sql}`)
    }
    let paramIndex = 0
    let rows = this.rows.slice()
    if (this.sql.includes('worktree_id = ?')) {
      rows = rows.filter((row) => row.worktree_id === params[paramIndex])
      paramIndex += 1
    }
    if (this.sql.includes('status IN')) {
      const statusCount = (this.sql.match(/\?/g)?.length ?? 1) - 1 - paramIndex
      const statuses = params.slice(paramIndex, paramIndex + statusCount).map(String)
      rows = rows.filter((row) => statuses.includes(row.status))
      paramIndex += statusCount
    }
    const limit = Number(params[paramIndex])
    rows.sort((left, right) => right.updated_at - left.updated_at)
    return rows.slice(0, limit)
  }
}

describe('field memory page repository', () => {
  beforeEach(() => {
    ;(globalThis as unknown as { __memoryPageTestDb?: FakeDatabaseService }).__memoryPageTestDb =
      new FakeDatabaseService()
  })

  afterEach(() => {
    delete (globalThis as unknown as { __memoryPageTestDb?: FakeDatabaseService })
      .__memoryPageTestDb
    vi.clearAllMocks()
  })

  it('requires raw refs and persists proposal-based memory lifecycle', () => {
    expect(() => createMemoryPageProposal({ ...proposal(), rawRefs: [] })).toThrow(/rawRefs/)

    const created = createMemoryPageProposal(proposal())
    expect(created.status).toBe('proposed')
    expect(getMemoryPage(created.id)?.rawRefs).toEqual([{ type: 'session_message', id: 'msg-1' }])

    const accepted = acceptMemoryPageProposal(created.id)
    expect(accepted.status).toBe('accepted')
    expect(accepted.acceptedAt).toEqual(expect.any(Number))

    const edited = updateMemoryPage(created.id, { bodyMarkdown: 'Use pnpm for every command.' })
    expect(edited.bodyMarkdown).toBe('Use pnpm for every command.')

    expect(
      listMemoryPages({ worktreeId: 'worktree-1', status: 'accepted' }).map((p) => p.id)
    ).toEqual([created.id])
    expect(deleteMemoryPage(created.id)).toBe(true)
    expect(getMemoryPage(created.id)).toBeNull()
  })

  it('defines the M5 memory page migration', () => {
    const migration = MIGRATIONS.find((item) => item.name === 'add_field_memory_pages')
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(31)
    expect(migration?.up).toContain('CREATE TABLE IF NOT EXISTS field_memory_pages')
    expect(migration?.up).toContain(
      "scope IN ('user', 'project', 'worktree', 'session', 'episode', 'command')"
    )
    expect(migration?.up).toContain("kind IN ('fact', 'decision', 'assumption', 'constraint')")
    expect(migration?.up).toContain('raw_refs_json TEXT NOT NULL')
    expect(migration?.down).toContain('DROP TABLE IF EXISTS field_memory_pages')
  })
})

function proposal(): FieldMemoryProposalCreate {
  return {
    scope: 'worktree',
    scopeId: 'worktree-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    kind: 'constraint',
    title: 'Use pnpm',
    bodyMarkdown: 'Use pnpm for every command.',
    entities: [{ type: 'command', value: 'pnpm' }],
    rawRefs: [{ type: 'session_message', id: 'msg-1' }],
    retrievalHints: ['pnpm'],
    source: 'test',
    proposedBy: 'test'
  }
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}
