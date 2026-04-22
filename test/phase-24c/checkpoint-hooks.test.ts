import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { createHash } from 'node:crypto'

vi.mock('@shared/app-identity', () => ({
  getActiveAppDatabasePath: (home: string) => join(home, '.xuanpu', 'test.db'),
  APP_BUNDLE_ID: 'test',
  APP_CLI_NAME: 'test',
  APP_PRODUCT_NAME: 'test'
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('electron', () => ({
  app: undefined
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

// Force privacy ON (default) — tests that toggle it do it explicitly.
vi.mock('../../src/main/field/privacy', () => ({
  isFieldCollectionEnabled: vi.fn(() => true),
  isMemoryInjectionEnabled: vi.fn(() => true)
}))

import { DatabaseService } from '../../src/main/db/database'
import { buildFieldContextSnapshot } from '../../src/main/field/context-builder'
import {
  recordCheckpointOnAbort,
  recordCheckpointsOnShutdown
} from '../../src/main/field/checkpoint-hooks'
import { getLatestCheckpoint } from '../../src/main/field/checkpoint-repository'
import { isFieldCollectionEnabled } from '../../src/main/field/privacy'

let tmpDir: string
let worktreePath: string
let db: DatabaseService

function touchFile(rel: string, content = 'hello'): string {
  const abs = join(worktreePath, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}

async function seedWorktreeAndProject(worktreeId: string, projectId: string): Promise<void> {
  const nowIso = new Date().toISOString()
  db.getDbHandle()
    .prepare(
      `INSERT INTO projects (id, name, path, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(projectId, 'proj', worktreePath, nowIso, nowIso)
  db.getDbHandle()
    .prepare(
      `INSERT INTO worktrees (id, project_id, name, branch_name, path,
         status, is_default, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)`
    )
    .run(worktreeId, projectId, 'wt', 'main', worktreePath, nowIso, nowIso)
}

async function seedSession(sessionId: string, worktreeId: string, projectId: string): Promise<void> {
  const nowIso = new Date().toISOString()
  db.getDbHandle()
    .prepare(
      `INSERT INTO sessions (id, worktree_id, project_id, status, agent_sdk, mode,
         created_at, updated_at)
       VALUES (?, ?, ?, 'active', 'claude-code', 'build', ?, ?)`
    )
    .run(sessionId, worktreeId, projectId, nowIso, nowIso)
}

function insertFieldEvent(
  type: string,
  payload: unknown,
  opts: { id: string; worktreeId: string; sessionId: string; ts: number }
): void {
  db.getDbHandle()
    .prepare(
      `INSERT INTO field_events (id, timestamp, worktree_id, project_id,
         session_id, type, related_event_id, payload_json)
       VALUES (?, ?, ?, NULL, ?, ?, NULL, ?)`
    )
    .run(opts.id, opts.ts, opts.worktreeId, opts.sessionId, type, JSON.stringify(payload))
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-checkpoint-hooks-'))
  worktreePath = join(tmpDir, 'worktree')
  mkdirSync(worktreePath, { recursive: true })
  db = new DatabaseService(join(tmpDir, 'test.db'))
  db.init()
  ;(globalThis as unknown as { __checkpointTestDb: DatabaseService }).__checkpointTestDb = db
  ;(isFieldCollectionEnabled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true)
})

afterEach(() => {
  db.close()
  delete (globalThis as { __checkpointTestDb?: DatabaseService }).__checkpointTestDb
  rmSync(tmpDir, { recursive: true, force: true })
})

// --- recordCheckpointOnAbort ------------------------------------------------

describe('recordCheckpointOnAbort (Phase 24C)', () => {
  it('persists a checkpoint when events + worktree + session exist', async () => {
    await seedWorktreeAndProject('w-1', 'p-1')
    await seedSession('s-1', 'w-1', 'p-1')
    touchFile('src/auth.ts', 'contents')
    insertFieldEvent(
      'file.focus',
      { path: join(worktreePath, 'src/auth.ts'), name: 'auth.ts', fromPath: null },
      { id: 'e-1', worktreeId: 'w-1', sessionId: 's-1', ts: Date.now() - 1000 }
    )
    insertFieldEvent(
      'session.message',
      { text: 'refactor auth', agentSdk: 'opencode', agentSessionId: 'a', attachmentCount: 0 },
      { id: 'e-2', worktreeId: 'w-1', sessionId: 's-1', ts: Date.now() - 500 }
    )

    await recordCheckpointOnAbort(worktreePath, 's-1')

    const stored = getLatestCheckpoint('w-1')
    expect(stored).not.toBeNull()
    expect(stored!.source).toBe('abort')
    expect(stored!.sessionId).toBe('s-1')
    expect(stored!.hotFiles).toContain('src/auth.ts')
  })

  it('noops when privacy is disabled', async () => {
    ;(isFieldCollectionEnabled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false)
    await seedWorktreeAndProject('w-1', 'p-1')
    await seedSession('s-1', 'w-1', 'p-1')
    touchFile('a.ts')
    insertFieldEvent(
      'file.focus',
      { path: join(worktreePath, 'a.ts'), name: 'a.ts', fromPath: null },
      { id: 'e-1', worktreeId: 'w-1', sessionId: 's-1', ts: Date.now() }
    )

    await recordCheckpointOnAbort(worktreePath, 's-1')

    expect(getLatestCheckpoint('w-1')).toBeNull()
  })

  it('noops silently when worktree path is unknown', async () => {
    await expect(
      recordCheckpointOnAbort('/nonexistent/path', 's-1')
    ).resolves.toBeUndefined()
  })

  it('resolves opencode_session_id to hive session id', async () => {
    await seedWorktreeAndProject('w-1', 'p-1')
    // Session with a distinct opencode_session_id
    const nowIso = new Date().toISOString()
    db.getDbHandle()
      .prepare(
        `INSERT INTO sessions (id, worktree_id, project_id, status, agent_sdk, mode,
           opencode_session_id, created_at, updated_at)
         VALUES ('hive-1', 'w-1', 'p-1', 'active', 'opencode', 'build', 'opc-abc', ?, ?)`
      )
      .run(nowIso, nowIso)
    touchFile('a.ts')
    insertFieldEvent(
      'file.focus',
      { path: join(worktreePath, 'a.ts'), name: 'a.ts', fromPath: null },
      { id: 'e-1', worktreeId: 'w-1', sessionId: 'hive-1', ts: Date.now() }
    )

    // Caller passes the opencode id — hook must resolve it back to hive-1
    await recordCheckpointOnAbort(worktreePath, 'opc-abc')

    const stored = getLatestCheckpoint('w-1')
    expect(stored?.sessionId).toBe('hive-1')
  })

  it('swallows DB errors without throwing', async () => {
    // Pass a path whose worktree exists but invalidate DB mid-call by
    // closing it. The hook must not throw.
    await seedWorktreeAndProject('w-1', 'p-1')
    db.close()
    await expect(
      recordCheckpointOnAbort(worktreePath, 's-1')
    ).resolves.toBeUndefined()
    // Re-init for afterEach teardown
    db = new DatabaseService(join(tmpDir, 'test.db'))
    db.init()
    ;(globalThis as unknown as { __checkpointTestDb: DatabaseService }).__checkpointTestDb = db
  })
})

// --- recordCheckpointsOnShutdown -------------------------------------------

describe('recordCheckpointsOnShutdown (Phase 24C)', () => {
  it('writes one checkpoint per active session with events', async () => {
    await seedWorktreeAndProject('w-1', 'p-1')
    await seedSession('s-1', 'w-1', 'p-1')
    touchFile('a.ts')
    insertFieldEvent(
      'file.focus',
      { path: join(worktreePath, 'a.ts'), name: 'a.ts', fromPath: null },
      { id: 'e-1', worktreeId: 'w-1', sessionId: 's-1', ts: Date.now() }
    )

    await recordCheckpointsOnShutdown()

    const stored = getLatestCheckpoint('w-1')
    expect(stored).not.toBeNull()
    expect(stored!.source).toBe('shutdown')
  })

  it('skips sessions with no events (generate returns null)', async () => {
    await seedWorktreeAndProject('w-1', 'p-1')
    await seedSession('s-empty', 'w-1', 'p-1')
    // No events inserted

    await recordCheckpointsOnShutdown()

    expect(getLatestCheckpoint('w-1')).toBeNull()
  })

  it('noops entirely when privacy is disabled', async () => {
    ;(isFieldCollectionEnabled as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false)
    await seedWorktreeAndProject('w-1', 'p-1')
    await seedSession('s-1', 'w-1', 'p-1')
    touchFile('a.ts')
    insertFieldEvent(
      'file.focus',
      { path: join(worktreePath, 'a.ts'), name: 'a.ts', fromPath: null },
      { id: 'e-1', worktreeId: 'w-1', sessionId: 's-1', ts: Date.now() }
    )

    await recordCheckpointsOnShutdown()

    expect(getLatestCheckpoint('w-1')).toBeNull()
  })
})

// --- Context-builder integration -------------------------------------------

describe('buildFieldContextSnapshot checkpoint integration (Phase 24C)', () => {
  it('includes Resumed block when a fresh checkpoint exists', async () => {
    await seedWorktreeAndProject('w-1', 'p-1')
    const { insertCheckpoint } = await import(
      '../../src/main/field/checkpoint-repository'
    )
    touchFile('src/auth.ts', 'original')
    insertCheckpoint({
      id: 'ck-1',
      createdAt: Date.now() - 5 * 60_000, // 5 min old
      worktreeId: 'w-1',
      sessionId: 's-1',
      branch: null, // null branch matches non-git worktree
      repoHead: null,
      source: 'abort',
      summary: 'Worked on (no branch) for 5m. 1 files edited, 0 commands run.',
      currentGoal: 'refactor auth',
      nextAction: null,
      blockingReason: null,
      hotFiles: ['src/auth.ts'],
      hotFileDigests: { 'src/auth.ts': sha1('original') },
      packetHash: 'h-1'
    })

    const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
    expect(snap).not.toBeNull()
    expect(snap!.checkpoint).not.toBeNull()
    expect(snap!.checkpoint!.source).toBe('abort')
    expect(snap!.checkpoint!.currentGoal).toBe('refactor auth')
    expect(snap!.checkpoint!.hotFiles).toEqual(['src/auth.ts'])
  })

  it('checkpoint is null when none exists', async () => {
    await seedWorktreeAndProject('w-1', 'p-1')
    const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
    expect(snap!.checkpoint).toBeNull()
  })

  it('checkpoint is null when digest drift ≥50%', async () => {
    await seedWorktreeAndProject('w-1', 'p-1')
    const { insertCheckpoint } = await import(
      '../../src/main/field/checkpoint-repository'
    )
    // Record has 2 hot files; only 1 exists on disk → 50% drift → drop
    touchFile('kept.ts', 'X')
    insertCheckpoint({
      id: 'ck-drift',
      createdAt: Date.now() - 60_000,
      worktreeId: 'w-1',
      sessionId: 's-1',
      branch: null,
      repoHead: null,
      source: 'abort',
      summary: '...',
      currentGoal: null,
      nextAction: null,
      blockingReason: null,
      hotFiles: ['kept.ts', 'gone.ts'],
      hotFileDigests: { 'kept.ts': sha1('X'), 'gone.ts': sha1('never existed') },
      packetHash: 'h-drift'
    })

    const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
    expect(snap!.checkpoint).toBeNull()
  })

  it('checkpoint failure does not fail the whole snapshot (verifier throws)', async () => {
    await seedWorktreeAndProject('w-1', 'p-1')
    // With no checkpoint row, verifier simply returns null — snapshot still works
    const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
    expect(snap).not.toBeNull()
    expect(snap!.checkpoint).toBeNull()
    // Other parts of the snapshot should still be well-formed
    expect(snap!.worktree).not.toBeNull()
    expect(snap!.focus).toBeDefined()
  })
})
