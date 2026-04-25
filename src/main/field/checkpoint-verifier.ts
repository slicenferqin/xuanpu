/**
 * Session Checkpoint verifier — Phase 24C.
 *
 * Pure read-only function. Reads the latest checkpoint for a worktree, probes
 * current git/fs state, and decides:
 *   - return null  → do NOT inject (stale, expired, or missing)
 *   - return block → inject the resumed-session sub-block, possibly with warnings
 *
 * The verifier NEVER writes to the DB. Stale rows are naturally superseded by
 * the next generate (verifier always reads the most recent row).
 *
 * See docs/prd/phase-24c-session-checkpoint.md §"Verifier 逻辑"
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../services/logger'
import { getLatestCheckpoint } from './checkpoint-repository'
import { realGitProbe, type GitProbe } from './checkpoint-generator'

const log = createLogger({ component: 'CheckpointVerifier' })

const execFileAsync = promisify(execFile)

// --- Tunables (module-level consts; intentionally NOT user-configurable) ---

/** Older than this and the checkpoint is dropped entirely. */
export const CHECKPOINT_EXPIRY_MS = 24 * 60 * 60 * 1000
/** Older than this (but younger than expiry) and we inject with a warning. */
export const CHECKPOINT_STALE_WARN_MS = 2 * 60 * 60 * 1000
/** Drift ratio at or above which we treat the working set as "shifted" and skip injection. */
export const DIGEST_DRIFT_DROP_RATIO = 0.5
/** Same bound as generator — files larger than this skip digest comparison. */
const DIGEST_MAX_FILE_BYTES = 1_000_000
const GIT_TIMEOUT_MS = 5_000

// --- Types -----------------------------------------------------------------

export interface ResumedCheckpointBlock {
  createdAt: number
  ageMinutes: number
  source: 'abort' | 'shutdown'
  summary: string
  /** Heuristic guess; formatter MUST mark with "(heuristic)" tag */
  currentGoal: string | null
  /** Heuristic guess; formatter MUST mark with "(heuristic)" tag */
  nextAction: string | null
  blockingReason: string | null
  hotFiles: string[]
  warnings: string[]
}

export interface VerifierInput {
  worktreeId: string
  worktreePath: string
  /** Caller-supplied clock (mockable). Defaults to Date.now(). */
  now?: () => number
}

// --- Extended probe (for HEAD-distance only) -------------------------------

/**
 * Counts commits between `from..HEAD`. Returns null on failure (e.g. old SHA
 * unreachable). Optional verifier extension to GitProbe.
 */
export interface RevListProbe {
  countCommitsSince(cwd: string, fromSha: string): Promise<number | null>
}

export const realRevListProbe: RevListProbe = {
  async countCommitsSince(cwd, fromSha) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['rev-list', '--count', `${fromSha}..HEAD`],
        { cwd, timeout: GIT_TIMEOUT_MS }
      )
      const n = parseInt(stdout.trim(), 10)
      return Number.isFinite(n) && n >= 0 ? n : null
    } catch {
      return null
    }
  }
}

// --- Pure helpers (exported for tests) -------------------------------------

export function classifyAge(ageMs: number): 'fresh' | 'warn' | 'expired' {
  if (ageMs > CHECKPOINT_EXPIRY_MS) return 'expired'
  if (ageMs > CHECKPOINT_STALE_WARN_MS) return 'warn'
  return 'fresh'
}

export interface DigestDriftResult {
  driftCount: number
  total: number
  ratio: number
}

export function computeDigestDrift(
  recorded: Record<string, string | null> | null,
  worktreePath: string
): DigestDriftResult {
  if (!recorded) return { driftCount: 0, total: 0, ratio: 0 }
  const entries = Object.entries(recorded)
  if (entries.length === 0) return { driftCount: 0, total: 0, ratio: 0 }

  let drift = 0
  for (const [rel, recordedSha] of entries) {
    const current = sha1OfFile(join(worktreePath, rel))
    if (current === null) {
      // file gone or unreadable
      drift++
      continue
    }
    if (recordedSha !== null && current !== recordedSha) {
      drift++
    }
    // recordedSha === null && current !== null → file appeared, treat as no drift
    //                                            (we never had a baseline)
  }

  return { driftCount: drift, total: entries.length, ratio: drift / entries.length }
}

