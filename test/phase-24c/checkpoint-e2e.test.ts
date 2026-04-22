/**
 * Phase 24C end-to-end test: simulates the full lifecycle —
 *   1. user does work in a session (events emitted to field_events)
 *   2. session aborts → recordCheckpointOnAbort persists
 *   3. new session starts → buildFieldContextSnapshot reads back the resume block
 *   4. formatter renders it as markdown
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'

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

vi.mock('electron', () => ({ app: undefined }))

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

vi.mock('../../src/main/field/privacy', () => ({
  isFieldCollectionEnabled: vi.fn(() => true),
  isMemoryInjectionEnabled: vi.fn(() => true)
}))

import { DatabaseService } from '../../src/main/db/database'
import { recordCheckpointOnAbort } from '../../src/main/field/checkpoint-hooks'
import { buildFieldContextSnapshot } from '../../src/main/field/context-builder'
import { formatFieldContext } from '../../src/main/field/context-formatter'

let tmpDir: string
let worktreePath: string
let db: DatabaseService

function touch(rel: string, content = 'hello'): void {
  const abs = join(worktreePath, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

async function seedAll(): Promise<void> {
  const nowIso = new Date().toISOString()
  db.getDbHandle()
    .prepare(
      `INSERT INTO projects (id, name, path, created_at, last_accessed_at)
       VALUES ('p-1', 'p', ?, ?, ?)`
    )
    .run(worktreePath, nowIso, nowIso)
  db.getDbHandle()
    .prepare(
      `INSERT INTO worktrees (id, project_id, name, branch_name, path, status,
         is_default, created_at, last_accessed_at)
       VALUES ('w-1', 'p-1', 'wt', 'main', ?, 'active', 0, ?, ?)`
    )
    .run(worktreePath, nowIso, nowIso)
  db.getDbHandle()
    .prepare(
      `INSERT INTO sessions (id, worktree_id, project_id, status, agent_sdk, mode,
         created_at, updated_at)
       VALUES ('s-1', 'w-1', 'p-1', 'active', 'claude-code', 'build', ?, ?)`
    )
    .run(nowIso, nowIso)
}

function emitEvent(
  type: string,
  payload: unknown,
  ts = Date.now(),
  id = `e-${Math.random().toString(36).slice(2, 10)}`
): void {
  db.getDbHandle()
    .prepare(
      `INSERT INTO field_events (id, timestamp, worktree_id, project_id,
         session_id, type, related_event_id, payload_json)
       VALUES (?, ?, 'w-1', 'p-1', 's-1', ?, NULL, ?)`
    )
    .run(id, ts, type, JSON.stringify(payload))
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-checkpoint-e2e-'))
  worktreePath = join(tmpDir, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  db = new DatabaseService(join(tmpDir, 't.db'))
  db.init()
  ;(globalThis as unknown as { __checkpointTestDb: DatabaseService }).__checkpointTestDb = db
})

afterEach(() => {
  db.close()
  delete (globalThis as { __checkpointTestDb?: DatabaseService }).__checkpointTestDb
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('Phase 24C end-to-end (work → abort → resume → render)', () => {
  it('full lifecycle: events → abort → checkpoint → snapshot → markdown', async () => {
    await seedAll()
    touch('src/auth/refresh.ts', 'original content')
    const t0 = Date.now() - 60_000
    emitEvent(
      'file.focus',
      { path: join(worktreePath, 'src/auth/refresh.ts'), name: 'refresh.ts', fromPath: null },
      t0
    )
    emitEvent(
      'file.selection',
      { path: join(worktreePath, 'src/auth/refresh.ts'), fromLine: 10, toLine: 20, length: 200 },
      t0 + 5_000
    )
    emitEvent(
      'session.message',
      {
        text: 'make refresh retry on 401\nTODO: add backoff in refresh.ts',
        agentSdk: 'claude-code',
        agentSessionId: 's-1',
        attachmentCount: 0
      },
      t0 + 10_000
    )
    emitEvent(
      'terminal.command',
      { command: 'pnpm test src/auth/refresh.test.ts', cwd: worktreePath },
      t0 + 30_000
    )

    // Step 2: user aborts
    await recordCheckpointOnAbort(worktreePath, 's-1')

    // Step 3: snapshot for next session (fresh)
    const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
    expect(snap).not.toBeNull()
    expect(snap!.checkpoint).not.toBeNull()
    expect(snap!.checkpoint!.source).toBe('abort')
    expect(snap!.checkpoint!.currentGoal).toBe('make refresh retry on 401')
    expect(snap!.checkpoint!.nextAction).toContain('TODO')
    expect(snap!.checkpoint!.hotFiles).toContain('src/auth/refresh.ts')

    // Step 4: format → markdown
    const { markdown } = formatFieldContext(snap!)
    expect(markdown).toContain('## Resumed from previous session')
    expect(markdown).toContain('**Current goal** (heuristic): make refresh retry on 401')
    expect(markdown).toContain('TODO')
    expect(markdown).toContain('src/auth/refresh.ts')
    // Resumed block must come before any semantic-memory or summary blocks
    const resumedIdx = markdown.indexOf('Resumed from previous session')
    expect(resumedIdx).toBeGreaterThan(-1)
  })

  it('hot file modified after checkpoint → still injected if drift below 50%', async () => {
    await seedAll()
    touch('src/a.ts', 'A')
    touch('src/b.ts', 'B')
    touch('src/c.ts', 'C')
    const t0 = Date.now() - 60_000
    emitEvent('file.focus', { path: join(worktreePath, 'src/a.ts'), name: 'a.ts', fromPath: null }, t0)
    emitEvent('file.focus', { path: join(worktreePath, 'src/b.ts'), name: 'b.ts', fromPath: null }, t0 + 1)
    emitEvent('file.focus', { path: join(worktreePath, 'src/c.ts'), name: 'c.ts', fromPath: null }, t0 + 2)

    await recordCheckpointOnAbort(worktreePath, 's-1')

    // Modify ONE of three hot files after the checkpoint
    touch('src/a.ts', 'MODIFIED')

    const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
    // 1/3 = 0.33 < 0.5 → still injected, with warning
    expect(snap!.checkpoint).not.toBeNull()
    expect(snap!.checkpoint!.warnings.some((w) => /1\/3 hot files changed/.test(w))).toBe(true)
  })

  it('hot files all modified → checkpoint dropped (no resume block)', async () => {
    await seedAll()
    touch('src/a.ts', 'A')
    touch('src/b.ts', 'B')
    const t0 = Date.now() - 60_000
    emitEvent('file.focus', { path: join(worktreePath, 'src/a.ts'), name: 'a.ts', fromPath: null }, t0)
    emitEvent('file.focus', { path: join(worktreePath, 'src/b.ts'), name: 'b.ts', fromPath: null }, t0 + 1)

    await recordCheckpointOnAbort(worktreePath, 's-1')

    // Modify both → 100% drift
    touch('src/a.ts', 'X')
    touch('src/b.ts', 'Y')

    const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
    expect(snap!.checkpoint).toBeNull()
    const { markdown } = formatFieldContext(snap!)
    expect(markdown).not.toContain('Resumed from previous session')
  })

  it('repeated abort within the same minute is idempotent (no duplicate row)', async () => {
    await seedAll()
    touch('src/a.ts')
    emitEvent('file.focus', { path: join(worktreePath, 'src/a.ts'), name: 'a.ts', fromPath: null })

    await recordCheckpointOnAbort(worktreePath, 's-1')
    await recordCheckpointOnAbort(worktreePath, 's-1')

    const count = (db
      .getDbHandle()
      .prepare(`SELECT COUNT(*) AS c FROM field_session_checkpoints WHERE worktree_id = 'w-1'`)
      .get() as { c: number }).c
    expect(count).toBe(1)
  })

  it('aborting a session with NO events writes nothing (generator returns null)', async () => {
    await seedAll()
    // No events emitted
    await recordCheckpointOnAbort(worktreePath, 's-1')

    const count = (db
      .getDbHandle()
      .prepare(`SELECT COUNT(*) AS c FROM field_session_checkpoints WHERE worktree_id = 'w-1'`)
      .get() as { c: number }).c
    expect(count).toBe(0)
  })
})
