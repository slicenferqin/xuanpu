/**
 * Phase 21.5 — context-builder deriveFocus integration test.
 *
 * Verifies that the Field Context's `## Current Focus` section correctly
 * falls back to agent.file_write/agent.file_read when no human focus
 * events exist (the full-delegation user case).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'

vi.mock('@shared/app-identity', () => ({
  getActiveAppDatabasePath: (home: string) => join(home, '.xuanpu', 'test.db'),
  APP_BUNDLE_ID: 'test',
  APP_CLI_NAME: 'test',
  APP_PRODUCT_NAME: 'test'
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
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
import { buildFieldContextSnapshot } from '../../src/main/field/context-builder'

let tmpDir: string
let worktreePath: string
let db: DatabaseService

async function seedWorktree(): Promise<void> {
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
}

function emitEvent(
  type: string,
  payload: unknown,
  ts: number,
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
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-phase21-5-focus-'))
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

describe('deriveFocus — agent fallback (Phase 21.5)', () => {
  it('full-delegation: only agent.file_write → focus.file populated', async () => {
    await seedWorktree()
    const now = Date.now() - 30_000 // within window
    emitEvent(
      'agent.file_write',
      { toolUseId: 'tu-1', toolName: 'Edit', path: 'src/auth.ts', operation: 'edit' },
      now
    )
    const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
    expect(snap!.focus.file).not.toBeNull()
    expect(snap!.focus.file!.path).toBe('src/auth.ts')
    expect(snap!.focus.file!.name).toBe('auth.ts')
  })

  it('agent.file_write outranks agent.file_read in fallback chain', async () => {
    await seedWorktree()
    const now = Date.now() - 30_000
    emitEvent(
      'agent.file_read',
      { toolUseId: 'tu-1', toolName: 'Read', path: 'reading.ts', bytes: 100 },
      now
    )
    emitEvent(
      'agent.file_write',
      { toolUseId: 'tu-2', toolName: 'Edit', path: 'writing.ts', operation: 'edit' },
      now + 1000
    )
    const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
    // Both write and read exist → write wins
    expect(snap!.focus.file!.path).toBe('writing.ts')
  })

  it('agent.file_read alone → fallback used', async () => {
    await seedWorktree()
    const now = Date.now() - 30_000
    emitEvent(
      'agent.file_read',
      { toolUseId: 'tu-1', toolName: 'Read', path: 'src/lib.ts', bytes: 200 },
      now
    )
    const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
    expect(snap!.focus.file!.path).toBe('src/lib.ts')
  })

  it('human file.focus wins over agent events (no fallback when human signal exists)', async () => {
    await seedWorktree()
    const now = Date.now() - 30_000
    emitEvent(
      'agent.file_write',
      { toolUseId: 'tu-1', toolName: 'Edit', path: 'agent-edited.ts', operation: 'edit' },
      now
    )
    emitEvent(
      'file.focus',
      { path: '/abs/human-focused.ts', name: 'human-focused.ts', fromPath: null },
      now + 5000
    )
    const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
    // Human signal exists → fallback skipped, human path used
    expect(snap!.focus.file!.path).toBe('/abs/human-focused.ts')
  })

  it('agent.file_search does NOT populate focus (search is not focus)', async () => {
    await seedWorktree()
    const now = Date.now() - 30_000
    emitEvent(
      'agent.file_search',
      { toolUseId: 'tu-1', toolName: 'Glob', pattern: '**/*.ts', matchCount: 50 },
      now
    )
    const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
    expect(snap!.focus.file).toBeNull()
  })

  it('agent.bash_exec does NOT populate focus', async () => {
    await seedWorktree()
    const now = Date.now() - 30_000
    emitEvent(
      'agent.bash_exec',
      {
        toolUseId: 'tu-1',
        toolName: 'Bash',
        command: 'pnpm test',
        exitCode: 0,
        durationMs: 100,
        stdoutHead: null,
        stderrTail: null
      },
      now
    )
    const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
    expect(snap!.focus.file).toBeNull()
  })

  it('latest agent.file_write wins (last-event semantics)', async () => {
    await seedWorktree()
    const now = Date.now() - 30_000
    emitEvent(
      'agent.file_write',
      { toolUseId: 'tu-1', toolName: 'Edit', path: 'first.ts', operation: 'edit' },
      now
    )
    emitEvent(
      'agent.file_write',
      { toolUseId: 'tu-2', toolName: 'Edit', path: 'second.ts', operation: 'edit' },
      now + 1000
    )
    emitEvent(
      'agent.file_write',
      { toolUseId: 'tu-3', toolName: 'Edit', path: 'third.ts', operation: 'edit' },
      now + 2000
    )
    const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
    expect(snap!.focus.file!.path).toBe('third.ts')
  })
})
