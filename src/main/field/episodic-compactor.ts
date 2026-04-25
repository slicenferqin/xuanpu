/**
 * Episodic Memory Compactor — Phase 22B.1
 *
 * Defines the EpisodicCompactor interface and ships a rule-based stub
 * implementation. The stub does NOT call any LLM; it produces a factual
 * recap of observed events. Phase 22B.2 will add a Claude Haiku compactor
 * that implements the same interface.
 *
 * See docs/prd/phase-22b-episodic-memory.md
 *
 * Critical design constraint (per oracle review):
 *   The rule-based compactor MUST NOT do inference / interpretation /
 *   hypothesis-generation. Its only job is to faithfully summarize observed
 *   events. Any prose that smells like "I think the user is debugging X" is
 *   hallucination by another name.
 */
import { basename } from 'path'
import type { StoredFieldEvent } from './repository'

export interface CompactionInput {
  worktreeId: string
  worktreeName: string
  branchName: string | null
  /** Events strictly within [since, until], asc order by timestamp. */
  events: StoredFieldEvent[]
  since: number
  until: number
}

export interface CompactionOutput {
  markdown: string
  compactorId: string
  version: number
}

export interface EpisodicCompactor {
  readonly id: string
  readonly version: number
  compact(input: CompactionInput): Promise<CompactionOutput>
}

/**
 * Thrown by compactors that cannot produce a useful summary from the input
 * (e.g. too few events). The updater treats this as "skip without overwriting".
 */
export class InsufficientEventsError extends Error {
  constructor(public readonly eventCount: number) {
    super(`insufficient events for compaction (${eventCount} < 5)`)
    this.name = 'InsufficientEventsError'
  }
}

// ---------------------------------------------------------------------------
// RuleBasedCompactor
// ---------------------------------------------------------------------------

const MIN_EVENTS = 5
const MAX_CHARS = 2500
const TIME_BUCKET_MS = 15 * 60_000 // 15-minute buckets for "Observed Recent Work"
const MAX_BUCKETS_RENDERED = 12 // last 3 hours of 15-min buckets
const MAX_TOP_FILES = 3
const MAX_FAILURES = 5

export class RuleBasedCompactor implements EpisodicCompactor {
  readonly id = 'rule-based'
  readonly version = 1

  async compact(input: CompactionInput): Promise<CompactionOutput> {
    if (input.events.length < MIN_EVENTS) {
      throw new InsufficientEventsError(input.events.length)
    }

    const sections: string[] = []

    const work = renderObservedWork(input)
    if (work) sections.push(work)

    const top = renderTopFiles(input.events)
    if (top) sections.push(top)

    const failures = renderFailures(input.events)
    if (failures) sections.push(failures)

    let markdown = sections.join('\n\n')

    // Hard char cap: if we somehow blew past it, drop sections from the end
    // (failures last, then top files, then observed work tail).
    if (markdown.length > MAX_CHARS) {
      markdown = truncateToCharBudget(markdown, MAX_CHARS)
    }

    return {
      markdown,
      compactorId: this.id,
      version: this.version
    }
  }
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderObservedWork(input: CompactionInput): string | null {
  const buckets = bucketByTime(input.events, input.since, input.until)
  if (buckets.length === 0) return null

  const lines: string[] = ['## Observed Recent Work']
  for (const b of buckets.slice(-MAX_BUCKETS_RENDERED)) {
    const range = `${formatTime(b.start)}–${formatTime(b.end)}`
    const counts: string[] = []
    if (b.commands > 0) counts.push(`ran ${b.commands} command${b.commands > 1 ? 's' : ''}`)
    if (b.fileTouches > 0)
      counts.push(`touched ${b.fileTouches} file event${b.fileTouches > 1 ? 's' : ''}`)
    if (b.prompts > 0) counts.push(`sent ${b.prompts} prompt${b.prompts > 1 ? 's' : ''}`)
    if (b.switches > 0)
      counts.push(`${b.switches} worktree switch${b.switches > 1 ? 'es' : ''}`)
    if (counts.length === 0) continue
    lines.push(`- ${range} ${counts.join(', ')}`)
  }
  if (lines.length === 1) return null // header only
  return lines.join('\n')
}

function renderTopFiles(events: StoredFieldEvent[]): string | null {
  const counts = new Map<string, number>()
  for (const e of events) {
    if (e.type !== 'file.open' && e.type !== 'file.focus' && e.type !== 'file.selection') continue
    const path = (e.payload as { path?: string })?.path
    if (typeof path !== 'string' || path.length === 0) continue
    counts.set(path, (counts.get(path) ?? 0) + 1)
  }
  if (counts.size === 0) return null

  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOP_FILES)
  const lines = ['## Most-Touched Files']
  for (const [path, count] of sorted) {
    const name = basename(path)
    lines.push(`- \`${name}\` (${count} event${count > 1 ? 's' : ''}) — ${path}`)
  }
  return lines.join('\n')
}

