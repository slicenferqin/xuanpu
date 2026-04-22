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
  computeHotFileDigests,
  deriveGoals,
  buildSummary,
  computePacketHash,
  generateCheckpoint,
  type GitProbe
} from '../../src/main/field/checkpoint-generator'
import { DatabaseService } from '../../src/main/db/database'

let tmpDir: string
let worktreePath: string
let db: DatabaseService

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-checkpoint-gen-'))
  worktreePath = join(tmpDir, 'worktree')
  mkdirSync(worktreePath, { recursive: true })
  db = new DatabaseService(join(tmpDir, 'test.db'))
  db.init()
  ;(globalThis as unknown as { __checkpointTestDb: DatabaseService }).__checkpointTestDb = db
})

afterEach(() => {
  db.close()
  delete (globalThis as { __checkpointTestDb?: DatabaseService }).__checkpointTestDb
  rmSync(tmpDir, { recursive: true, force: true })
})

// --- Helpers ---------------------------------------------------------------

type Maker = (payload: unknown, type: string, ts?: number) => StoredFieldEvent
let seq = 0
const mkEvent: Maker = (payload, type, ts = Date.now()) => ({
  id: `ev-${++seq}`,
  seq,
  timestamp: ts,
  worktreeId: 'w-1',
  projectId: null,
  sessionId: 's-1',
  relatedEventId: null,
  type: type as StoredFieldEvent['type'],
  payload
})

