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

vi.mock('electron', () => ({ app: undefined }))

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
import { resetEventBus, getEventBus } from '../../../src/server/event-bus'
import { emitFieldEvent } from '../../../src/main/field/emit'
import {
  EpisodicMemoryUpdater,
  __UPDATER_TUNABLES_FOR_TEST
} from '../../../src/main/field/episodic-updater'
import {
  RuleBasedCompactor,
  type EpisodicCompactor,
  type CompactionInput,
  type CompactionOutput,
  InsufficientEventsError
} from '../../../src/main/field/episodic-compactor'

let tmpDir: string
let db: DatabaseService

function seedWorktree(id: string): void {
  const now = new Date().toISOString()
  const project = db.createProject({
    name: `proj-${id}`,
    path: `/tmp/proj-${id}`,
    description: null,
    tags: null
  })
  db.getDbHandle()
    .prepare(
      `INSERT INTO worktrees (id, project_id, name, branch_name, path, status, is_default, branch_renamed,
        session_titles, attachments, pinned, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, 'active', 0, 0, '[]', '[]', 0, ?, ?)`
    )
    .run(id, project.id, `wt-${id}`, `feature/${id}`, `/tmp/wt-${id}`, now, now)
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-episodic-updater-'))
  db = new DatabaseService(join(tmpDir, 'test.db'))
  db.init()
  ;(globalThis as unknown as { __sinkTestDb: DatabaseService }).__sinkTestDb = db
  resetFieldEventSink()
  resetEventBus()
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

// Helper compactor that produces a known-valid output for tests that don't
// care about content quality.
function makeFixedCompactor(id = 'rule-based', version = 1): EpisodicCompactor {
  return {
    id,
    version,
    async compact(): Promise<CompactionOutput> {
      return {
        markdown: '## Observed Recent Work\n- bucket\n\n## Most-Touched Files\n- `a.ts` (1 event) — /a.ts',
        compactorId: id,
        version
      }
    }
  }
}

describe('EpisodicMemoryUpdater — Phase 22B.1 M3', () => {
  describe('forceCompact (synchronous test entry point)', () => {
    it('writes a summary when there are enough events', async () => {
      seedWorktree('w-1')
      const t = Date.now()
      // Persist 30 events for w-1
      const sink = getFieldEventSink()
      for (let i = 0; i < 30; i++) {
        const evt = {
          id: `e-${i}`,
          timestamp: t - (30 - i) * 1000,
          worktreeId: 'w-1',
          projectId: 'p-1',
          sessionId: null,
          relatedEventId: null,
          type: 'file.focus' as const,
          payload: { path: '/a.ts', name: 'a.ts', fromPath: null }
        }
        sink.enqueue(evt as never, JSON.stringify(evt.payload))
      }
      await sink.flushNow()

      const updater = new EpisodicMemoryUpdater(new RuleBasedCompactor())
      const out = await updater.forceCompact('w-1')
      expect(out).not.toBeNull()
      expect(out?.compactorId).toBe('rule-based')

      const stored = db.getEpisodicMemory('w-1')
      expect(stored?.summaryMarkdown).toContain('## Observed Recent Work')
      expect(stored?.compactorId).toBe('rule-based')
      expect(updater.getCounters().compactions_written).toBe(1)
      await updater.shutdown()
    })

    it('returns null and skips when worktree is unknown', async () => {
      const updater = new EpisodicMemoryUpdater(new RuleBasedCompactor())
      expect(await updater.forceCompact('ghost')).toBeNull()
      await updater.shutdown()
    })

    it('returns null when privacy is disabled', async () => {
      seedWorktree('w-1')
      setFieldCollectionEnabledCache(false)
      const updater = new EpisodicMemoryUpdater(new RuleBasedCompactor())
      expect(await updater.forceCompact('w-1')).toBeNull()
      expect(updater.getCounters().compactions_skipped_privacy).toBe(1)
      await updater.shutdown()
    })

    it('skips and counts on InsufficientEventsError (events < 5)', async () => {
      seedWorktree('w-1')
      const updater = new EpisodicMemoryUpdater(new RuleBasedCompactor())
      expect(await updater.forceCompact('w-1')).toBeNull()
      expect(updater.getCounters().compactions_skipped_insufficient).toBe(1)
      await updater.shutdown()
    })

    it('counts compactor exceptions as failures (NOT InsufficientEvents)', async () => {
      seedWorktree('w-1')
      const t = Date.now()
      const sink = getFieldEventSink()
      for (let i = 0; i < 10; i++) {
        const evt = {
          id: `e-${i}`,
          timestamp: t - i * 1000,
          worktreeId: 'w-1',
          projectId: 'p-1',
          sessionId: null,
          relatedEventId: null,
          type: 'file.focus' as const,
          payload: { path: '/a.ts', name: 'a.ts', fromPath: null }
        }
        sink.enqueue(evt as never, JSON.stringify(evt.payload))
      }
      await sink.flushNow()

      const flaky: EpisodicCompactor = {
        id: 'rule-based',
        version: 1,
        async compact(): Promise<CompactionOutput> {
          throw new Error('boom')
        }
      }
      const updater = new EpisodicMemoryUpdater(flaky)
      await updater.forceCompact('w-1')
      expect(updater.getCounters().compactions_failed).toBe(1)
      // Existing summary should NOT be written
      expect(db.getEpisodicMemory('w-1')).toBeNull()
      await updater.shutdown()
    })
  })

  describe('don\'t-downgrade policy', () => {
    it('skips when an existing higher-priority summary is present', async () => {
      seedWorktree('w-1')
      // Seed with a fake "claude-haiku" summary
      db.upsertEpisodicMemory({
        worktreeId: 'w-1',
        summaryMarkdown: '## Pretend Haiku output',
        compactorId: 'claude-haiku',
        version: 1,
        compactedAt: Date.now() - 60_000,
        sourceEventCount: 10,
        sourceSince: 0,
        sourceUntil: Date.now()
      })
      const updater = new EpisodicMemoryUpdater(new RuleBasedCompactor())
      const result = await updater.forceCompact('w-1')
      expect(result).toBeNull()
      expect(updater.getCounters().compactions_skipped_downgrade).toBe(1)
      // Existing Haiku summary preserved
      const stored = db.getEpisodicMemory('w-1')
      expect(stored?.compactorId).toBe('claude-haiku')
      expect(stored?.summaryMarkdown).toContain('Pretend Haiku')
      await updater.shutdown()
    })

    it('overwrites when same-priority compactor produces new output', async () => {
      seedWorktree('w-1')
      db.upsertEpisodicMemory({
        worktreeId: 'w-1',
        summaryMarkdown: '## Old rule-based summary',
        compactorId: 'rule-based',
        version: 1,
        compactedAt: Date.now() - 60_000,
        sourceEventCount: 10,
        sourceSince: 0,
        sourceUntil: Date.now()
      })
      const updater = new EpisodicMemoryUpdater(makeFixedCompactor('rule-based', 1))
      await updater.forceCompact('w-1')
      const stored = db.getEpisodicMemory('w-1')
      expect(stored?.summaryMarkdown).not.toContain('Old rule-based summary')
      expect(stored?.summaryMarkdown).toContain('Observed Recent Work')
      await updater.shutdown()
    })
  })

  describe('output validation', () => {
    it('rejects too-short markdown and keeps existing summary', async () => {
      seedWorktree('w-1')
      const previous = {
        worktreeId: 'w-1',
        summaryMarkdown: 'Existing healthy summary that is long enough',
        compactorId: 'rule-based',
        version: 1,
        compactedAt: Date.now() - 60_000,
        sourceEventCount: 10,
        sourceSince: 0,
        sourceUntil: Date.now()
      }
      db.upsertEpisodicMemory(previous)

      const tinyCompactor: EpisodicCompactor = {
        id: 'rule-based',
        version: 1,
        async compact(): Promise<CompactionOutput> {
          return { markdown: 'tiny', compactorId: 'rule-based', version: 1 }
        }
      }
      const updater = new EpisodicMemoryUpdater(tinyCompactor)
      await updater.forceCompact('w-1')
      expect(updater.getCounters().compactions_skipped_invalid).toBe(1)
      const stored = db.getEpisodicMemory('w-1')
      expect(stored?.summaryMarkdown).toBe(previous.summaryMarkdown)
      await updater.shutdown()
    })

    it('rejects oversized markdown (>10k chars) and keeps existing', async () => {
      seedWorktree('w-1')
      const oversize: EpisodicCompactor = {
        id: 'rule-based',
        version: 1,
        async compact(): Promise<CompactionOutput> {
          return { markdown: 'x'.repeat(20_000), compactorId: 'rule-based', version: 1 }
        }
      }
      const updater = new EpisodicMemoryUpdater(oversize)
      await updater.forceCompact('w-1')
      expect(updater.getCounters().compactions_skipped_invalid).toBe(1)
      expect(db.getEpisodicMemory('w-1')).toBeNull()
      await updater.shutdown()
    })
  })

  describe('debounce + drag-select storm protection', () => {
    it('file.selection events do NOT count toward eventsSinceCompaction threshold', async () => {
      seedWorktree('w-1')
      const updater = new EpisodicMemoryUpdater(makeFixedCompactor())

      // Emit 100 selection events — threshold is 20, but selections shouldn't count
      for (let i = 0; i < 100; i++) {
        getEventBus().emit('field:event', {
          id: `s-${i}`,
          timestamp: Date.now(),
          worktreeId: 'w-1',
          projectId: 'p-1',
          sessionId: null,
          relatedEventId: null,
          type: 'file.selection',
          payload: { path: '/a.ts', fromLine: 1, toLine: 2, length: 10 }
        } as never)
      }
      // Give the bus listener and any synchronous logic a tick
      await new Promise((r) => setTimeout(r, 10))

      // Nothing should have been scheduled
      expect(updater.getCounters().compactions_attempted).toBe(0)
      await updater.shutdown()
    })

    it('debounces multiple bursts into a single scheduled compaction', async () => {
      seedWorktree('w-1')
      db.upsertEpisodicMemory({
        worktreeId: 'w-1',
        summaryMarkdown: 'old enough to allow a fresh trigger',
        compactorId: 'rule-based',
        version: 1,
        compactedAt: Date.now() - 30 * 60_000,
        sourceEventCount: 5,
        sourceSince: 0,
        sourceUntil: Date.now()
      })

      // Use a tiny debounce so the test doesn't hang for 8 seconds.
      const updater = new EpisodicMemoryUpdater(makeFixedCompactor(), 50)

      // Emit 50 non-selection events (each counts), well above the 20 threshold
      for (let i = 0; i < 50; i++) {
        getEventBus().emit('field:event', {
          id: `e-${i}`,
          timestamp: Date.now(),
          worktreeId: 'w-1',
          projectId: 'p-1',
          sessionId: null,
          relatedEventId: null,
          type: 'file.focus',
          payload: { path: '/a.ts', name: 'a.ts', fromPath: null }
        } as never)
      }

      // Before the debounce timer fires, zero attempts.
      expect(updater.getCounters().compactions_attempted).toBe(0)

      // Wait past debounce + give async runCompact time to run.
      await new Promise((r) => setTimeout(r, 300))

      // Exactly one attempt: the 50 bursts coalesced into one.
      expect(updater.getCounters().compactions_attempted).toBe(1)
      await updater.shutdown()
    })
  })

  describe('shutdown', () => {
    it('shutdown clears scheduled timers', async () => {
      seedWorktree('w-1')
      db.upsertEpisodicMemory({
        worktreeId: 'w-1',
        summaryMarkdown: 'old',
        compactorId: 'rule-based',
        version: 1,
        compactedAt: Date.now() - 30 * 60_000,
        sourceEventCount: 5,
        sourceSince: 0,
        sourceUntil: Date.now()
      })

      const updater = new EpisodicMemoryUpdater(makeFixedCompactor(), 50)

      // Trigger the threshold
      for (let i = 0; i < 25; i++) {
        getEventBus().emit('field:event', {
          id: `e-${i}`,
          timestamp: Date.now(),
          worktreeId: 'w-1',
          projectId: 'p-1',
          sessionId: null,
          relatedEventId: null,
          type: 'file.focus',
          payload: { path: '/a.ts', name: 'a.ts', fromPath: null }
        } as never)
      }

      // Shutdown BEFORE the debounce fires
      await updater.shutdown()

      // Wait beyond the debounce window — no compaction should run because
      // shutdown cancelled the timer.
      await new Promise((r) => setTimeout(r, 200))
      expect(updater.getCounters().compactions_attempted).toBe(0)
    })

    it('after shutdown, forceCompact is a no-op', async () => {
      seedWorktree('w-1')
      const updater = new EpisodicMemoryUpdater(new RuleBasedCompactor())
      await updater.shutdown()
      expect(await updater.forceCompact('w-1')).toBeNull()
      expect(updater.getCounters().compactions_attempted).toBe(0)
    })

    it('after shutdown, emits do not trigger schedules', async () => {
      seedWorktree('w-1')
      const updater = new EpisodicMemoryUpdater(makeFixedCompactor(), 50)
      await updater.shutdown()

      for (let i = 0; i < 25; i++) {
        getEventBus().emit('field:event', {
          id: `e-${i}`,
          timestamp: Date.now(),
          worktreeId: 'w-1',
          projectId: 'p-1',
          sessionId: null,
          relatedEventId: null,
          type: 'file.focus',
          payload: { path: '/a.ts', name: 'a.ts', fromPath: null }
        } as never)
      }
      await new Promise((r) => setTimeout(r, 200))
      expect(updater.getCounters().compactions_attempted).toBe(0)
    })
  })

  describe('secret redaction', () => {
    it('replaces lines containing "api_key" / "password" / "token" patterns', () => {
      const { redactSecrets } = __UPDATER_TUNABLES_FOR_TEST
      const input = `## Output\nfoo bar\nMY_API_KEY=abc123\nharmless line\nAuthorization: Bearer xyz\nthe end`
      const out = redactSecrets(input)
      expect(out).toContain('## Output')
      expect(out).toContain('foo bar')
      expect(out).toContain('harmless line')
      expect(out).not.toContain('abc123')
      expect(out).not.toContain('Bearer xyz')
      expect(out).toContain('[REDACTED LINE]')
    })

    it('leaves clean text untouched', () => {
      const { redactSecrets } = __UPDATER_TUNABLES_FOR_TEST
      const input = 'just a plain summary\nwith two lines'
      expect(redactSecrets(input)).toBe(input)
    })
  })

  describe('emit contract integration', () => {
    it('emitFieldEvent through the bus triggers compaction after debounce', async () => {
      seedWorktree('w-1')
      db.upsertEpisodicMemory({
        worktreeId: 'w-1',
        summaryMarkdown: 'old',
        compactorId: 'rule-based',
        version: 1,
        compactedAt: Date.now() - 30 * 60_000,
        sourceEventCount: 5,
        sourceSince: 0,
        sourceUntil: Date.now()
      })

      const updater = new EpisodicMemoryUpdater(makeFixedCompactor(), 50)

      // 25 non-selection emits (use file.open to avoid the selection skip)
      for (let i = 0; i < 25; i++) {
        emitFieldEvent({
          type: 'file.open',
          worktreeId: 'w-1',
          projectId: 'p-1',
          sessionId: null,
          relatedEventId: null,
          payload: { path: `/a-${i}.ts`, name: `a-${i}.ts` }
        })
      }

      // Wait beyond debounce + give async runCompact time
      await new Promise((r) => setTimeout(r, 300))

      expect(updater.getCounters().compactions_attempted).toBeGreaterThanOrEqual(1)
      await updater.shutdown()
    })
  })
})
