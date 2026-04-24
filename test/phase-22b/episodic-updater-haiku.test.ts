import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'

vi.mock('../../src/main/services/logger', () => ({
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

vi.mock('../../src/main/db', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/db')>('../../src/main/db')
  return {
    ...actual,
    getDatabase: () => {
      const g = globalThis as unknown as {
        __sinkTestDb?: import('../../src/main/db/database').DatabaseService
      }
      if (!g.__sinkTestDb) throw new Error('test DB not initialized')
      return g.__sinkTestDb
    }
  }
})

import { DatabaseService } from '../../src/main/db/database'
import { getFieldEventSink, resetFieldEventSink } from '../../src/main/field/sink'
import {
  setFieldCollectionEnabledCache,
  invalidatePrivacyCache
} from '../../src/main/field/privacy'
import { resetEventBus } from '../../src/server/event-bus'
import { EpisodicMemoryUpdater } from '../../src/main/field/episodic-updater'
import {
  RuleBasedCompactor,
  type EpisodicCompactor,
  type CompactionOutput,
  type CompactionInput,
  InsufficientEventsError
} from '../../src/main/field/episodic-compactor'

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

async function seedEvents(worktreeId: string, count = 20): Promise<void> {
  const sink = getFieldEventSink()
  const t = Date.now()
  for (let i = 0; i < count; i++) {
    const evt = {
      id: `e-${worktreeId}-${i}`,
      timestamp: t - (count - i) * 1000,
      worktreeId,
      projectId: 'p-1',
      sessionId: null,
      relatedEventId: null,
      type: 'file.focus' as const,
      payload: { path: `/src/a-${i % 3}.ts`, name: `a-${i % 3}.ts`, fromPath: null }
    }
    sink.enqueue(evt as never, JSON.stringify(evt.payload))
  }
  await sink.flushNow()
}

function makeHaikuCompactor(opts: {
  fail?: Error | null
  markdown?: string
}): EpisodicCompactor & { calls: number } {
  let calls = 0
  const compactor = {
    id: 'claude-haiku',
    version: 1,
    async compact(input: CompactionInput): Promise<CompactionOutput> {
      calls++
      ;(compactor as unknown as { calls: number }).calls = calls
      if (input.events.length < 5) throw new InsufficientEventsError(input.events.length)
      if (opts.fail) throw opts.fail
      return {
        markdown:
          opts.markdown ??
          '## Claude Haiku Summary\nWorked on streaming renderer in hub-mobile; touched a-0.ts and a-1.ts; no failures observed.',
        compactorId: 'claude-haiku',
        version: 1
      }
    }
  } as EpisodicCompactor & { calls: number }
  compactor.calls = 0
  return compactor
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-episodic-haiku-updater-'))
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

describe('EpisodicMemoryUpdater — Phase 22B.2 Haiku injection + fallback', () => {
  describe('happy path', () => {
    it('writes a Haiku summary when the primary compactor succeeds', async () => {
      seedWorktree('w-1')
      await seedEvents('w-1', 20)
      const haiku = makeHaikuCompactor({})
      const fallback = new RuleBasedCompactor()
      const updater = new EpisodicMemoryUpdater(haiku, 8_000, fallback)

      const out = await updater.forceCompact('w-1')
      expect(out?.compactorId).toBe('claude-haiku')

      const stored = db.getEpisodicMemory('w-1')
      expect(stored?.compactorId).toBe('claude-haiku')
      expect(stored?.summaryMarkdown).toContain('Claude Haiku')
      expect(updater.getCounters().compactions_written).toBe(1)
      expect(updater.getCounters().compactions_fallback_used).toBe(0)
      expect(haiku.calls).toBe(1)
      await updater.shutdown()
    })
  })

  describe('fallback', () => {
    it('falls back to RuleBased when Haiku throws (timeout/quota/network)', async () => {
      seedWorktree('w-1')
      await seedEvents('w-1', 20)
      const haiku = makeHaikuCompactor({ fail: new Error('HTTP 429 rate limit exceeded') })
      const updater = new EpisodicMemoryUpdater(haiku, 8_000, new RuleBasedCompactor())

      const out = await updater.forceCompact('w-1')
      expect(out).not.toBeNull()
      expect(out?.compactorId).toBe('rule-based')

      const stored = db.getEpisodicMemory('w-1')
      expect(stored?.compactorId).toBe('rule-based')
      expect(stored?.summaryMarkdown).toContain('## Observed Recent Work')

      const counters = updater.getCounters()
      expect(counters.compactions_written).toBe(1)
      expect(counters.compactions_failed).toBe(1)
      expect(counters.compactions_fallback_used).toBe(1)
      await updater.shutdown()
    })

    it('InsufficientEvents from primary does NOT trigger fallback (applies to stream, not compactor)', async () => {
      seedWorktree('w-1')
      // Only seed 3 events — below the min.
      await seedEvents('w-1', 3)
      const haiku = makeHaikuCompactor({})
      const ruleSpy: EpisodicCompactor = {
        id: 'rule-based',
        version: 1,
        compact: vi.fn(async () => ({
          markdown: 'should not be called',
          compactorId: 'rule-based',
          version: 1
        }))
      }
      const updater = new EpisodicMemoryUpdater(haiku, 8_000, ruleSpy)
      const out = await updater.forceCompact('w-1')
      expect(out).toBeNull()
      expect(updater.getCounters().compactions_skipped_insufficient).toBe(1)
      expect(ruleSpy.compact).not.toHaveBeenCalled()
      await updater.shutdown()
    })
  })

  describe("don't-downgrade guarantee", () => {
    it('does not overwrite an existing Haiku summary with RuleBased when primary fails', async () => {
      seedWorktree('w-1')
      await seedEvents('w-1', 20)
      // Seed an existing Haiku summary
      db.upsertEpisodicMemory({
        worktreeId: 'w-1',
        summaryMarkdown: '## Pretend earlier Haiku output — must be preserved.',
        compactorId: 'claude-haiku',
        version: 1,
        compactedAt: Date.now() - 60_000,
        sourceEventCount: 10,
        sourceSince: 0,
        sourceUntil: Date.now()
      })

      // Primary (Haiku) fails; fallback is RuleBased, but existing summary is Haiku.
      const haiku = makeHaikuCompactor({ fail: new Error('network error') })
      const updater = new EpisodicMemoryUpdater(haiku, 8_000, new RuleBasedCompactor())

      const out = await updater.forceCompact('w-1')
      expect(out).toBeNull()

      const stored = db.getEpisodicMemory('w-1')
      expect(stored?.compactorId).toBe('claude-haiku')
      expect(stored?.summaryMarkdown).toContain('Pretend earlier Haiku')

      const counters = updater.getCounters()
      expect(counters.compactions_skipped_downgrade).toBeGreaterThanOrEqual(1)
      expect(counters.compactions_written).toBe(0)
      await updater.shutdown()
    })

    it('still overwrites an existing RuleBased summary when Haiku succeeds (upgrade)', async () => {
      seedWorktree('w-1')
      await seedEvents('w-1', 20)
      db.upsertEpisodicMemory({
        worktreeId: 'w-1',
        summaryMarkdown: '## Old rule-based summary kept until upgraded',
        compactorId: 'rule-based',
        version: 1,
        compactedAt: Date.now() - 60_000,
        sourceEventCount: 10,
        sourceSince: 0,
        sourceUntil: Date.now()
      })

      const haiku = makeHaikuCompactor({})
      const updater = new EpisodicMemoryUpdater(haiku, 8_000, new RuleBasedCompactor())
      const out = await updater.forceCompact('w-1')
      expect(out?.compactorId).toBe('claude-haiku')

      const stored = db.getEpisodicMemory('w-1')
      expect(stored?.compactorId).toBe('claude-haiku')
      expect(stored?.summaryMarkdown).not.toContain('Old rule-based summary')
      await updater.shutdown()
    })
  })

  describe('default fallback wiring', () => {
    it('default constructor wires RuleBased as the fallback for Haiku', async () => {
      // When we pass only a Haiku compactor (no explicit fallback), the
      // updater should auto-wire a RuleBasedCompactor. We verify this by
      // making the primary fail and checking that a rule-based summary
      // still lands in the DB.
      seedWorktree('w-1')
      await seedEvents('w-1', 20)
      const haiku = makeHaikuCompactor({ fail: new Error('HTTP 502 Bad Gateway') })
      const updater = new EpisodicMemoryUpdater(haiku) // no explicit fallback

      const out = await updater.forceCompact('w-1')
      expect(out?.compactorId).toBe('rule-based')

      const stored = db.getEpisodicMemory('w-1')
      expect(stored?.compactorId).toBe('rule-based')
      expect(updater.getCounters().compactions_fallback_used).toBe(1)
      await updater.shutdown()
    })
  })
})
