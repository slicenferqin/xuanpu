/**
 * Session Checkpoint generator — Phase 24C.
 *
 * Builds a `CheckpointRecord` from recent field_events. Pure function over
 * (events + git probe + filesystem reads); the caller (hook) handles
 * persistence + privacy gating.
 *
 * Design invariants:
 *   - No LLM. Pure rule-based.
 *   - All side-effecting deps (git, fs, time) injected for testability.
 *   - Failure of any subroutine MUST NOT throw upward — log + return null/[]/0.
 *   - Synchronous sha1 over hot_files (≤5 files, bounded size).
 *
 * See docs/prd/phase-24c-session-checkpoint.md §"Generator 逻辑"
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createLogger } from '../services/logger'
import { getRecentFieldEvents, type StoredFieldEvent } from './repository'
import type { CheckpointRecord } from './checkpoint-repository'

const log = createLogger({ component: 'CheckpointGenerator' })

const execFileAsync = promisify(execFile)

// --- Tunables ---------------------------------------------------------------

const HOT_FILES_LIMIT = 5
/** Hard cap on bytes read for digest. Files larger than this skip the digest. */
const DIGEST_MAX_FILE_BYTES = 1_000_000 // 1 MB
/** Look back this far when no session_id is supplied. */
const FALLBACK_LOOKBACK_MS = 2 * 60 * 60 * 1000 // 2h
const GIT_TIMEOUT_MS = 5_000
/** Truncate user message snippet rendered into goals/summary. */
const GOAL_MAX_CHARS = 120
/** Window of recent user messages to scan for next-action keywords. */
const NEXT_ACTION_LOOKBACK = 3
/** Heuristic keywords (matched as substrings, case-insensitive). */
const NEXT_ACTION_KEYWORDS = ['next', 'todo', '然后', '接下来', '待办', 'then ']

// --- Inputs / outputs -------------------------------------------------------

export interface GeneratorInput {
  worktreeId: string
  worktreePath: string
  sessionId: string
  source: 'abort' | 'shutdown'
  /** Optional, only set for abort flows. */
  blockingReason?: string | null
  /** Caller-supplied clock (mockable). Defaults to Date.now(). */
  now?: () => number
}

/**
 * Pluggable git probe — gives us deterministic tests. Real impl below.
 */
export interface GitProbe {
  /** Returns repo HEAD sha or null. */
  revParseHead(cwd: string): Promise<string | null>
  /** Returns branch name, or null for non-git / detached HEAD. */
  abbrevRefHead(cwd: string): Promise<string | null>
}

export const realGitProbe: GitProbe = {
  async revParseHead(cwd: string) {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd,
        timeout: GIT_TIMEOUT_MS
      })
      const sha = stdout.trim()
      return sha.length >= 7 ? sha : null
    } catch {
      return null
    }
  },

  async abbrevRefHead(cwd: string) {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        timeout: GIT_TIMEOUT_MS
      })
      const branch = stdout.trim()
      // Detached HEAD returns the literal "HEAD" — normalize to null per spec
      if (!branch || branch === 'HEAD') return null
      return branch
    } catch {
      return null
    }
  }
}

// --- Hot files scoring ------------------------------------------------------

/**
 * Score files by event activity and return the top N (most active first).
 * Filters paths whose absolute file does not exist.
 */
export function rankHotFiles(
  events: StoredFieldEvent[],
  worktreePath: string,
  limit = HOT_FILES_LIMIT
): string[] {
  const scores = new Map<string, number>()

  const bump = (rawPath: string | undefined, points: number): void => {
    if (!rawPath) return
    const rel = toRelative(rawPath, worktreePath)
    scores.set(rel, (scores.get(rel) ?? 0) + points)
  }

  for (const ev of events) {
    // Human-action events (Phase 21)
    if (ev.type === 'file.focus' || ev.type === 'file.open') {
      bump((ev.payload as { path?: string }).path, 1)
    } else if (ev.type === 'file.selection') {
      bump((ev.payload as { path?: string }).path, 2)
    }
    // Agent tool events (Phase 21.5). agent.file_write is the strongest
    // signal — the agent just changed the file — and agent.file_read a
    // weaker one. agent.file_search (glob/regex patterns) and
    // agent.bash_exec do NOT point to a specific file and are excluded.
    else if (ev.type === 'agent.file_write') {
      bump((ev.payload as { path?: string }).path, 3)
    } else if (ev.type === 'agent.file_read') {
      bump((ev.payload as { path?: string }).path, 1)
    }
    // terminal.command cwd inside worktree is a weak signal; skipped
    // because it doesn't point to a specific file.
  }

  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1])

  const out: string[] = []
  for (const [rel] of sorted) {
    if (out.length >= limit) break
    const abs = isAbsolute(rel) ? rel : join(worktreePath, rel)
    try {
      const s = statSync(abs)
      if (s.isFile()) out.push(rel)
    } catch {
      // file no longer exists — drop silently
    }
  }
  return out
}

