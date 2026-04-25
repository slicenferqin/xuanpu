/**
 * Phase 21.5 downstream consumer integration tests — ensure agent.* events
 * correctly flow through rankHotFiles + deriveFocus + editCount.
 *
 * These cover the "full-delegation user" case where only agent events
 * exist (no file.focus / file.selection), which was previously broken.
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
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
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

import type { StoredFieldEvent } from '../../src/main/field/repository'
import {
  rankHotFiles,
  generateCheckpoint,
  type GitProbe
} from '../../src/main/field/checkpoint-generator'
import { DatabaseService } from '../../src/main/db/database'

let tmpDir: string
let worktreePath: string
let db: DatabaseService
let seqCounter = 0

const mkEvent = (
  payload: unknown,
  type: StoredFieldEvent['type'],
  ts = Date.now(),
  id?: string
): StoredFieldEvent => ({
  id: id ?? `e-${++seqCounter}`,
  seq: seqCounter,
  timestamp: ts,
  worktreeId: 'w-1',
  projectId: null,
  sessionId: 's-1',
  relatedEventId: null,
  type,
  payload
})

function touchFile(rel: string, content = 'x'): void {
  const abs = join(worktreePath, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-phase21-5-consumers-'))
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

// ─── rankHotFiles with agent events ────────────────────────────────────────

describe('rankHotFiles — agent event scoring (Phase 21.5)', () => {
  it('agent.file_write scores 3 points (strongest signal)', () => {
    touchFile('src/a.ts')
    touchFile('src/b.ts')
    const events = [
      mkEvent({ toolUseId: 'tu-1', toolName: 'Edit', path: 'src/a.ts', operation: 'edit' }, 'agent.file_write'),
      mkEvent({ path: join(worktreePath, 'src/b.ts'), name: 'b.ts', fromPath: null }, 'file.focus')
    ]
    const hot = rankHotFiles(events, worktreePath)
    // a.ts (write=3) should rank higher than b.ts (focus=1)
    expect(hot[0]).toBe('src/a.ts')
    expect(hot[1]).toBe('src/b.ts')
  })

  it('agent.file_read scores 1 point (weakest signal)', () => {
    touchFile('a.ts')
    touchFile('b.ts')
    const events = [
      mkEvent({ toolUseId: 'tu-1', toolName: 'Read', path: 'a.ts', bytes: 100 }, 'agent.file_read'),
      mkEvent({ toolUseId: 'tu-2', toolName: 'Read', path: 'a.ts', bytes: 200 }, 'agent.file_read'),
      mkEvent(
        { path: join(worktreePath, 'b.ts'), fromLine: 1, toLine: 5, length: 50 },
        'file.selection'
      )
    ]
    // a.ts: read+read = 2; b.ts: selection = 2 — tie, both included
    const hot = rankHotFiles(events, worktreePath)
    expect(hot.sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('agent.file_search (glob pattern) does NOT contribute to hot_files', () => {
    touchFile('a.ts')
    const events = [
      mkEvent(
        { toolUseId: 'tu-1', toolName: 'Glob', pattern: '**/*.ts', matchCount: 50 },
        'agent.file_search'
      ),
      mkEvent({ toolUseId: 'tu-2', toolName: 'Read', path: 'a.ts', bytes: 100 }, 'agent.file_read')
    ]
    const hot = rankHotFiles(events, worktreePath)
    // Only a.ts (from file_read); glob pattern was NOT stat()ed or added.
    expect(hot).toEqual(['a.ts'])
  })

  it('agent.bash_exec does NOT contribute to hot_files', () => {
    touchFile('a.ts')
    const events = [
      mkEvent(
        {
          toolUseId: 'tu-1',
          toolName: 'Bash',
          command: 'pnpm test',
          exitCode: 0,
          durationMs: 1234,
          stdoutHead: null,
          stderrTail: null
        },
        'agent.bash_exec'
      ),
      mkEvent({ toolUseId: 'tu-2', toolName: 'Read', path: 'a.ts', bytes: 100 }, 'agent.file_read')
    ]
    expect(rankHotFiles(events, worktreePath)).toEqual(['a.ts'])
  })

  it('full-delegation user (no human events) still populates hot_files', () => {
    touchFile('src/auth/refresh.ts')
    touchFile('src/auth/index.ts')
    touchFile('test/auth.test.ts')
    const events = [
      mkEvent(
        { toolUseId: 'tu-1', toolName: 'Read', path: 'src/auth/refresh.ts', bytes: 500 },
        'agent.file_read'
      ),
      mkEvent(
        {
          toolUseId: 'tu-2',
          toolName: 'Edit',
          path: 'src/auth/refresh.ts',
          operation: 'edit'
        },
        'agent.file_write'
      ),
      mkEvent(
        { toolUseId: 'tu-3', toolName: 'Read', path: 'src/auth/index.ts', bytes: 300 },
        'agent.file_read'
      ),
      mkEvent(
        { toolUseId: 'tu-4', toolName: 'Edit', path: 'test/auth.test.ts', operation: 'edit' },
        'agent.file_write'
      )
    ]
    const hot = rankHotFiles(events, worktreePath)
    // refresh.ts: read+write = 4; test/auth.test.ts: write = 3; index.ts: read = 1
    expect(hot[0]).toBe('src/auth/refresh.ts')
    expect(hot.slice(1).sort()).toEqual(['src/auth/index.ts', 'test/auth.test.ts'])
  })

  it('filters out agent.file_write paths whose file does not exist', () => {
    touchFile('exists.ts')
    const events = [
      mkEvent(
        { toolUseId: 'tu-1', toolName: 'Edit', path: 'exists.ts', operation: 'edit' },
        'agent.file_write'
      ),
      mkEvent(
        { toolUseId: 'tu-2', toolName: 'Edit', path: 'gone.ts', operation: 'edit' },
        'agent.file_write'
      )
    ]
    expect(rankHotFiles(events, worktreePath)).toEqual(['exists.ts'])
  })
})