function renderFailures(events: StoredFieldEvent[]): string | null {
  const failures: Array<{ timestamp: number; command: string | null; exitCode: number }> = []

  // Build a quick map from terminal.command id -> command text for correlation.
  const commandText = new Map<string, string>()
  for (const e of events) {
    if (e.type === 'terminal.command') {
      const p = e.payload as { command?: string }
      if (typeof p?.command === 'string') commandText.set(e.id, p.command)
    }
  }

  for (const e of events) {
    if (e.type !== 'terminal.output') continue
    const p = e.payload as { exitCode?: number | null }
    if (typeof p?.exitCode !== 'number' || p.exitCode === 0) continue
    failures.push({
      timestamp: e.timestamp,
      command: e.relatedEventId ? commandText.get(e.relatedEventId) ?? null : null,
      exitCode: p.exitCode
    })
  }

  if (failures.length === 0) return null

  const lines = ['## Recent Failures / Signals']
  for (const f of failures.slice(-MAX_FAILURES)) {
    const cmd = f.command ? `\`${truncate(f.command, 80)}\`` : '(unknown command)'
    lines.push(`- ${formatTime(f.timestamp)} ${cmd} exited with code ${f.exitCode}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Bucket {
  start: number
  end: number
  commands: number
  fileTouches: number
  prompts: number
  switches: number
}

function bucketByTime(events: StoredFieldEvent[], since: number, until: number): Bucket[] {
  if (events.length === 0) return []
  const buckets: Bucket[] = []
  // Anchor buckets to since, walking forward in TIME_BUCKET_MS chunks.
  let bucketStart = Math.floor(since / TIME_BUCKET_MS) * TIME_BUCKET_MS
  const lastTimestamp = events[events.length - 1].timestamp

  while (bucketStart <= lastTimestamp && bucketStart <= until) {
    buckets.push({
      start: bucketStart,
      end: bucketStart + TIME_BUCKET_MS,
      commands: 0,
      fileTouches: 0,
      prompts: 0,
      switches: 0
    })
    bucketStart += TIME_BUCKET_MS
  }

  // Distribute events across buckets.
  for (const e of events) {
    const idx = Math.floor((e.timestamp - buckets[0].start) / TIME_BUCKET_MS)
    if (idx < 0 || idx >= buckets.length) continue
    const b = buckets[idx]
    switch (e.type) {
      case 'terminal.command':
        b.commands++
        break
      case 'file.open':
      case 'file.focus':
      case 'file.selection':
        b.fileTouches++
        break
      case 'session.message':
        b.prompts++
        break
      case 'worktree.switch':
        b.switches++
        break
      default:
        break
    }
  }

  // Drop empty buckets (no activity).
  return buckets.filter((b) => b.commands + b.fileTouches + b.prompts + b.switches > 0)
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…'
}

function truncateToCharBudget(markdown: string, budget: number): string {
  if (markdown.length <= budget) return markdown
  // Cut at a section boundary (\n\n) so the result reads cleanly.
  const trimmed = markdown.slice(0, budget)
  const lastBreak = trimmed.lastIndexOf('\n\n')
  if (lastBreak > 0) return trimmed.slice(0, lastBreak) + '\n\n…(truncated)'
  return trimmed + '…'
}

// Test helpers
export const __COMPACTOR_TUNABLES_FOR_TEST = {
  MIN_EVENTS,
  MAX_CHARS,
  TIME_BUCKET_MS,
  MAX_BUCKETS_RENDERED,
  MAX_TOP_FILES,
  MAX_FAILURES
}
