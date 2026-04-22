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

import { DatabaseService } from '../../src/main/db/database'

let tmpDir: string
let db: DatabaseService

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-checkpoint-schema-'))
  db = new DatabaseService(join(tmpDir, 'test.db'))
  db.init()
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('field_session_checkpoints schema (Phase 24C v19)', () => {
  it('migration v19 creates the table with expected columns', () => {
    const cols = db
      .getDbHandle()
      .pragma('table_info(field_session_checkpoints)') as Array<{ name: string }>
    const names = cols.map((c) => c.name).sort()
    expect(names).toEqual(
      [
        'blocking_reason',
        'branch',
        'created_at',
        'current_goal',
        'hot_file_digests_json',
        'hot_files_json',
        'id',
        'next_action',
        'packet_hash',
        'repo_head',
        'session_id',
        'source',
        'summary',
        'worktree_id'
      ].sort()
    )
  })

  it('id is the PRIMARY KEY', () => {
    const cols = db
      .getDbHandle()
      .pragma('table_info(field_session_checkpoints)') as Array<{ name: string; pk: number }>
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['id'])
  })

  it('(worktree_id, packet_hash) is a UNIQUE index', () => {
    const indexes = db
      .getDbHandle()
      .pragma('index_list(field_session_checkpoints)') as Array<{ name: string; unique: number }>
    const unique = indexes.find((i) => i.name === 'idx_field_session_checkpoints_worktree_hash')
    expect(unique).toBeDefined()
    expect(unique!.unique).toBe(1)

    const cols = db
      .getDbHandle()
      .pragma(`index_info('idx_field_session_checkpoints_worktree_hash')`) as Array<{
      name: string
    }>
    expect(cols.map((c) => c.name).sort()).toEqual(['packet_hash', 'worktree_id'])
  })

  it('idx_field_session_checkpoints_worktree_created exists', () => {
    const indexes = (db
      .getDbHandle()
      .pragma('index_list(field_session_checkpoints)') as Array<{ name: string }>).map(
      (i) => i.name
    )
    expect(indexes).toContain('idx_field_session_checkpoints_worktree_created')
  })

  it('source column has CHECK constraint restricting to abort/shutdown', () => {
    expect(() =>
      db
        .getDbHandle()
        .prepare(
          `INSERT INTO field_session_checkpoints (
             id, created_at, worktree_id, session_id, branch, repo_head,
             source, summary, current_goal, next_action, blocking_reason,
             hot_files_json, hot_file_digests_json, packet_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          'ck-bad',
          Date.now(),
          'w-1',
          's-1',
          null,
          null,
          'session_end', // invalid
          'summary',
          null,
          null,
          null,
          '[]',
          null,
          'h-1'
        )
    ).toThrow(/CHECK constraint/i)
  })

  it('does NOT have status or stale_reason columns (verifier is read-only)', () => {
    const cols = (db
      .getDbHandle()
      .pragma('table_info(field_session_checkpoints)') as Array<{ name: string }>).map(
      (c) => c.name
    )
    expect(cols).not.toContain('status')
    expect(cols).not.toContain('stale_reason')
  })

  it('schema version is 19', () => {
    expect(db.getSchemaVersion()).toBe(19)
  })
})