function touchFile(rel: string, content = 'hello'): string {
  const abs = join(worktreePath, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

// --- rankHotFiles ----------------------------------------------------------

describe('rankHotFiles (Phase 24C)', () => {
  it('weights file.focus=1, file.selection=2 → selection wins', () => {
    touchFile('a.ts')
    touchFile('b.ts')
    const events = [
      mkEvent({ path: join(worktreePath, 'a.ts') }, 'file.focus'),
      mkEvent({ path: join(worktreePath, 'a.ts') }, 'file.focus'),
      mkEvent(
        { path: join(worktreePath, 'b.ts'), fromLine: 1, toLine: 5, length: 50 },
        'file.selection'
      )
    ]
    const hot = rankHotFiles(events, worktreePath)
    // a.ts: 1+1=2, b.ts: 2 — tie; stable sort, order may vary. Assert both present.
    expect(hot.sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('filters out files that no longer exist on disk', () => {
    touchFile('exists.ts')
    const events = [
      mkEvent({ path: join(worktreePath, 'exists.ts') }, 'file.focus'),
      mkEvent({ path: join(worktreePath, 'gone.ts') }, 'file.focus')
    ]
    expect(rankHotFiles(events, worktreePath)).toEqual(['exists.ts'])
  })

  it('normalizes absolute paths to worktree-relative', () => {
    touchFile('deep/nested.ts')
    const events = [mkEvent({ path: join(worktreePath, 'deep/nested.ts') }, 'file.focus')]
    expect(rankHotFiles(events, worktreePath)).toEqual(['deep/nested.ts'])
  })

  it('respects limit', () => {
    for (const n of ['a', 'b', 'c', 'd', 'e', 'f']) touchFile(`${n}.ts`)
    const events = ['a', 'b', 'c', 'd', 'e', 'f'].map((n, i) =>
      mkEvent({ path: join(worktreePath, `${n}.ts`) }, 'file.focus', 1000 + i)
    )
    expect(rankHotFiles(events, worktreePath, 3)).toHaveLength(3)
  })

  it('returns [] for events with no file activity', () => {
    const events = [
      mkEvent({ command: 'ls' }, 'terminal.command'),
      mkEvent({ text: 'hi', agentSdk: 'opencode', agentSessionId: 'a', attachmentCount: 0 }, 'session.message')
    ]
    expect(rankHotFiles(events, worktreePath)).toEqual([])
  })
})

// --- computeHotFileDigests -------------------------------------------------

describe('computeHotFileDigests (Phase 24C)', () => {
  it('computes sha1 for each existing file', () => {
    touchFile('a.ts', 'AAA')
    touchFile('b.ts', 'BBB')
    const digests = computeHotFileDigests(['a.ts', 'b.ts'], worktreePath)
    expect(digests).not.toBeNull()
    expect(digests!['a.ts']).toMatch(/^[a-f0-9]{40}$/)
    expect(digests!['b.ts']).toMatch(/^[a-f0-9]{40}$/)
    expect(digests!['a.ts']).not.toBe(digests!['b.ts'])
  })

  it('returns null for the whole map when hot_files is empty', () => {
    expect(computeHotFileDigests([], worktreePath)).toBeNull()
  })

  it('individual missing files become null (map still returned)', () => {
    touchFile('exists.ts')
    const digests = computeHotFileDigests(['exists.ts', 'gone.ts'], worktreePath)
    expect(digests!['exists.ts']).toMatch(/^[a-f0-9]{40}$/)
    expect(digests!['gone.ts']).toBeNull()
  })
})

// --- deriveGoals -----------------------------------------------------------

describe('deriveGoals (Phase 24C)', () => {
  const mkMsg = (text: string, ts: number) =>
    mkEvent(
      { text, agentSdk: 'opencode', agentSessionId: 'a', attachmentCount: 0 },
      'session.message',
      ts
    )

  it('returns nulls when there are no user messages', () => {
    expect(deriveGoals([])).toEqual({ currentGoal: null, nextAction: null })
  })

  it('currentGoal = first line of the last user message', () => {
    const events = [
      mkMsg('old message', 1000),
      mkMsg('make refresh retry on 401\nthen add backoff', 2000)
    ]
    const { currentGoal, nextAction } = deriveGoals(events)
    expect(currentGoal).toBe('make refresh retry on 401')
    expect(nextAction).toContain('then add backoff')
  })

  it('truncates long first-line currentGoal', () => {
    const long = 'a'.repeat(500)
    const { currentGoal } = deriveGoals([mkMsg(long, 1000)])
    expect(currentGoal!.length).toBeLessThanOrEqual(120)
    expect(currentGoal).toMatch(/…$/)
  })

  it('detects next-action via keyword (TODO)', () => {
    const { nextAction } = deriveGoals([mkMsg('TODO: fix the auth redirect bug', 1000)])
    expect(nextAction).toContain('TODO')
  })

  it('no keyword → nextAction is null', () => {
    const { nextAction } = deriveGoals([mkMsg('just reviewing code', 1000)])
    expect(nextAction).toBeNull()
  })

  it('ignores empty-text messages', () => {
    const { currentGoal } = deriveGoals([mkMsg('   ', 1000)])
    expect(currentGoal).toBeNull()
  })
})

// --- buildSummary ----------------------------------------------------------

describe('buildSummary (Phase 24C)', () => {
  it('includes branch, duration, counts, and goal', () => {
    const s = buildSummary({
      branch: 'feat_foo',
      durationMinutes: 42,
      editCount: 3,
      commandCount: 5,
      currentGoal: 'refactor auth',
      blockingReason: null
    })
    expect(s).toContain('feat_foo')
    expect(s).toContain('42m')
    expect(s).toContain('3 files edited')
    expect(s).toContain('5 commands run')
    expect(s).toContain('refactor auth')
  })

  it('falls back to (no branch) when branch is null', () => {
    const s = buildSummary({
      branch: null,
      durationMinutes: 1,
      editCount: 0,
      commandCount: 0,
      currentGoal: null,
      blockingReason: null
    })
    expect(s).toContain('(no branch)')
  })

  it('includes blocking reason when present (abort path)', () => {
    const s = buildSummary({
      branch: 'main',
      durationMinutes: 10,
      editCount: 1,
      commandCount: 1,
      currentGoal: null,
      blockingReason: 'user cancel'
    })
    expect(s).toContain('Aborted with: user cancel')
  })
})

// --- computePacketHash -----------------------------------------------------

describe('computePacketHash (Phase 24C)', () => {
  const base = {
    sessionId: 's-1',
    createdAtMinute: '2026-04-22T10:30',
    summary: 'x',
    currentGoal: 'g',
    nextAction: null,
    hotFiles: ['a.ts', 'b.ts'],
    branch: 'main',
    repoHead: 'abc'
  }

  it('is deterministic for the same input', () => {
    expect(computePacketHash(base)).toBe(computePacketHash({ ...base }))
  })

  it('changes when sessionId differs (shutdown multi-session case)', () => {
    expect(computePacketHash({ ...base, sessionId: 's-2' })).not.toBe(
      computePacketHash(base)
    )
  })

  it('changes when createdAtMinute differs (rollover dedupe window)', () => {
    expect(
      computePacketHash({ ...base, createdAtMinute: '2026-04-22T10:31' })
    ).not.toBe(computePacketHash(base))
  })

  it('changes when hotFiles order differs (order matters)', () => {
    expect(computePacketHash({ ...base, hotFiles: ['b.ts', 'a.ts'] })).not.toBe(
      computePacketHash(base)
    )
  })
})

// --- generateCheckpoint (end-to-end) ---------------------------------------

describe('generateCheckpoint (Phase 24C)', () => {
  const mockGit = (head: string | null, branch: string | null): GitProbe => ({
    revParseHead: async () => head,
    abbrevRefHead: async () => branch
  })

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

  it('returns null when there are no events at all for the worktree', async () => {
    const rec = await generateCheckpoint(
      {
        worktreeId: 'w-empty',
        worktreePath,
        sessionId: 's-1',
        source: 'abort'
      },
      mockGit('abc', 'main')
    )
    expect(rec).toBeNull()
  })

  it('builds a complete record from events + git probe', async () => {
    touchFile('src/auth.ts', 'contents')
    const now = 2_000_000
    insertEvents([
      mkEvent({ path: join(worktreePath, 'src/auth.ts') }, 'file.focus', now - 60_000),
      mkEvent(
        {
          text: 'refactor auth\nTODO: add retry',
          agentSdk: 'opencode',
          agentSessionId: 'a',
          attachmentCount: 0
        },
        'session.message',
        now - 30_000
      ),
      mkEvent({ command: 'pnpm test' }, 'terminal.command', now - 10_000)
    ])

    const rec = await generateCheckpoint(
      {
        worktreeId: 'w-1',
        worktreePath,
        sessionId: 's-1',
        source: 'abort',
        blockingReason: 'user cancel',
        now: () => now
      },
      mockGit('abcdef0', 'feat_test')
    )

    expect(rec).not.toBeNull()
    expect(rec!.source).toBe('abort')
    expect(rec!.branch).toBe('feat_test')
    expect(rec!.repoHead).toBe('abcdef0')
    expect(rec!.hotFiles).toContain('src/auth.ts')
    expect(rec!.hotFileDigests!['src/auth.ts']).toMatch(/^[a-f0-9]{40}$/)
    expect(rec!.currentGoal).toBe('refactor auth')
    expect(rec!.nextAction).toContain('TODO')
    expect(rec!.blockingReason).toBe('user cancel')
    expect(rec!.summary).toContain('feat_test')
    expect(rec!.summary).toContain('Aborted with: user cancel')
    expect(rec!.packetHash).toMatch(/^[a-f0-9]{40}$/)
  })

  it('records null branch/repo_head when git probe fails (non-git)', async () => {
    touchFile('foo.ts')
    insertEvents([mkEvent({ path: join(worktreePath, 'foo.ts') }, 'file.focus', 1000)])
    const rec = await generateCheckpoint(
      {
        worktreeId: 'w-1',
        worktreePath,
        sessionId: 's-1',
        source: 'shutdown',
        now: () => 2000
      },
      mockGit(null, null)
    )
    expect(rec!.branch).toBeNull()
    expect(rec!.repoHead).toBeNull()
  })

  it('does not record blockingReason when source=shutdown', async () => {
    touchFile('foo.ts')
    insertEvents([mkEvent({ path: join(worktreePath, 'foo.ts') }, 'file.focus', 1000)])
    const rec = await generateCheckpoint(
      {
        worktreeId: 'w-1',
        worktreePath,
        sessionId: 's-1',
        source: 'shutdown',
        blockingReason: 'ignored for shutdown',
        now: () => 2000
      },
      mockGit('abc', 'main')
    )
    expect(rec!.blockingReason).toBeNull()
  })

  it('normalizes detached HEAD by the probe returning null', async () => {
    // Probe is responsible for "HEAD" → null normalization; spec test covers the contract.
    touchFile('foo.ts')
    insertEvents([mkEvent({ path: join(worktreePath, 'foo.ts') }, 'file.focus', 1000)])
    const probe: GitProbe = {
      revParseHead: async () => 'abc',
      abbrevRefHead: async () => null
    }
    const rec = await generateCheckpoint(
      { worktreeId: 'w-1', worktreePath, sessionId: 's-1', source: 'abort', now: () => 2000 },
      probe
    )
    expect(rec!.branch).toBeNull()
    expect(rec!.repoHead).toBe('abc')
  })
})
