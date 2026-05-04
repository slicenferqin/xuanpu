/**
 * Built-in compression strategies for the OutputCompressionPipeline.
 *
 * Each strategy is a pure function of (text, ctx). They are ordered in the
 * default pipeline as:
 *
 *   1. AnsiStrip      — drop ANSI escape sequences (always-on cleanup)
 *   2. ProgressDedup  — collapse \r progress redraws + repeated lines
 *   3. NdjsonSummary  — if the whole stream is JSON-lines, produce a summary
 *   4. FailureFocus   — if exit≠0 / errors present, keep error sections only
 *   5. StatsExtraction — if a test/build summary line is present, lift it
 *
 * Order matters: cleanup first, transforms last. Each strategy is conservative:
 * if its trigger condition is not met it returns `{ changed: false }` without
 * allocating.
 *
 * Borrowed conceptually from RTK's 12-rule library, but reimplemented in TS
 * for in-process execution. We are not a port — we pick the highest-ROI 5.
 */
import type { CompressionContext, OutputStrategy, StrategyResult } from './pipeline'

// ───────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────

/** Threshold below which we don't bother compressing (overhead > savings). */
const MIN_COMPRESS_BYTES = 512

/** When a section is summarised as "first/last N lines", how many to keep. */
const HEAD_TAIL_KEEP_LINES = 5

// ───────────────────────────────────────────────────────────────────────────
// 1. AnsiStrip
// ───────────────────────────────────────────────────────────────────────────

// Matches CSI sequences (most common: SGR colour codes), OSC, and a few
// terminal control bytes. Conservative — does NOT touch printable text.
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[PX^_].*?\x1b\\/g

