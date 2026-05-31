import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/db', () => ({
  getDatabase: () => {
    const g = globalThis as unknown as { __episodeBlockTestDb?: FakeDatabaseService }
    if (!g.__episodeBlockTestDb) throw new Error('test DB not initialized')
    return g.__episodeBlockTestDb
  }
}))

import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../src/main/db/schema'
import {
  createFieldEpisodeBlock,
  createRuleBasedEpisodeFromTurns,
  getFieldEpisodeBlock,
  listFieldEpisodeBlocks,
  type FieldEpisodeBlockCreate
} from '../../src/main/field/episode-block-repository'

interface FakeEpisodeBlockRow {
  id: string
  worktree_id: string
  session_id: string | null
  created_at: number
  source_event_seq_start: number | null
  source_event_seq_end: number | null
  source_message_id_start: string | null
  source_message_id_end: string | null
  kind: string
  title: string | null
  summary_markdown: string
  key_facts_json: string
  constraints_json: string
  files_json: string
  commands_json: string
  failures_json: string
  raw_refs_json: string
  token_estimate: number
  confidence: string
}

class FakeDatabaseService {
  readonly rows: FakeEpisodeBlockRow[] = []

  getDb(): FakeDb {
    return new FakeDb(this.rows)
  }
}

class FakeDb {
  constructor(private readonly rows: FakeEpisodeBlockRow[]) {}

  prepare(sql: string): FakeStatement {
    return new FakeStatement(sql, this.rows)
  }
}

class FakeStatement {
  constructor(
    private readonly sql: string,
    private readonly rows: FakeEpisodeBlockRow[]
  ) {}

  run(...params: unknown[]): void {
    if (!this.sql.includes('INSERT INTO field_episode_blocks')) {
      throw new Error(`Unexpected run SQL: ${this.sql}`)
    }

    this.rows.push({
      id: String(params[0]),
      worktree_id: String(params[1]),
      session_id: params[2] === null ? null : String(params[2]),
      created_at: Number(params[3]),
      source_event_seq_start: params[4] === null ? null : Number(params[4]),
      source_event_seq_end: params[5] === null ? null : Number(params[5]),
      source_message_id_start: params[6] === null ? null : String(params[6]),
      source_message_id_end: params[7] === null ? null : String(params[7]),
      kind: String(params[8]),
      title: params[9] === null ? null : String(params[9]),
      summary_markdown: String(params[10]),
      key_facts_json: String(params[11]),
      constraints_json: String(params[12]),
      files_json: String(params[13]),
      commands_json: String(params[14]),
      failures_json: String(params[15]),
      raw_refs_json: String(params[16]),
      token_estimate: Number(params[17]),
      confidence: String(params[18])
    })
  }

  get(id: string): FakeEpisodeBlockRow | undefined {
    if (!this.sql.includes('FROM field_episode_blocks') || !this.sql.includes('WHERE id = ?')) {
      throw new Error(`Unexpected get SQL: ${this.sql}`)
    }
    return this.rows.find((row) => row.id === id)
  }

  all(...params: unknown[]): FakeEpisodeBlockRow[] {
    if (!this.sql.includes('FROM field_episode_blocks')) {
      throw new Error(`Unexpected all SQL: ${this.sql}`)
    }

    let paramIndex = 0
    let rows = this.rows.slice()

    if (this.sql.includes('worktree_id = ?')) {
      rows = rows.filter((row) => row.worktree_id === params[paramIndex])
      paramIndex += 1
    }
    if (this.sql.includes('session_id = ?')) {
      rows = rows.filter((row) => row.session_id === params[paramIndex])
      paramIndex += 1
    }
    if (this.sql.includes('kind = ?')) {
      rows = rows.filter((row) => row.kind === params[paramIndex])
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
  ;(globalThis as unknown as { __episodeBlockTestDb: FakeDatabaseService }).__episodeBlockTestDb =
    fakeDb
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as unknown as { __episodeBlockTestDb?: FakeDatabaseService })
    .__episodeBlockTestDb
})