function toRelative(path: string, worktreePath: string): string {
  if (!isAbsolute(path)) return path
  const rel = relative(worktreePath, path)
  // If path is outside worktree, keep absolute (rare)
  return rel.startsWith('..') || rel === '' ? path : rel
}

// --- File digests -----------------------------------------------------------

/**
 * Compute sha1 for each hot file. Synchronous — bounded by HOT_FILES_LIMIT
 * and DIGEST_MAX_FILE_BYTES. Returns map of relPath -> hex|null.
 *
 * Returns null entirely when hotFiles is empty (signals "digest not applicable"
 * vs. "all digests failed").
 */
export function computeHotFileDigests(
  hotFiles: string[],
  worktreePath: string
): Record<string, string | null> | null {
  if (hotFiles.length === 0) return null
  const out: Record<string, string | null> = {}
  for (const rel of hotFiles) {
    out[rel] = sha1OfFile(join(worktreePath, rel))
  }
  return out
}

function sha1OfFile(absPath: string): string | null {
  try {
    const s = statSync(absPath)
    if (!s.isFile() || s.size > DIGEST_MAX_FILE_BYTES) return null
    const buf = readFileSync(absPath)
    return createHash('sha1').update(buf).digest('hex')
  } catch {
    return null
  }
}

// --- Goal / next action heuristics ------------------------------------------

interface GoalsResult {
  currentGoal: string | null
  nextAction: string | null
}

export function deriveGoals(events: StoredFieldEvent[]): GoalsResult {
  const userMessages = events
    .filter((e) => e.type === 'session.message')
    .filter((e) => {
      const p = e.payload as { text?: string } | null
      return typeof p?.text === 'string' && p.text.trim().length > 0
    })

  if (userMessages.length === 0) {
    return { currentGoal: null, nextAction: null }
  }

  // Most recent user message → current_goal
  const latest = userMessages[userMessages.length - 1]
  const text = ((latest.payload as { text: string }).text ?? '').trim()
  const firstLine = text.split(/\r?\n/, 1)[0].trim()
  const currentGoal = firstLine.length > GOAL_MAX_CHARS
    ? firstLine.slice(0, GOAL_MAX_CHARS - 1) + '…'
    : firstLine

  // Scan recent messages for keyword line → next_action
  const recent = userMessages.slice(-NEXT_ACTION_LOOKBACK)
  let nextAction: string | null = null
  outer: for (let i = recent.length - 1; i >= 0; i--) {
    const lines = ((recent[i].payload as { text: string }).text ?? '').split(/\r?\n/)
    for (const line of lines) {
      const lower = line.toLowerCase()
      if (NEXT_ACTION_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))) {
        const trimmed = line.trim()
        nextAction = trimmed.length > GOAL_MAX_CHARS
          ? trimmed.slice(0, GOAL_MAX_CHARS - 1) + '…'
          : trimmed
        break outer
      }
    }
  }

  return { currentGoal, nextAction }
}

// --- Summary line -----------------------------------------------------------

interface SummaryInput {
  branch: string | null
  durationMinutes: number
  editCount: number
  commandCount: number
  currentGoal: string | null
  blockingReason: string | null
}

export function buildSummary(input: SummaryInput): string {
  const branchPart = input.branch ?? '(no branch)'
  const lines: string[] = []
  lines.push(
    `Worked on ${branchPart} for ${input.durationMinutes}m. ${input.editCount} files edited, ${input.commandCount} commands run.`
  )
  if (input.currentGoal) {
    lines.push(`Last user message: "${input.currentGoal}"`)
  }
  if (input.blockingReason) {
    lines.push(`Aborted with: ${input.blockingReason}`)
  }
  return lines.join('\n')
}

// --- packet_hash ------------------------------------------------------------

interface HashInput {
  sessionId: string
  createdAtMinute: string
  summary: string
  currentGoal: string | null
  nextAction: string | null
  hotFiles: string[]
  branch: string | null
  repoHead: string | null
}

