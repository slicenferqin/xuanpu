import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'

vi.mock('../../../src/main/services/logger', () => ({
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

vi.mock('@shared/app-identity', () => ({
  getActiveAppDatabasePath: (home: string) => join(home, '.xuanpu', 'test.db'),
  APP_BUNDLE_ID: 'test',
  APP_CLI_NAME: 'test',
  APP_PRODUCT_NAME: 'test'
}))

vi.mock('../../../src/main/db', async () => {
  const actual = await vi.importActual<typeof import('../../../src/main/db')>(
    '../../../src/main/db'
  )
  return {
    ...actual,
    getDatabase: () => {
      const g = globalThis as unknown as {
        __sinkTestDb?: import('../../../src/main/db/database').DatabaseService
      }
      if (!g.__sinkTestDb) throw new Error('test DB not initialized')
      return g.__sinkTestDb
    }
  }
})

import { DatabaseService } from '../../../src/main/db/database'
import {
  getFieldEventSink,
  resetFieldEventSink
} from '../../../src/main/field/sink'
import {
  setFieldCollectionEnabledCache,
  invalidatePrivacyCache
} from '../../../src/main/field/privacy'
import { buildFieldContextSnapshot } from '../../../src/main/field/context-builder'
import type { FieldEvent } from '../../../src/shared/types/field-event'

let tmpDir: string
let db: DatabaseService

function baseEvent(overrides: Partial<FieldEvent>): FieldEvent {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    timestamp: overrides.timestamp ?? Date.now(),
    worktreeId: overrides.worktreeId ?? 'w-1',
    projectId: overrides.projectId ?? 'p-1',
    sessionId: overrides.sessionId ?? null,
    relatedEventId: overrides.relatedEventId ?? null,
    type: overrides.type ?? 'worktree.switch',
    payload:
      overrides.payload ?? { fromWorktreeId: null, toWorktreeId: 'w-1', trigger: 'user-click' }
  } as FieldEvent
}

async function persist(events: FieldEvent[]): Promise<void> {
  const sink = getFieldEventSink()
  for (const e of events) sink.enqueue(e, JSON.stringify(e.payload))
  await sink.flushNow()
}

function seedWorktree(id: string, overrides: Partial<{
  name: string
  branch_name: string
  context: string | null
}> = {}): void {
  const now = new Date().toISOString()
  const project = db.createProject({
    name: 'proj',
    path: `/tmp/proj-${id}`,
    description: null,
    tags: null
  })
  db.getDbHandle()
    .prepare(
      `INSERT INTO worktrees (id, project_id, name, branch_name, path, status, is_default, branch_renamed,
        session_titles, attachments, pinned, created_at, last_accessed_at, context)
       VALUES (?, ?, ?, ?, ?, 'active', 0, 0, '[]', '[]', 0, ?, ?, ?)`
    )
    .run(
      id,
      project.id,
      overrides.name ?? 'my-feat',
      overrides.branch_name ?? 'feature/auth',
      `/tmp/wt-${id}`,
      now,
      now,
      overrides.context ?? null
    )
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-builder-test-'))
  db = new DatabaseService(join(tmpDir, 'test.db'))
  db.init()
  ;(globalThis as unknown as { __sinkTestDb: DatabaseService }).__sinkTestDb = db
  resetFieldEventSink()
  invalidatePrivacyCache()
  setFieldCollectionEnabledCache(true)
})

afterEach(async () => {
  try {
    await getFieldEventSink().shutdown()
  } catch {
    /* noop */
  }
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
  delete (globalThis as unknown as { __sinkTestDb?: DatabaseService }).__sinkTestDb
})

// ---------------------------------------------------------------------------

describe('FieldContextBuilder — Phase 22A M1', () => {
  describe('privacy gate', () => {
    it('returns null when field collection is disabled', async () => {
      setFieldCollectionEnabledCache(false)
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
      expect(snap).toBeNull()
    })
  })

  describe('worktree metadata', () => {
    it('populates worktree info from the DB', async () => {
      seedWorktree('w-1', { name: 'auth-feat', branch_name: 'feat/auth' })
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
      expect(snap?.worktree).toEqual({
        id: 'w-1',
        name: 'auth-feat',
        branchName: 'feat/auth'
      })
    })

    it('returns worktree=null when worktree does not exist', async () => {
      const snap = await buildFieldContextSnapshot({ worktreeId: 'missing' })
      expect(snap?.worktree).toBeNull()
    })

    it('exposes worktreeNotes from worktree.context', async () => {
      seedWorktree('w-1', { context: 'Rewriting token refresh.' })
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
      expect(snap?.worktreeNotes).toBe('Rewriting token refresh.')
    })

    it('worktreeNotes is null when no context stored', async () => {
      seedWorktree('w-1')
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
      expect(snap?.worktreeNotes).toBeNull()
    })
  })

  describe('sink flush contract', () => {
    it('guarantees read-after-write: enqueue then build sees the event', async () => {
      seedWorktree('w-1')
      const sink = getFieldEventSink()
      const evt = baseEvent({
        id: 'visible',
        type: 'file.open',
        payload: { path: '/a.ts', name: 'a.ts' }
      })
      sink.enqueue(evt, JSON.stringify(evt.payload))
      // NOTE: no explicit flushNow() here — the builder must flush internally.
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
      expect(snap?.focus.file).toEqual({ path: '/a.ts', name: 'a.ts' })
    })
  })

  describe('focus derivation', () => {
    it('latest file.focus / file.open wins for focus.file', async () => {
      seedWorktree('w-1')
      const t = Date.now()
      await persist([
        baseEvent({
          id: '1',
          timestamp: t - 1000,
          type: 'file.open',
          payload: { path: '/a.ts', name: 'a.ts' }
        }),
        baseEvent({
          id: '2',
          timestamp: t - 500,
          type: 'file.focus',
          payload: { path: '/b.ts', name: 'b.ts', fromPath: '/a.ts' }
        })
      ])
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
      expect(snap?.focus.file).toEqual({ path: '/b.ts', name: 'b.ts' })
    })

    it('latest file.selection wins for focus.selection', async () => {
      seedWorktree('w-1')
      const t = Date.now()
      await persist([
        baseEvent({
          id: '1',
          timestamp: t - 1000,
          type: 'file.selection',
          payload: { path: '/a.ts', fromLine: 1, toLine: 5, length: 40 }
        }),
        baseEvent({
          id: '2',
          timestamp: t - 500,
          type: 'file.selection',
          payload: { path: '/a.ts', fromLine: 45, toLine: 58, length: 320 }
        })
      ])
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
      expect(snap?.focus.selection).toEqual({
        path: '/a.ts',
        fromLine: 45,
        toLine: 58,
        length: 320
      })
    })

    it('selection path overrides focused-file path when they differ', async () => {
      seedWorktree('w-1')
      const t = Date.now()
      await persist([
        baseEvent({
          id: 'f',
          timestamp: t - 1000,
          type: 'file.focus',
          payload: { path: '/a.ts', name: 'a.ts', fromPath: null }
        }),
        baseEvent({
          id: 's',
          timestamp: t - 500,
          type: 'file.selection',
          payload: { path: '/b.ts', fromLine: 10, toLine: 12, length: 30 }
        })
      ])
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
      // focus.file should switch to b.ts because selection is a stronger signal
      expect(snap?.focus.file?.path).toBe('/b.ts')
      expect(snap?.focus.selection?.path).toBe('/b.ts')
    })

    it('no selection when only file.open/focus events present', async () => {
      seedWorktree('w-1')
      await persist([
        baseEvent({
          id: '1',
          type: 'file.open',
          payload: { path: '/a.ts', name: 'a.ts' }
        })
      ])
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
      expect(snap?.focus.selection).toBeNull()
    })
  })

  describe('terminal pairing', () => {
    it('pairs the last terminal.command with its correlated terminal.output', async () => {
      seedWorktree('w-1')
      const t = Date.now()
      await persist([
        baseEvent({
          id: 'cmd',
          timestamp: t - 1000,
          type: 'terminal.command',
          payload: { command: 'pnpm test auth' }
        }),
        baseEvent({
          id: 'out',
          timestamp: t - 500,
          type: 'terminal.output',
          relatedEventId: 'cmd',
          payload: {
            commandEventId: 'cmd',
            head: 'FAIL src/auth/login.test.ts',
            tail: 'Tests: 1 failed',
            truncated: false,
            totalBytes: 500,
            exitCode: 1,
            reason: 'exit'
          }
        })
      ])
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
      expect(snap?.lastTerminal?.command).toBe('pnpm test auth')
      expect(snap?.lastTerminal?.output?.head).toContain('FAIL')
      expect(snap?.lastTerminal?.output?.tail).toContain('1 failed')
      expect(snap?.lastTerminal?.output?.exitCode).toBe(1)
    })

    it('terminal.output with relatedEventId null does NOT get paired to unrelated command', async () => {
      seedWorktree('w-1')
      const t = Date.now()
      await persist([
        baseEvent({
          id: 'cmd',
          timestamp: t - 1000,
          type: 'terminal.command',
          payload: { command: 'ls' }
        }),
        baseEvent({
          id: 'orphan-out',
          timestamp: t - 500,
          type: 'terminal.output',
          relatedEventId: null, // no correlation
          payload: {
            commandEventId: null,
            head: 'random',
            tail: '',
            truncated: false,
            totalBytes: 6,
            exitCode: null,
            reason: 'destroy'
          }
        })
      ])
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
      expect(snap?.lastTerminal?.command).toBe('ls')
      expect(snap?.lastTerminal?.output).toBeNull()
    })

    it('returns lastTerminal=null when no terminal.command in window', async () => {
      seedWorktree('w-1')
      await persist([
        baseEvent({
          id: '1',
          type: 'file.open',
          payload: { path: '/a.ts', name: 'a.ts' }
        })
      ])
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
      expect(snap?.lastTerminal).toBeNull()
    })

    it('picks the most recent terminal.command when multiple exist', async () => {
      seedWorktree('w-1')
      const t = Date.now()
      await persist([
        baseEvent({
          id: 'c1',
          timestamp: t - 2000,
          type: 'terminal.command',
          payload: { command: 'ls' }
        }),
        baseEvent({
          id: 'c2',
          timestamp: t - 1000,
          type: 'terminal.command',
          payload: { command: 'pwd' }
        })
      ])
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
      expect(snap?.lastTerminal?.command).toBe('pwd')
    })
  })

  describe('recentActivity dedup', () => {
    it('excludes events that got promoted into focus / lastTerminal sections', async () => {
      seedWorktree('w-1')
      const t = Date.now()
      await persist([
        baseEvent({
          id: 'sw',
          timestamp: t - 2000,
          type: 'worktree.switch',
          payload: { fromWorktreeId: 'w-0', toWorktreeId: 'w-1', trigger: 'user-click' }
        }),
        baseEvent({
          id: 'open',
          timestamp: t - 1500,
          type: 'file.open',
          payload: { path: '/a.ts', name: 'a.ts' }
        }),
        baseEvent({
          id: 'sel',
          timestamp: t - 1000,
          type: 'file.selection',
          payload: { path: '/a.ts', fromLine: 10, toLine: 20, length: 50 }
        }),
        baseEvent({
          id: 'cmd',
          timestamp: t - 500,
          type: 'terminal.command',
          payload: { command: 'pnpm test' }
        }),
        baseEvent({
          id: 'out',
          timestamp: t - 300,
          type: 'terminal.output',
          relatedEventId: 'cmd',
          payload: {
            commandEventId: 'cmd',
            head: '',
            tail: '',
            truncated: false,
            totalBytes: 0,
            exitCode: 0,
            reason: 'exit'
          }
        })
      ])
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
      const ids = snap?.recentActivity.map((a) => {
        // Activity entries don't carry ids directly — use summary-type matching
        return a.type
      })
      // The worktree.switch event should still be in recentActivity because it
      // wasn't promoted. The open/sel/cmd/out events should all be excluded.
      expect(ids).toEqual(['worktree.switch'])
    })

    it('respects maxActivity cap', async () => {
      seedWorktree('w-1')
      const t = Date.now()
      const events: FieldEvent[] = []
      for (let i = 0; i < 50; i++) {
        events.push(
          baseEvent({
            id: `sw-${i}`,
            timestamp: t - (50 - i) * 100,
            type: 'worktree.switch',
            payload: {
              fromWorktreeId: `old-${i}`,
              toWorktreeId: 'w-1',
              trigger: 'keyboard'
            }
          })
        )
      }
      await persist(events)
      const snap = await buildFieldContextSnapshot({
        worktreeId: 'w-1',
        maxActivity: 10
      })
      expect(snap?.recentActivity).toHaveLength(10)
      // Most recent 10 (asc => slice last 10)
      const firstFrom = snap?.recentActivity[0].summary
      expect(firstFrom).toMatch(/old-40/)
    })
  })

  describe('episodic summary integration (Phase 22B)', () => {
    it('reads episodic memory from DB into snapshot', async () => {
      seedWorktree('w-1')
      db.upsertEpisodicMemory({
        worktreeId: 'w-1',
        summaryMarkdown: '## Observed Recent Work\n- bucket1\n- bucket2',
        compactorId: 'rule-based',
        version: 1,
        compactedAt: 1_700_000_000_000,
        sourceEventCount: 42,
        sourceSince: 1_699_900_000_000,
        sourceUntil: 1_700_000_000_000
      })
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
      expect(snap?.episodicSummary).toEqual({
        markdown: '## Observed Recent Work\n- bucket1\n- bucket2',
        compactorId: 'rule-based',
        compactedAt: 1_700_000_000_000,
        sourceEventCount: 42
      })
    })

    it('returns null episodicSummary when no entry exists', async () => {
      seedWorktree('w-1')
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
      expect(snap?.episodicSummary).toBeNull()
    })
  })

  describe('worktree isolation', () => {
    it('does not leak events from a different worktree', async () => {
      seedWorktree('w-1')
      seedWorktree('w-2')
      await persist([
        baseEvent({
          id: 'other',
          worktreeId: 'w-2',
          type: 'file.open',
          payload: { path: '/other.ts', name: 'other.ts' }
        })
      ])
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' })
      expect(snap?.focus.file).toBeNull()
      expect(snap?.recentActivity).toEqual([])
    })
  })

  describe('window boundaries', () => {
    it('excludes events older than windowMs', async () => {
      seedWorktree('w-1')
      const t = Date.now()
      await persist([
        baseEvent({
          id: 'ancient',
          timestamp: t - 10 * 60_000, // 10 min ago
          type: 'file.open',
          payload: { path: '/old.ts', name: 'old.ts' }
        }),
        baseEvent({
          id: 'recent',
          timestamp: t - 60_000,
          type: 'file.open',
          payload: { path: '/new.ts', name: 'new.ts' }
        })
      ])
      const snap = await buildFieldContextSnapshot({ worktreeId: 'w-1' }) // default 5 min
      expect(snap?.focus.file?.path).toBe('/new.ts')
    })

    it('asOf/windowMs are populated for downstream consumers', async () => {
      seedWorktree('w-1')
      const before = Date.now()
      const snap = await buildFieldContextSnapshot({
        worktreeId: 'w-1',
        windowMs: 10 * 60_000
      })
      const after = Date.now()
      expect(snap?.asOf).toBeGreaterThanOrEqual(before)
      expect(snap?.asOf).toBeLessThanOrEqual(after)
      expect(snap?.windowMs).toBe(10 * 60_000)
    })
  })
})