function createEpisode(overrides: Partial<FieldEpisodeBlockCreate> = {}) {
  return createFieldEpisodeBlock({
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    kind: 'turns',
    title: 'Episode',
    summaryMarkdown: '## Episode\n\nSummary',
    keyFacts: ['Fact'],
    constraints: ['Keep raw refs mandatory'],
    files: ['src/main/app.ts'],
    commands: ['pnpm test'],
    failures: [],
    rawRefs: [{ type: 'session_message', id: 'message-1', role: 'user' }],
    confidence: 'medium',
    ...overrides
  })
}

describe('field episode block repository', () => {
  it('defines the immutable episode block migration and indexes', () => {
    const migration = MIGRATIONS.find((item) => item.name === 'add_field_episode_blocks')
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(25)
    expect(migration?.name).toBe('add_field_episode_blocks')
    expect(migration?.up).toContain('CREATE TABLE IF NOT EXISTS field_episode_blocks')
    expect(migration?.up).toContain('raw_refs_json TEXT NOT NULL')
    expect(migration?.up).toContain('failures_json TEXT NOT NULL')
    expect(migration?.up).toContain('idx_field_episode_blocks_worktree_created')
    expect(migration?.down).toContain('DROP TABLE IF EXISTS field_episode_blocks')
  })

  it('appends and reads episode blocks without update/delete APIs', () => {
    vi.setSystemTime(1000)
    const created = createEpisode()
    const read = getFieldEpisodeBlock(created.id)

    expect(read).toMatchObject({
      id: created.id,
      worktreeId: 'worktree-1',
      sessionId: 'session-1',
      kind: 'turns',
      title: 'Episode',
      summaryMarkdown: '## Episode\n\nSummary',
      keyFacts: ['Fact'],
      constraints: ['Keep raw refs mandatory'],
      files: ['src/main/app.ts'],
      commands: ['pnpm test'],
      rawRefs: [{ type: 'session_message', id: 'message-1', role: 'user' }],
      confidence: 'medium'
    })
    expect(read?.createdAt).toBe(1000)
    expect(read?.tokenEstimate).toBeGreaterThan(0)
  })

  it('requires raw refs for every episode block', () => {
    expect(() => createEpisode({ rawRefs: [] })).toThrow(/rawRefs/)
  })

  it('lists episode blocks by worktree, session, kind, order, and limit', () => {
    vi.setSystemTime(1000)
    const first = createEpisode({ sessionId: 'session-1', kind: 'turns' })
    vi.setSystemTime(2000)
    const second = createEpisode({ sessionId: 'session-1', kind: 'turns' })
    vi.setSystemTime(3000)
    createEpisode({ sessionId: 'session-2', kind: 'manual' })

    expect(
      listFieldEpisodeBlocks({ worktreeId: 'worktree-1', sessionId: 'session-1' }).map(
        (episode) => episode.id
      )
    ).toEqual([second.id, first.id])
    expect(
      listFieldEpisodeBlocks({
        worktreeId: 'worktree-1',
        kind: 'turns',
        order: 'asc',
        limit: 1
      }).map((episode) => episode.id)
    ).toEqual([first.id])
  })

  it('creates rule-based episodes with deterministic metadata extraction', () => {
    vi.setSystemTime(1000)
    const episode = createRuleBasedEpisodeFromTurns({
      worktreeId: 'worktree-1',
      sessionId: 'session-1',
      turns: [
        {
          messageId: 'm1',
          role: 'user',
          content: 'We must keep raw refs mandatory. Edit src/main/app.ts and run `pnpm test`.'
        },
        {
          messageId: 'm2',
          role: 'assistant',
          content: 'The previous build failed with timeout error. src/main/app.ts is updated.'
        }
      ]
    })

    expect(episode.sourceMessageIdStart).toBe('m1')
    expect(episode.sourceMessageIdEnd).toBe('m2')
    expect(episode.rawRefs.map((ref) => ref.id)).toEqual(['m1', 'm2'])
    expect(episode.constraints).toEqual([
      'We must keep raw refs mandatory. Edit src/main/app.ts and run `pnpm test`.'
    ])
    expect(episode.files).toContain('src/main/app.ts')
    expect(episode.commands).toContain('pnpm test')
    expect(episode.failures).toEqual([
      'The previous build failed with timeout error. src/main/app.ts is updated.'
    ])
  })
})