export function computePacketHash(input: HashInput): string {
  // Canonical JSON: keys are deterministically ordered above (object literal),
  // and we re-serialize through sorted keys for safety.
  const ordered = Object.fromEntries(
    Object.entries(input).sort(([a], [b]) => a.localeCompare(b))
  )
  const canonical = JSON.stringify(ordered, (_k, v) =>
    Array.isArray(v) ? [...v] : v // arrays kept as-is (order matters for hot_files)
  )
  return createHash('sha1').update(canonical).digest('hex')
}

function isoMinute(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16) // YYYY-MM-DDTHH:MM
}

// --- Main entry -------------------------------------------------------------

/**
 * Build a checkpoint record from current field_events + git/fs probes.
 * Returns null if there is nothing worth checkpointing (no events at all).
 *
 * Caller is responsible for persisting via insertCheckpoint().
 */
export async function generateCheckpoint(
  input: GeneratorInput,
  gitProbe: GitProbe = realGitProbe
): Promise<CheckpointRecord | null> {
  const now = (input.now ?? Date.now)()
  const since = now - FALLBACK_LOOKBACK_MS

  // Pull events: prefer session-scoped, fall back to recent worktree events
  let events: StoredFieldEvent[] = []
  try {
    events = getRecentFieldEvents({
      worktreeId: input.worktreeId,
      sessionId: input.sessionId,
      since,
      limit: 1000,
      order: 'asc'
    })
  } catch (err) {
    log.warn('generateCheckpoint: events query failed', {
      err: err instanceof Error ? err.message : String(err)
    })
  }

  // Fallback: if session-scoped query returns nothing, try worktree-only
  if (events.length === 0) {
    try {
      events = getRecentFieldEvents({
        worktreeId: input.worktreeId,
        since,
        limit: 1000,
        order: 'asc'
      })
    } catch {
      events = []
    }
  }

  if (events.length === 0) {
    log.debug('generateCheckpoint: no events to checkpoint', {
      worktreeId: input.worktreeId,
      sessionId: input.sessionId
    })
    return null
  }

  // Hot files (filter to existing files only)
  const hotFiles = rankHotFiles(events, input.worktreePath)
  // Digests (sync, bounded)
  const hotFileDigests = computeHotFileDigests(hotFiles, input.worktreePath)

  // Goals
  const { currentGoal, nextAction } = deriveGoals(events)

  // Stats for summary. Count distinct files touched (by either human focus
  // events from Phase 21 or agent file_write/file_read from Phase 21.5).
  const touchedFiles = new Set<string>()
  for (const ev of events) {
    if (ev.type === 'file.focus' || ev.type === 'file.selection' || ev.type === 'file.open') {
      const p = (ev.payload as { path?: string }).path
      if (p) touchedFiles.add(p)
    } else if (ev.type === 'agent.file_write' || ev.type === 'agent.file_read') {
      const p = (ev.payload as { path?: string }).path
      if (p) touchedFiles.add(p)
    }
  }
  const editCount = touchedFiles.size
  const commandCount = events.filter(
    (e) => e.type === 'terminal.command' || e.type === 'agent.bash_exec'
  ).length
  const firstTs = events[0]?.timestamp ?? now
  const durationMinutes = Math.max(0, Math.round((now - firstTs) / 60_000))

  // Git probe (parallel)
  const [repoHead, branch] = await Promise.all([
    gitProbe.revParseHead(input.worktreePath),
    gitProbe.abbrevRefHead(input.worktreePath)
  ])

  const summary = buildSummary({
    branch,
    durationMinutes,
    editCount,
    commandCount,
    currentGoal,
    blockingReason: input.source === 'abort' ? input.blockingReason ?? null : null
  })

  const packetHash = computePacketHash({
    sessionId: input.sessionId,
    createdAtMinute: isoMinute(now),
    summary,
    currentGoal,
    nextAction,
    hotFiles,
    branch,
    repoHead
  })

  return {
    id: randomUUID(),
    createdAt: now,
    worktreeId: input.worktreeId,
    sessionId: input.sessionId,
    branch,
    repoHead,
    source: input.source,
    summary,
    currentGoal,
    nextAction,
    blockingReason: input.source === 'abort' ? input.blockingReason ?? null : null,
    hotFiles,
    hotFileDigests,
    packetHash
  }
}
