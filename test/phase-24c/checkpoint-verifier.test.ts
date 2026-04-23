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
  type CheckpointRecord
} from '../../src/main/field/checkpoint-repository'
import type { GitProbe } from '../../src/main/field/checkpoint-generator'
import {
  verifyCheckpoint,
  classifyAge,
  computeDigestDrift,
  CHECKPOINT_EXPIRY_MS,
  CHECKPOINT_STALE_WARN_MS,
  type RevListProbe
} from '../../src/main/field/checkpoint-verifier'

let tmpDir: string
let worktreePath: string
let db: DatabaseService

function touchFile(rel: string, content = 'hello'): string {
  const abs = join(worktreePath, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

function sha1(content: string): string {
  return createHash('sha1').update(content).digest('hex')
}

function makeRecord(overrides: Partial<CheckpointRecord> = {}): CheckpointRecord {
  const base: CheckpointRecord = {
    id: 'ck-1',
    createdAt: 1_700_000_000_000,
    worktreeId: 'w-1',
    sessionId: 's-1',
    branch: 'main',
    repoHead: 'abc123def',
    source: 'abort',
    summary: 'Worked on main for 12m. 3 files edited, 5 commands run.',
    currentGoal: 'refactor auth',
    nextAction: 'add backoff',
    blockingReason: null,
    hotFiles: ['src/auth.ts'],
    hotFileDigests: { 'src/auth.ts': sha1('original') },
    packetHash: 'hash-1'
  }
  return { ...base, ...overrides }
}

const mockGit = (head: string | null, branch: string | null): GitProbe => ({
  revParseHead: async () => head,
  abbrevRefHead: async () => branch
})

const mockRevList = (count: number | null): RevListProbe => ({
  countCommitsSince: async () => count
})

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-checkpoint-verify-'))
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

// --- Pure helpers ----------------------------------------------------------

describe('classifyAge (Phase 24C)', () => {
  it('fresh for age ≤ 2h', () => {
    expect(classifyAge(0)).toBe('fresh')
    expect(classifyAge(CHECKPOINT_STALE_WARN_MS - 1)).toBe('fresh')
  })
  it('warn for 2h < age ≤ 24h', () => {
    expect(classifyAge(CHECKPOINT_STALE_WARN_MS + 1)).toBe('warn')
    expect(classifyAge(CHECKPOINT_EXPIRY_MS)).toBe('warn')
  })
  it('expired for age > 24h', () => {
    expect(classifyAge(CHECKPOINT_EXPIRY_MS + 1)).toBe('expired')
  })
})

describe('computeDigestDrift (Phase 24C)', () => {
  it('zero/zero/0 when recorded is null', () => {
    expect(computeDigestDrift(null, worktreePath)).toEqual({
      driftCount: 0,
      total: 0,
      ratio: 0
    })
  })

  it('zero drift when every file matches', () => {
    touchFile('a.ts', 'AAA')
    const recorded = { 'a.ts': sha1('AAA') }
    const r = computeDigestDrift(recorded, worktreePath)
    expect(r).toEqual({ driftCount: 0, total: 1, ratio: 0 })
  })

  it('counts missing files as drift', () => {
    const recorded = { 'gone.ts': sha1('anything') }
    const r = computeDigestDrift(recorded, worktreePath)
    expect(r).toEqual({ driftCount: 1, total: 1, ratio: 1 })
  })

  it('counts sha mismatch as drift', () => {
    touchFile('a.ts', 'CHANGED')
    const recorded = { 'a.ts': sha1('ORIGINAL') }
    const r = computeDigestDrift(recorded, worktreePath)
    expect(r.driftCount).toBe(1)
    expect(r.ratio).toBe(1)
  })

  it('recorded null sha + file now exists → not drift (no baseline)', () => {
    touchFile('a.ts', 'anything')
    const recorded = { 'a.ts': null }
    const r = computeDigestDrift(recorded, worktreePath)
    expect(r.driftCount).toBe(0)
  })

  it('mixed: 1/2 drift gives ratio 0.5', () => {
    touchFile('kept.ts', 'X')
    // missing.ts deliberately not created
    const recorded = { 'kept.ts': sha1('X'), 'missing.ts': sha1('Y') }
    const r = computeDigestDrift(recorded, worktreePath)
    expect(r).toEqual({ driftCount: 1, total: 2, ratio: 0.5 })
  })
})

// --- verifyCheckpoint end-to-end -------------------------------------------

describe('verifyCheckpoint (Phase 24C)', () => {
  const now = 2_000_000_000_000

  it('returns null when no checkpoint exists', async () => {
    const r = await verifyCheckpoint(
      { worktreeId: 'w-none', worktreePath, now: () => now },
      mockGit('abc', 'main'),
      mockRevList(0)
    )
    expect(r).toBeNull()
  })

  it('returns block with no warnings on a clean match', async () => {
    touchFile('src/auth.ts', 'original')
    insertCheckpoint(
      makeRecord({
        createdAt: now - 10 * 60_000, // 10m old → fresh
        hotFileDigests: { 'src/auth.ts': sha1('original') }
      })
    )
    const r = await verifyCheckpoint(
      { worktreeId: 'w-1', worktreePath, now: () => now },
      mockGit('abc123def', 'main'),
      mockRevList(0)
    )
    expect(r).not.toBeNull()
    expect(r!.warnings).toEqual([])
    expect(r!.ageMinutes).toBe(10)
    expect(r!.summary).toContain('Worked on main')
  })

  it('returns null when age > 24h (expired)', async () => {
    insertCheckpoint(makeRecord({ createdAt: now - 25 * 60 * 60 * 1000 }))
    const r = await verifyCheckpoint(
      { worktreeId: 'w-1', worktreePath, now: () => now },
      mockGit('abc123def', 'main'),
      mockRevList(0)
    )
    expect(r).toBeNull()
  })

  it('adds a warning when 2h < age ≤ 24h', async () => {
    touchFile('src/auth.ts', 'original')
    insertCheckpoint(
      makeRecord({
        createdAt: now - 5 * 60 * 60 * 1000, // 5h
        hotFileDigests: { 'src/auth.ts': sha1('original') }
      })
    )
    const r = await verifyCheckpoint(
      { worktreeId: 'w-1', worktreePath, now: () => now },
      mockGit('abc123def', 'main'),
      mockRevList(0)
    )
    expect(r).not.toBeNull()
    expect(r!.warnings.some((w) => /5h old/.test(w))).toBe(true)
  })

  it('returns null when current branch differs (branch_changed)', async () => {
    touchFile('src/auth.ts', 'original')
    insertCheckpoint(
      makeRecord({
        createdAt: now - 60_000,
        hotFileDigests: { 'src/auth.ts': sha1('original') }
      })
    )
    const r = await verifyCheckpoint(
      { worktreeId: 'w-1', worktreePath, now: () => now },
      mockGit('abc123def', 'feat_other'),
      mockRevList(0)
    )
    expect(r).toBeNull()
  })

  it('skips branch check when both recorded and current are null', async () => {
    touchFile('src/auth.ts', 'original')
    insertCheckpoint(
      makeRecord({
        createdAt: now - 60_000,
        branch: null,
        repoHead: null,
        hotFileDigests: { 'src/auth.ts': sha1('original') }
      })
    )
    const r = await verifyCheckpoint(
      { worktreeId: 'w-1', worktreePath, now: () => now },
      mockGit(null, null),
      mockRevList(0)
    )
    expect(r).not.toBeNull()
    expect(r!.warnings).toEqual([])
  })

  it('adds "N commits landed" warning on HEAD drift (not stale)', async () => {
    touchFile('src/auth.ts', 'original')
    insertCheckpoint(
      makeRecord({
        createdAt: now - 60_000,
        hotFileDigests: { 'src/auth.ts': sha1('original') }
      })
    )
    const r = await verifyCheckpoint(
      { worktreeId: 'w-1', worktreePath, now: () => now },
      mockGit('newHEAD', 'main'),
      mockRevList(3)
    )
    expect(r).not.toBeNull()
    expect(r!.warnings.some((w) => /3 commits landed/.test(w))).toBe(true)
  })

  it('adds "checkpoint HEAD unreachable" when rev-list fails', async () => {
    touchFile('src/auth.ts', 'original')
    insertCheckpoint(
      makeRecord({
        createdAt: now - 60_000,
        hotFileDigests: { 'src/auth.ts': sha1('original') }
      })
    )
    const r = await verifyCheckpoint(
      { worktreeId: 'w-1', worktreePath, now: () => now },
      mockGit('newHEAD', 'main'),
      mockRevList(null)
    )
    expect(r).not.toBeNull()
    expect(r!.warnings).toContain('checkpoint HEAD unreachable')
  })

  it('returns null when ≥50% of hot files have drifted', async () => {
    touchFile('kept.ts', 'A')
    // gone1.ts, gone2.ts deliberately missing
    insertCheckpoint(
      makeRecord({
        createdAt: now - 60_000,
        hotFiles: ['kept.ts', 'gone1.ts', 'gone2.ts'],
        hotFileDigests: {
          'kept.ts': sha1('A'),
          'gone1.ts': sha1('B'),
          'gone2.ts': sha1('C')
        }
      })
    )
    const r = await verifyCheckpoint(
      { worktreeId: 'w-1', worktreePath, now: () => now },
      mockGit('abc123def', 'main'),
      mockRevList(0)
    )
    expect(r).toBeNull()
  })

  it('adds digest-drift warning at 1/3 (below 50% threshold)', async () => {
    touchFile('a.ts', 'A')
    touchFile('b.ts', 'B')
    // c.ts missing → 1/3 drift
    insertCheckpoint(
      makeRecord({
        createdAt: now - 60_000,
        hotFiles: ['a.ts', 'b.ts', 'c.ts'],
        hotFileDigests: { 'a.ts': sha1('A'), 'b.ts': sha1('B'), 'c.ts': sha1('C') }
      })
    )
    const r = await verifyCheckpoint(
      { worktreeId: 'w-1', worktreePath, now: () => now },
      mockGit('abc123def', 'main'),
      mockRevList(0)
    )
    expect(r).not.toBeNull()
    expect(r!.warnings.some((w) => /1\/3 hot files changed/.test(w))).toBe(true)
  })

  it('is pure read-only: two concurrent calls return equivalent results', async () => {
    touchFile('src/auth.ts', 'original')
    insertCheckpoint(
      makeRecord({
        createdAt: now - 60_000,
        hotFileDigests: { 'src/auth.ts': sha1('original') }
      })
    )
    const git = mockGit('abc123def', 'main')
    const rl = mockRevList(0)
    const [a, b] = await Promise.all([
      verifyCheckpoint({ worktreeId: 'w-1', worktreePath, now: () => now }, git, rl),
      verifyCheckpoint({ worktreeId: 'w-1', worktreePath, now: () => now }, git, rl)
    ])
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a).toEqual(b)

    // And DB still has only the one row we inserted (no writes)
    const count = (db
      .getDbHandle()
      .prepare(`SELECT COUNT(*) AS c FROM field_session_checkpoints`)
      .get() as { c: number }).c
    expect(count).toBe(1)
  })

  it('returns latest checkpoint, even if older rows exist with same worktree', async () => {
    touchFile('src/auth.ts', 'original')
    insertCheckpoint(
      makeRecord({
        id: 'ck-old',
        packetHash: 'h-old',
        createdAt: now - 5 * 60_000,
        summary: 'OLD summary',
        hotFileDigests: { 'src/auth.ts': sha1('original') }
      })
    )
    insertCheckpoint(
      makeRecord({
        id: 'ck-new',
        packetHash: 'h-new',
        createdAt: now - 1 * 60_000,
        summary: 'NEW summary',
        hotFileDigests: { 'src/auth.ts': sha1('original') }
      })
    )
    const r = await verifyCheckpoint(
      { worktreeId: 'w-1', worktreePath, now: () => now },
      mockGit('abc123def', 'main'),
      mockRevList(0)
    )
    expect(r!.summary).toBe('NEW summary')
  })
})
