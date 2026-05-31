import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/db', () => ({
  getDatabase: () => {
    const g = globalThis as unknown as { __contextPackageTestDb?: FakeDatabaseService }
    if (!g.__contextPackageTestDb) throw new Error('test DB not initialized')
    return g.__contextPackageTestDb
  }
}))

import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../src/main/db/schema'
import {
  createFieldContextPackage,
  getFieldContextPackage,
  listFieldContextPackages,
  type FieldContextPackageCreate
} from '../../src/main/field/context-package-repository'

interface FakeContextPackageRow {
  id: string
  session_id: string
  worktree_id: string
  runtime_id: string
  model_provider_id: string | null
  model_id: string | null
  created_at: number
  budget_profile: string
  approx_tokens: number
  sections_json: string
  rendered_markdown: string | null
  decisions_json: string
}

class FakeDatabaseService {
  readonly rows: FakeContextPackageRow[] = []

  getDb(): FakeDb {
    return new FakeDb(this.rows)
  }
}

class FakeDb {
  constructor(private readonly rows: FakeContextPackageRow[]) {}

  prepare(sql: string): FakeStatement {
    return new FakeStatement(sql, this.rows)
  }
}

class FakeStatement {
  constructor(
    private readonly sql: string,
    private readonly rows: FakeContextPackageRow[]
  ) {}

  run(...params: unknown[]): void {
    if (!this.sql.includes('INSERT INTO field_context_packages')) {
      throw new Error(`Unexpected run SQL: ${this.sql}`)
    }

    this.rows.push({
      id: String(params[0]),
      session_id: String(params[1]),
      worktree_id: String(params[2]),
      runtime_id: String(params[3]),
      model_provider_id: params[4] === null ? null : String(params[4]),
      model_id: params[5] === null ? null : String(params[5]),
      created_at: Number(params[6]),
      budget_profile: String(params[7]),
      approx_tokens: Number(params[8]),
      sections_json: String(params[9]),
      rendered_markdown: params[10] === null ? null : String(params[10]),
      decisions_json: String(params[11])
    })
  }

  get(id: string): FakeContextPackageRow | undefined {
    if (!this.sql.includes('FROM field_context_packages') || !this.sql.includes('WHERE id = ?')) {
      throw new Error(`Unexpected get SQL: ${this.sql}`)
    }
    return this.rows.find((row) => row.id === id)
  }

  all(...params: unknown[]): FakeContextPackageRow[] {
    if (!this.sql.includes('FROM field_context_packages')) {
      throw new Error(`Unexpected all SQL: ${this.sql}`)
    }

    let paramIndex = 0
    let rows = this.rows.slice()

    if (this.sql.includes('session_id = ?')) {
      rows = rows.filter((row) => row.session_id === params[paramIndex])
      paramIndex += 1
    }
    if (this.sql.includes('worktree_id = ?')) {
      rows = rows.filter((row) => row.worktree_id === params[paramIndex])
      paramIndex += 1
    }
    if (this.sql.includes('runtime_id = ?')) {
      rows = rows.filter((row) => row.runtime_id === params[paramIndex])
      paramIndex += 1
    }

    const direction = this.sql.includes('ORDER BY created_at ASC') ? 1 : -1
    rows.sort((a, b) => {
      if (a.created_at !== b.created_at) return direction * (a.created_at - b.created_at)
      return direction * a.id.localeCompare(b.id)
    })

    const limit = Number(params[paramIndex])
    return rows.slice(0, limit)
  }
}

let fakeDb: FakeDatabaseService

beforeEach(() => {
  fakeDb = new FakeDatabaseService()
  ;(
    globalThis as unknown as { __contextPackageTestDb: FakeDatabaseService }
  ).__contextPackageTestDb = fakeDb
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as unknown as { __contextPackageTestDb?: FakeDatabaseService })
    .__contextPackageTestDb
})

function createPackage(overrides: Partial<FieldContextPackageCreate> = {}) {
  return createFieldContextPackage({
    sessionId: 'session-1',
    worktreeId: 'worktree-1',
    runtimeId: 'xuanpu-agent',
    modelProviderId: 'anthropic',
    modelId: 'claude-haiku-4-5',
    budgetProfile: 'balanced',
    approxTokens: 42,
    sections: [
      {
        id: 'current-field',
        kind: 'current_field',
        title: 'Current Field',
        included: true,
        approxTokens: 30,
        source: 'field-context',
        metadata: { wasTruncated: false }
      }
    ],
    renderedMarkdown: '## Current Field\n\ntrace',
    decisions: {
      phase: 'phase-1-no-tools-provider',
      providerExecution: 'enabled',
      renderedMarkdownPolicy: 'stored-by-explicit-env'
    },
    ...overrides
  })
}

describe('field context package repository', () => {
  it('defines the context package migration and query indexes', () => {
    const migration = MIGRATIONS.find((item) => item.name === 'add_field_context_packages')
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(24)
    expect(migration?.name).toBe('add_field_context_packages')
    expect(migration?.up).toContain('CREATE TABLE IF NOT EXISTS field_context_packages')
    expect(migration?.up).toContain('sections_json TEXT NOT NULL')
    expect(migration?.up).toContain('rendered_markdown TEXT')
    expect(migration?.up).toContain('decisions_json TEXT NOT NULL')
    expect(migration?.up).toContain('idx_field_context_packages_session_created')
    expect(migration?.up).toContain('idx_field_context_packages_worktree_created')
    expect(migration?.down).toContain('DROP TABLE IF EXISTS field_context_packages')
  })

  it('stores packages and hides full rendered markdown by default when reading', () => {
    vi.setSystemTime(1000)
    const created = createPackage()

    const hidden = getFieldContextPackage(created.id)
    expect(hidden).toMatchObject({
      id: created.id,
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      runtimeId: 'xuanpu-agent',
      modelProviderId: 'anthropic',
      modelId: 'claude-haiku-4-5',
      budgetProfile: 'balanced',
      approxTokens: 42,
      renderedMarkdown: null,
      renderedMarkdownStored: true
    })
    expect(hidden?.sections[0]).toMatchObject({
      id: 'current-field',
      kind: 'current_field',
      included: true
    })
    expect(hidden?.decisions).toMatchObject({
      phase: 'phase-1-no-tools-provider',
      providerExecution: 'enabled'
    })

    const full = getFieldContextPackage(created.id, { includeRenderedMarkdown: true })
    expect(full?.renderedMarkdown).toBe('## Current Field\n\ntrace')
  })

  it('lists packages by session, worktree, runtime, order, and limit', () => {
    vi.setSystemTime(1000)
    const first = createPackage({ sessionId: 'session-1', worktreeId: 'worktree-1' })
    vi.setSystemTime(2000)
    const second = createPackage({ sessionId: 'session-1', worktreeId: 'worktree-1' })
    vi.setSystemTime(3000)
    createPackage({ sessionId: 'session-2', worktreeId: 'worktree-2' })

    expect(listFieldContextPackages({ sessionId: 'session-1' }).map((item) => item.id)).toEqual([
      second.id,
      first.id
    ])
    expect(
      listFieldContextPackages({
        worktreeId: 'worktree-1',
        runtimeId: 'xuanpu-agent',
        order: 'asc',
        limit: 1
      }).map((item) => item.id)
    ).toEqual([first.id])
    expect(listFieldContextPackages({ worktreeId: 'missing' })).toEqual([])
  })
})