// ─── generateCheckpoint editCount / commandCount (Phase 21.5) ──────────────

describe('generateCheckpoint stats — agent event counting (Phase 21.5)', () => {
  const mockGit: GitProbe = {
    revParseHead: async () => null,
    abbrevRefHead: async () => null
  }

  function insertEvents(rows: StoredFieldEvent[]): void {
    const stmt = db.getDbHandle().prepare(
      `INSERT INTO field_events (id, timestamp, worktree_id, project_id,
         session_id, type, related_event_id, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const r of rows) {
      stmt.run(
        r.id,
        r.timestamp,
        r.worktreeId,
        r.projectId,
        r.sessionId,
        r.type,
        r.relatedEventId,
        JSON.stringify(r.payload)
      )
    }
  }

  it('editCount includes distinct agent-touched files', async () => {
    touchFile('a.ts')
    touchFile('b.ts')
    const now = 10 * 60_000 // 10 min
    insertEvents([
      mkEvent(
        { toolUseId: 'tu-1', toolName: 'Edit', path: 'a.ts', operation: 'edit' },
        'agent.file_write',
        now - 5_000
      ),
      mkEvent(
        { toolUseId: 'tu-2', toolName: 'Read', path: 'b.ts', bytes: 100 },
        'agent.file_read',
        now - 4_000
      )
    ])

    const rec = await generateCheckpoint(
      { worktreeId: 'w-1', worktreePath, sessionId: 's-1', source: 'abort', now: () => now },
      mockGit
    )
    expect(rec!.summary).toContain('2 files edited')
  })

  it('commandCount includes agent.bash_exec', async () => {
    touchFile('a.ts')
    const now = 10 * 60_000
    insertEvents([
      mkEvent(
        { toolUseId: 'tu-1', toolName: 'Read', path: 'a.ts', bytes: 10 },
        'agent.file_read',
        now - 5_000
      ),
      mkEvent(
        {
          toolUseId: 'tu-2',
          toolName: 'Bash',
          command: 'pnpm test',
          exitCode: 0,
          durationMs: 100,
          stdoutHead: null,
          stderrTail: null
        },
        'agent.bash_exec',
        now - 3_000
      ),
      mkEvent(
        {
          toolUseId: 'tu-3',
          toolName: 'Bash',
          command: 'pnpm build',
          exitCode: 0,
          durationMs: 200,
          stdoutHead: null,
          stderrTail: null
        },
        'agent.bash_exec',
        now - 2_000
      )
    ])

    const rec = await generateCheckpoint(
      { worktreeId: 'w-1', worktreePath, sessionId: 's-1', source: 'abort', now: () => now },
      mockGit
    )
    expect(rec!.summary).toContain('2 commands run')
  })

  it('full-delegation: only agent events → checkpoint still populated', async () => {
    touchFile('src/auth.ts')
    const now = 10 * 60_000
    insertEvents([
      mkEvent(
        { toolUseId: 'tu-1', toolName: 'Read', path: 'src/auth.ts', bytes: 500 },
        'agent.file_read',
        now - 5_000
      ),
      mkEvent(
        {
          toolUseId: 'tu-2',
          toolName: 'Edit',
          path: 'src/auth.ts',
          operation: 'edit'
        },
        'agent.file_write',
        now - 3_000
      ),
      mkEvent(
        {
          text: 'refactor auth module\nTODO: add retry',
          agentSdk: 'claude-code',
          agentSessionId: 's-1',
          attachmentCount: 0
        },
        'session.message',
        now - 1_000
      )
    ])

    const rec = await generateCheckpoint(
      { worktreeId: 'w-1', worktreePath, sessionId: 's-1', source: 'abort', now: () => now },
      mockGit
    )
    expect(rec).not.toBeNull()
    expect(rec!.hotFiles).toContain('src/auth.ts')
    expect(rec!.hotFileDigests!['src/auth.ts']).toMatch(/^[a-f0-9]{40}$/)
    expect(rec!.currentGoal).toBe('refactor auth module')
    expect(rec!.nextAction).toContain('TODO')
  })
})