export const ansiStripStrategy: OutputStrategy = {
  name: 'ansi-strip',
  apply(text: string): StrategyResult {
    if (!text || !ANSI_REGEX.test(text)) {
      ANSI_REGEX.lastIndex = 0
      return { changed: false, text }
    }
    ANSI_REGEX.lastIndex = 0
    const out = text.replace(ANSI_REGEX, '')
    if (out === text) return { changed: false, text }
    return { changed: true, text: out, hint: 'stripped ANSI escapes' }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 2. ProgressDedup
// ───────────────────────────────────────────────────────────────────────────

/**
 * Two transforms in one strategy:
 *   (a) Carriage-return progress redraws: collapse `foo\rbar\rbaz\n` to `baz\n`.
 *   (b) Repeated lines: `npm install` printing the same dep 100×, `tsc` watch
 *       bouncing the same warning. Replace runs of identical lines with one
 *       line + `... (×N)`.
 */
export const progressDedupStrategy: OutputStrategy = {
  name: 'progress-dedup',
  apply(text: string): StrategyResult {
    if (!text || text.length < 8) return { changed: false, text }

    // (a) Collapse \r progress: keep only the final write before \n.
    let cur = text
    if (cur.includes('\r') && !cur.includes('\r\n')) {
      // Bare \r (terminal redraw) — collapse runs.
      cur = cur.replace(/[^\n]*\r/g, '')
    } else if (cur.includes('\r\n')) {
      // Normalize CRLF to LF, then look for bare \r within lines.
      cur = cur.replace(/\r\n/g, '\n').replace(/[^\n]*\r/g, '')
    }

    // (b) Repeated-line collapse.
    const lines = cur.split('\n')
    const out: string[] = []
    let i = 0
    let dedupCount = 0
    while (i < lines.length) {
      const line = lines[i]
      let runEnd = i + 1
      while (runEnd < lines.length && lines[runEnd] === line) runEnd++
      const runLen = runEnd - i
      if (runLen >= 4 && line.trim().length > 0) {
        out.push(`${line}    … (×${runLen})`)
        dedupCount += runLen - 1
      } else {
        for (let k = i; k < runEnd; k++) out.push(lines[k])
      }
      i = runEnd
    }

    const joined = out.join('\n')
    if (joined === text) return { changed: false, text }
    return {
      changed: true,
      text: joined,
      hint: dedupCount > 0 ? `collapsed ${dedupCount} repeated lines` : 'collapsed progress redraws'
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 3. NdjsonSummary
// ───────────────────────────────────────────────────────────────────────────

/**
 * If the input looks like newline-delimited JSON (every non-empty line is
 * valid JSON), produce a summary that keeps the first and last few records
 * verbatim and counts records by `level` field if present.
 *
 * Trigger: ≥10 lines AND ≥80% are valid JSON objects.
 */
export const ndjsonSummaryStrategy: OutputStrategy = {
  name: 'ndjson-summary',
  apply(text: string): StrategyResult {
    if (!text || text.length < MIN_COMPRESS_BYTES) return { changed: false, text }
    const lines = text.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length < 10) return { changed: false, text }

    const parsed: Array<{ raw: string; obj: Record<string, unknown> | null }> = []
    let validCount = 0
    for (const raw of lines) {
      let obj: Record<string, unknown> | null = null
      const trimmed = raw.trim()
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const v = JSON.parse(trimmed)
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            obj = v as Record<string, unknown>
            validCount++
          }
        } catch {
          // not JSON, leave obj null
        }
      }
      parsed.push({ raw, obj })
    }
    if (validCount < lines.length * 0.8) return { changed: false, text }

    // Count by level (common log shape).
    const levelCounts: Record<string, number> = {}
    for (const p of parsed) {
      if (!p.obj) continue
      const lvl = typeof p.obj.level === 'string' ? p.obj.level : '(no-level)'
      levelCounts[lvl] = (levelCounts[lvl] ?? 0) + 1
    }
    const levelSummary = Object.entries(levelCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')

    const head = parsed.slice(0, HEAD_TAIL_KEEP_LINES).map((p) => p.raw)
    const tail = parsed.slice(-HEAD_TAIL_KEEP_LINES).map((p) => p.raw)
    const omitted = lines.length - head.length - tail.length

    const summary = [
      `[ndjson summary: ${lines.length} records · ${levelSummary}]`,
      ...head,
      omitted > 0 ? `… (${omitted} records omitted)` : null,
      ...(omitted > 0 ? tail : [])
    ]
      .filter((s): s is string => s !== null)
      .join('\n')

    return {
      changed: true,
      text: summary,
      hint: `summarised ${lines.length} ndjson records`
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 4. FailureFocus
// ───────────────────────────────────────────────────────────────────────────

const FAILURE_LINE_REGEX =
  /\b(error|failed|failure|fatal|exception|traceback|panicked|✗|×|FAIL)\b/i

/**
 * If the command failed (exit≠0) OR the text contains failure markers AND is
 * large, keep:
 *   - The first 5 lines (often the command echo / setup)
 *   - All blocks containing failure markers, with 3 lines of context each
 *   - The last 5 lines (often the summary / exit)
 *
 * Drop everything else. Useful for `pnpm test` failing — agent only needs to
 * see the failures, not the 4000 lines of passing test names.
 */
export const failureFocusStrategy: OutputStrategy = {
  name: 'failure-focus',
  apply(text: string, ctx: CompressionContext): StrategyResult {
    if (!text || text.length < MIN_COMPRESS_BYTES) return { changed: false, text }

    const failed = ctx.exitCode !== undefined && ctx.exitCode !== 0
    const lines = text.split('\n')
    if (lines.length < 30) return { changed: false, text }

    if (!failed) {
      // Without an explicit fail signal, only fire if there's an obvious marker.
      const sample = text.slice(0, 8192) + text.slice(-8192)
      if (!FAILURE_LINE_REGEX.test(sample)) return { changed: false, text }
    }

    const keepIdx = new Set<number>()
    for (let i = 0; i < HEAD_TAIL_KEEP_LINES && i < lines.length; i++) keepIdx.add(i)
    for (let i = Math.max(0, lines.length - HEAD_TAIL_KEEP_LINES); i < lines.length; i++) {
      keepIdx.add(i)
    }
    for (let i = 0; i < lines.length; i++) {
      if (FAILURE_LINE_REGEX.test(lines[i])) {
        for (let k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 3); k++) {
          keepIdx.add(k)
        }
      }
    }

    if (keepIdx.size >= lines.length) return { changed: false, text }

    const out: string[] = []
    let lastKept = -1
    let droppedRun = 0
    for (let i = 0; i < lines.length; i++) {
      if (keepIdx.has(i)) {
        if (droppedRun > 0) {
          out.push(`… (${droppedRun} lines omitted)`)
          droppedRun = 0
        }
        out.push(lines[i])
        lastKept = i
      } else {
        droppedRun++
      }
    }
    if (droppedRun > 0) {
      out.push(`… (${droppedRun} lines omitted)`)
    }
    void lastKept

    const result = out.join('\n')
    if (result.length >= text.length) return { changed: false, text }
    return {
      changed: true,
      text: result,
      hint: `kept ${keepIdx.size}/${lines.length} lines around failures`
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 5. StatsExtraction
// ───────────────────────────────────────────────────────────────────────────

/**
 * Detect a test/build summary line and lift it to the top, dropping the bulk
 * of the body if the run was successful and the body is large.
 *
 * Patterns:
 *   - vitest:   "Tests  X passed (X)" / "Test Files  X passed (X)"
 *   - jest:     "Tests:       X passed, X total"
 *   - cargo:    "test result: ok. X passed; 0 failed; ..."
 *   - npm:      "npm warn deprecated ..." (skip)
 *   - tsc:      "Found 0 errors. Watching for file changes."
 *   - generic:  "X passed", "X tests passed"
 */
const STATS_PATTERNS: RegExp[] = [
  /^\s*Tests\s+\d+\s+passed/m,
  /^\s*Test\s+Files\s+\d+\s+passed/m,
  /^\s*Tests:\s+\d+\s+passed/m,
  /test\s+result:\s+(ok|FAILED)\.\s+\d+\s+passed/m,
  /Found\s+\d+\s+errors?\b/m,
  /^\s*\d+\s+(tests?|specs?|examples?)\s+passed/m,
  /Compiled\s+(successfully|with\s+\d+\s+warnings?)/m,
  /Build\s+(complete|succeeded|failed)/m
]

export const statsExtractionStrategy: OutputStrategy = {
  name: 'stats-extraction',
  apply(text: string, ctx: CompressionContext): StrategyResult {
    if (!text || text.length < MIN_COMPRESS_BYTES) return { changed: false, text }
    const lines = text.split('\n')
    if (lines.length < 50) return { changed: false, text }

    // Don't fire if exit code says failure (FailureFocus owns that case).
    if (ctx.exitCode !== undefined && ctx.exitCode !== 0) {
      return { changed: false, text }
    }

    const matches: string[] = []
    for (const pat of STATS_PATTERNS) {
      const m = pat.exec(text)
      if (m) matches.push(m[0])
    }
    if (matches.length === 0) return { changed: false, text }

    // Keep the head (first 10 lines, e.g. command + setup) + summary line(s) +
    // last 5 lines (final status).
    const head = lines.slice(0, 10)
    const tail = lines.slice(-HEAD_TAIL_KEEP_LINES)
    const out = [
      ...head,
      `… (${lines.length - head.length - tail.length} lines omitted; summary: ${matches.join(' · ')})`,
      ...tail
    ]
    const result = out.join('\n')
    if (result.length >= text.length) return { changed: false, text }
    return {
      changed: true,
      text: result,
      hint: `extracted ${matches.length} stats line(s)`
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Default pipeline factory
// ───────────────────────────────────────────────────────────────────────────

export const DEFAULT_STRATEGIES: ReadonlyArray<OutputStrategy> = Object.freeze([
  ansiStripStrategy,
  progressDedupStrategy,
  ndjsonSummaryStrategy,
  failureFocusStrategy,
  statsExtractionStrategy
])
