import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'

vi.mock('@shared/app-identity', () => ({
  getActiveAppDatabasePath: (home: string) => join(home, '.xuanpu', 'test.db'),
  APP_BUNDLE_ID: 'test',
  APP_CLI_NAME: 'test',
  APP_PRODUCT_NAME: 'test'
}))

import { DatabaseService } from '../../../src/main/db/database'

let tmpDir: string
let db: DatabaseService

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-episodic-schema-'))
  db = new DatabaseService(join(tmpDir, 'test.db'))
  db.init()
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('field_episodic_memory schema (Phase 22B.1 M1)', () => {
  describe('schema', () => {
    it('migration v15 creates table with expected columns', () => {
      const cols = db
        .getDbHandle()
        .pragma('table_info(field_episodic_memory)') as Array<{ name: string }>
      const names = cols.map((c) => c.name).sort()
      expect(names).toEqual(
        [
          'compactor_id',
          'compacted_at',
          'source_event_count',
          'source_since',
          'source_until',
          'summary_markdown',
          'version',
          'worktree_id'
        ].sort()
      )
    })

    it('worktree_id is the PRIMARY KEY (one row per worktree)', () => {
      const cols = db
        .getDbHandle()
        .pragma('table_info(field_episodic_memory)') as Array<{ name: string; pk: number }>
      const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name)
      expect(pkCols).toEqual(['worktree_id'])
    })

    it('idx_field_episodic_memory_compacted exists', () => {
      const indexes = (db
        .getDbHandle()
        .pragma('index_list(field_episodic_memory)') as Array<{ name: string }>).map((i) => i.name)
      expect(indexes).toContain('idx_field_episodic_memory_compacted')
    })

    it('schema version is 15', () => {
      expect(db.getSchemaVersion()).toBe(15)
    })
  })

  describe('CRUD', () => {
    const sample = {
      worktreeId: 'w-1',
      summaryMarkdown: '## Observed Recent Work\n- ran 3 commands',
      compactorId: 'rule-based',
      version: 1,
      compactedAt: 1_700_000_000_000,
      sourceEventCount: 42,
      sourceSince: 1_699_999_000_000,
      sourceUntil: 1_700_000_000_000
    }

    it('upsert + get round-trips a complete entry', () => {
      db.upsertEpisodicMemory(sample)
      const got = db.getEpisodicMemory('w-1')
      expect(got).toEqual(sample)
    })

    it('upsert is idempotent and overwrites prior value for same worktree', () => {
      db.upsertEpisodicMemory(sample)
      db.upsertEpisodicMemory({
        ...sample,
        summaryMarkdown: 'updated',
        version: 2,
        compactedAt: sample.compactedAt + 1000
      })
      const got = db.getEpisodicMemory('w-1')
      expect(got?.summaryMarkdown).toBe('updated')
      expect(got?.version).toBe(2)
    })

    it('get returns null for unknown worktreeId', () => {
      expect(db.getEpisodicMemory('missing')).toBeNull()
    })

    it('delete removes the entry and returns true on hit', () => {
      db.upsertEpisodicMemory(sample)
      expect(db.deleteEpisodicMemory('w-1')).toBe(true)
      expect(db.getEpisodicMemory('w-1')).toBeNull()
    })

    it('delete returns false when nothing to remove', () => {
      expect(db.deleteEpisodicMemory('missing')).toBe(false)
    })

    it('upsert preserves zero-ish values (sourceEventCount = 0, etc.)', () => {
      db.upsertEpisodicMemory({ ...sample, sourceEventCount: 0, version: 0 })
      const got = db.getEpisodicMemory('w-1')
      expect(got?.sourceEventCount).toBe(0)
      expect(got?.version).toBe(0)
    })

    it('isolates per-worktree storage', () => {
      db.upsertEpisodicMemory({ ...sample, worktreeId: 'w-1' })
      db.upsertEpisodicMemory({
        ...sample,
        worktreeId: 'w-2',
        summaryMarkdown: 'w2 summary'
      })
      expect(db.getEpisodicMemory('w-1')?.summaryMarkdown).toContain('Observed Recent Work')
      expect(db.getEpisodicMemory('w-2')?.summaryMarkdown).toBe('w2 summary')
    })
  })
})
