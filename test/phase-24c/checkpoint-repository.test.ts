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

vi.mock('../../src/main/db', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/main/db')>('../../src/main/db')
  return {
    ...actual,
    getDatabase: () => {
      const g = globalThis as unknown as {
        __checkpointTestDb?: import('../../src/main/db/database').DatabaseService
      }
      if (!g.__checkpointTestDb) throw new Error('test DB not initialized')
      return g.__checkpointTestDb
    }
  }
})

import { DatabaseService } from '../../src/main/db/database'
import {
  insertCheckpoint,
  getLatestCheckpoint,
  deleteCheckpointsForWorktree,
  type CheckpointRecord
} from '../../src/main/field/checkpoint-repository'

let tmpDir: string
let db: DatabaseService

function makeRecord(overrides: Partial<CheckpointRecord> = {}): CheckpointRecord {
  const base: CheckpointRecord = {
    id: 'ck-1',
    createdAt: 1_700_000_000_000,
    worktreeId: 'w-1',
    sessionId: 's-1',
    branch: 'main',
    repoHead: 'abc123',
    source: 'abort',
    summary: 'Worked on main for 12min, edited 3 files.',
    currentGoal: 'Make refresh retry on 401',
    nextAction: 'Add backoff in src/auth/refresh.ts',
    blockingReason: null,
    hotFiles: ['src/auth/refresh.ts', 'src/auth/index.ts'],
    hotFileDigests: { 'src/auth/refresh.ts': 'sha1aaa', 'src/auth/index.ts': 'sha1bbb' },
    packetHash: 'hash-1'
  }
  return { ...base, ...overrides }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-checkpoint-repo-'))
  db = new DatabaseService(join(tmpDir, 'test.db'))
  db.init()
  ;(globalThis as unknown as { __checkpointTestDb: DatabaseService }).__checkpointTestDb = db
})

afterEach(() => {
  db.close()
  delete (globalThis as { __checkpointTestDb?: DatabaseService }).__checkpointTestDb
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('checkpoint-repository (Phase 24C)', () => {
  describe('insert + read round-trip', () => {
    it('inserts and reads back a complete record', () => {
      const rec = makeRecord()
      expect(insertCheckpoint(rec)).toBe(true)
      const got = getLatestCheckpoint('w-1')
      expect(got).toEqual(rec)
    })

    it('handles null branch / null repo_head (non-git or detached HEAD)', () => {
      const rec = makeRecord({ branch: null, repoHead: null })
      insertCheckpoint(rec)
      const got = getLatestCheckpoint('w-1')
      expect(got?.branch).toBeNull()
      expect(got?.repoHead).toBeNull()
    })

    it('handles null hotFileDigests (digest computation skipped)', () => {
      insertCheckpoint(makeRecord({ hotFileDigests: null }))
      expect(getLatestCheckpoint('w-1')?.hotFileDigests).toBeNull()
    })

    it('preserves null sha1 entries for individual files', () => {
      const digests = { 'a.ts': 'sha1xyz', 'missing.ts': null }
      insertCheckpoint(makeRecord({ hotFileDigests: digests }))
      expect(getLatestCheckpoint('w-1')?.hotFileDigests).toEqual(digests)
    })

    it('preserves empty hotFiles array', () => {
      insertCheckpoint(makeRecord({ hotFiles: [] }))
      expect(getLatestCheckpoint('w-1')?.hotFiles).toEqual([])
    })
  })

  describe('idempotency', () => {
    it('INSERT OR IGNORE: duplicate (worktree_id, packet_hash) returns false and does not duplicate', () => {
      expect(insertCheckpoint(makeRecord({ id: 'ck-a', packetHash: 'h-x' }))).toBe(true)
      // Second call with same packet_hash but different id — should be ignored
      expect(insertCheckpoint(makeRecord({ id: 'ck-b', packetHash: 'h-x' }))).toBe(false)
      const got = getLatestCheckpoint('w-1')
      expect(got?.id).toBe('ck-a') // first one wins
    })

    it('different packet_hash on same worktree creates a second row', () => {
      insertCheckpoint(makeRecord({ id: 'ck-a', packetHash: 'h-1', createdAt: 1000 }))
      insertCheckpoint(makeRecord({ id: 'ck-b', packetHash: 'h-2', createdAt: 2000 }))
      // getLatestCheckpoint returns most recent
      expect(getLatestCheckpoint('w-1')?.id).toBe('ck-b')
    })

    it('same packet_hash on different worktrees is allowed', () => {
      insertCheckpoint(makeRecord({ id: 'ck-a', worktreeId: 'w-1', packetHash: 'h-x' }))
      insertCheckpoint(makeRecord({ id: 'ck-b', worktreeId: 'w-2', packetHash: 'h-x' }))
      expect(getLatestCheckpoint('w-1')?.id).toBe('ck-a')
      expect(getLatestCheckpoint('w-2')?.id).toBe('ck-b')
    })
  })

  describe('getLatestCheckpoint', () => {
    it('returns null when worktree has no checkpoints', () => {
      expect(getLatestCheckpoint('w-unknown')).toBeNull()
    })

    it('returns the row with greatest created_at, not insertion order', () => {
      insertCheckpoint(makeRecord({ id: 'ck-old', packetHash: 'h-old', createdAt: 5000 }))
      insertCheckpoint(makeRecord({ id: 'ck-new', packetHash: 'h-new', createdAt: 9000 }))
      insertCheckpoint(
        makeRecord({ id: 'ck-mid', packetHash: 'h-mid', createdAt: 7000 })
      )
      expect(getLatestCheckpoint('w-1')?.id).toBe('ck-new')
    })

    it('isolates per-worktree reads', () => {
      insertCheckpoint(makeRecord({ id: 'ck-1', worktreeId: 'w-1' }))
      insertCheckpoint(
        makeRecord({ id: 'ck-2', worktreeId: 'w-2', packetHash: 'h-w2' })
      )
      expect(getLatestCheckpoint('w-1')?.id).toBe('ck-1')
      expect(getLatestCheckpoint('w-2')?.id).toBe('ck-2')
    })
  })

  describe('test helper deleteCheckpointsForWorktree', () => {
    it('removes all rows for a worktree and returns the count', () => {
      insertCheckpoint(makeRecord({ id: 'ck-1', packetHash: 'h-1' }))
      insertCheckpoint(makeRecord({ id: 'ck-2', packetHash: 'h-2' }))
      expect(deleteCheckpointsForWorktree('w-1')).toBe(2)
      expect(getLatestCheckpoint('w-1')).toBeNull()
    })

    it('returns 0 when no rows match', () => {
      expect(deleteCheckpointsForWorktree('w-nonexistent')).toBe(0)
    })
  })

  describe('graceful handling of malformed JSON', () => {
    it('hot_files_json with bad JSON is treated as empty array', () => {
      // Insert a row directly via SQL with malformed JSON
      db.getDbHandle()
        .prepare(
          `INSERT INTO field_session_checkpoints (
             id, created_at, worktree_id, session_id, branch, repo_head,
             source, summary, current_goal, next_action, blocking_reason,
             hot_files_json, hot_file_digests_json, packet_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'ck-bad',
          1000,
          'w-1',
          's-1',
          null,
          null,
          'abort',
          'broken row',
          null,
          null,
          null,
          'not valid json',
          null,
          'h-bad'
        )
      const got = getLatestCheckpoint('w-1')
      expect(got?.hotFiles).toEqual([])
    })
  })
})