function sha1OfFile(absPath: string): string | null {
  try {
    const s = statSync(absPath)
    if (!s.isFile() || s.size > DIGEST_MAX_FILE_BYTES) return null
    return createHash('sha1').update(readFileSync(absPath)).digest('hex')
  } catch {
    return null
  }
}

// --- Main verifier ---------------------------------------------------------

/**
 * Verify the latest checkpoint and return an injection block (or null).
 *
 * Pure read-only — no DB writes, no side effects beyond git/fs probes.
 */
export async function verifyCheckpoint(
  input: VerifierInput,
  gitProbe: GitProbe = realGitProbe,
  revListProbe: RevListProbe = realRevListProbe
): Promise<ResumedCheckpointBlock | null> {
  const now = (input.now ?? Date.now)()

  // 1. Latest checkpoint (or nothing to do)
  let latest
  try {
    latest = getLatestCheckpoint(input.worktreeId)
  } catch (err) {
    log.warn('verifyCheckpoint: read failed', {
      err: err instanceof Error ? err.message : String(err)
    })
    return null
  }
  if (!latest) return null

  // 2. Time gate
  const ageMs = Math.max(0, now - latest.createdAt)
  const ageClass = classifyAge(ageMs)
  if (ageClass === 'expired') {
    log.debug('verifyCheckpoint: expired', { worktreeId: input.worktreeId, ageMs })
    return null
  }

  const warnings: string[] = []
  if (ageClass === 'warn') {
    const hours = Math.round(ageMs / (60 * 60 * 1000))
    warnings.push(`checkpoint ${hours}h old`)
  }

  // 3. Branch check (skipped when both are null)
  let currentBranch: string | null = null
  try {
    currentBranch = await gitProbe.abbrevRefHead(input.worktreePath)
  } catch {
    currentBranch = null
  }
  if (latest.branch !== null || currentBranch !== null) {
    if (latest.branch !== currentBranch) {
      log.debug('verifyCheckpoint: branch_changed', {
        recorded: latest.branch,
        current: currentBranch
      })
      return null
    }
  }

  // 4. HEAD drift (warning only — not stale)
  if (latest.repoHead !== null) {
    let currentHead: string | null = null
    try {
      currentHead = await gitProbe.revParseHead(input.worktreePath)
    } catch {
      currentHead = null
    }
    if (currentHead && currentHead !== latest.repoHead) {
      const n = await revListProbe.countCommitsSince(input.worktreePath, latest.repoHead)
      if (n === null) {
        warnings.push('checkpoint HEAD unreachable')
      } else if (n > 0) {
        warnings.push(`${n} commits landed since checkpoint — verify before resuming`)
      }
    }
  }

  // 5. File digest drift
  const drift = computeDigestDrift(latest.hotFileDigests, input.worktreePath)
  if (drift.total > 0) {
    if (drift.ratio >= DIGEST_DRIFT_DROP_RATIO) {
      log.debug('verifyCheckpoint: working_set_shifted', {
        worktreeId: input.worktreeId,
        ratio: drift.ratio
      })
      return null
    }
    if (drift.driftCount > 0) {
      warnings.push(`${drift.driftCount}/${drift.total} hot files changed outside session`)
    }
  }

  // 6. Build block
  const ageMinutes = Math.max(0, Math.round(ageMs / 60_000))
  return {
    createdAt: latest.createdAt,
    ageMinutes,
    source: latest.source,
    summary: latest.summary,
    currentGoal: latest.currentGoal,
    nextAction: latest.nextAction,
    blockingReason: latest.blockingReason,
    hotFiles: latest.hotFiles,
    warnings
  }
}
