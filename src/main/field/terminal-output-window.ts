/**
 * Best-effort terminal.output capture for Phase 21.
 *
 * See docs/VISION.md §4.1.1 (P0 event `terminal.output`).
 *
 * Design (documented as best-effort, NOT a reliable command-output parser):
 *
 *   - Subscribe to the existing EventBus `terminal:data` / `terminal:exit`
 *     events (already emitted by terminal-handlers.ts for rendering).
 *   - For each worktree, maintain an accumulator window.
 *   - A new window starts on the first data chunk after:
 *       * a terminal.command for the same worktree, OR
 *       * the previous window closed.
 *   - A window closes (and emits a `terminal.output` field event) on:
 *       * size limit reached (256KB), reason='size'
 *       * time limit reached (30s), reason='time'
 *       * next terminal.command seen, reason='next-command'
 *       * terminal:exit seen, reason='exit', exitCode set
 *       * PTY destroyed (see clearTerminalOutputWindow), reason='destroy'
 *   - Truncation: keep first HEAD_LINES lines + last TAIL_LINES lines;
 *     middle is elided and truncated=true.
 *   - commandEventId: the id of the most recent terminal.command for this
 *     worktree if recorded via recordCommandEventId(); else null.
 *
 * Known limitations (documented, not fixed):
 *   - Output from interactive TUIs (vim, less, htop) will be captured as
 *     "output", even though it's not in the terminal.command → output shape.
 *   - ANSI escape sequences are NOT stripped before line counting; a
 *     redraw-heavy TUI may show inflated line counts.
 *   - Long-running commands producing >256KB in <30s will emit multiple
 *     "chunks" of one logical run; commandEventId links them all to the same
 *     command, but window close reason will be 'size' for the early ones.
 */
import { getEventBus } from '../../server/event-bus'
import { createLogger } from '../services/logger'
import { emitFieldEvent } from './emit'
import { getDatabase } from '../db'

const log = createLogger({ component: 'TerminalOutputWindow' })

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const MAX_WINDOW_BYTES = 256 * 1024 // 256KB
const MAX_WINDOW_MS = 30_000
const HEAD_LINES = 20
const TAIL_LINES = 50

// ---------------------------------------------------------------------------
// Per-worktree state
// ---------------------------------------------------------------------------

interface OutputWindow {
  /** Raw bytes accumulated (cap 256KB). */
  buffer: string
  /** First timestamp seen in this window. */
  startedAt: number
  /** Whether `buffer` has been truncated by the size cap (future chunks drop). */
  overflowed: boolean
  /** Total bytes observed (including dropped-after-overflow). */
  totalBytes: number
  /** commandEventId associated with this window, if we've seen one. */
  commandEventId: string | null
  /** Timer that closes the window on time. Cleared when window closes. */
  timer: ReturnType<typeof setTimeout> | null
}

const windows = new Map<string, OutputWindow>()
// Last seen terminal.command event id per worktree (for correlation).
const lastCommandIdByWorktree = new Map<string, string>()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record that a terminal.command event was just emitted for this worktree.
 * Subsequent output will be correlated to this id.
 *
 * Also triggers close of any in-progress window (reason='next-command') so
 * the output is not mixed across commands.
 */
export function recordCommandEventId(worktreeId: string, commandEventId: string): void {
  closeWindow(worktreeId, 'next-command', null)
  lastCommandIdByWorktree.set(worktreeId, commandEventId)
}

/**
 * Discard any pending window for a worktree without emitting (e.g. PTY
 * destroyed via terminal:destroy).
 */
export function clearTerminalOutputWindow(worktreeId: string): void {
  closeWindow(worktreeId, 'destroy', null)
  lastCommandIdByWorktree.delete(worktreeId)
}

/**
 * Register subscriptions to the terminal EventBus. Call once at app startup.
 * Idempotent across multiple calls (guarded by a module-level flag).
 */
let subscribed = false
export function subscribeTerminalOutputBus(): void {
  if (subscribed) return
  subscribed = true
  const bus = getEventBus()

  bus.on('terminal:data', (worktreeId: string, data: string) => {
    try {
      appendToWindow(worktreeId, data)
    } catch (err) {
      log.warn('terminal:data handler failed', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })

  bus.on('terminal:exit', (worktreeId: string, code: number) => {
    try {
      closeWindow(worktreeId, 'exit', code)
      lastCommandIdByWorktree.delete(worktreeId)
    } catch (err) {
      log.warn('terminal:exit handler failed', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function appendToWindow(worktreeId: string, data: string): void {
  let w = windows.get(worktreeId)
  if (!w) {
    w = {
      buffer: '',
      startedAt: Date.now(),
      overflowed: false,
      totalBytes: 0,
      commandEventId: lastCommandIdByWorktree.get(worktreeId) ?? null,
      timer: null
    }
    windows.set(worktreeId, w)
    // Close on time
    w.timer = setTimeout(() => {
      closeWindow(worktreeId, 'time', null)
    }, MAX_WINDOW_MS)
  }

  w.totalBytes += data.length

  if (w.overflowed) return

  const room = MAX_WINDOW_BYTES - w.buffer.length
  if (data.length <= room) {
    w.buffer += data
    return
  }
  // Size cap reached — take what fits, close the window, the remainder is dropped.
  w.buffer += data.slice(0, room)
  w.overflowed = true
  closeWindow(worktreeId, 'size', null)
}

function closeWindow(
  worktreeId: string,
  reason: 'size' | 'time' | 'next-command' | 'exit' | 'destroy',
  exitCode: number | null
): void {
  const w = windows.get(worktreeId)
  if (!w) {
    // No window open; for 'exit' we may still want to note exit code,
    // but without any output there's nothing to emit. Drop silently.
    return
  }
  windows.delete(worktreeId)
  if (w.timer) {
    clearTimeout(w.timer)
    w.timer = null
  }

  if (reason === 'destroy') {
    // User destroyed the terminal — don't emit, the window is incomplete noise.
    return
  }

  const { head, tail, truncated } = splitHeadTail(w.buffer)
  const projectId = getDatabase().getWorktree(worktreeId)?.project_id ?? null

  emitFieldEvent({
    type: 'terminal.output',
    worktreeId,
    projectId,
    sessionId: null,
    relatedEventId: w.commandEventId,
    payload: {
      commandEventId: w.commandEventId,
      head,
      tail,
      truncated,
      totalBytes: w.totalBytes,
      exitCode,
      reason
    }
  })
}

/**
 * Split output into a head + tail with the middle elided.
 * Returns `{ head, tail, truncated }`. If the full output already fits in
 * the head, tail is empty and truncated is false.
 */
function splitHeadTail(raw: string): { head: string; tail: string; truncated: boolean } {
  const lines = raw.split('\n')
  if (lines.length <= HEAD_LINES + TAIL_LINES) {
    return { head: raw, tail: '', truncated: false }
  }
  const head = lines.slice(0, HEAD_LINES).join('\n')
  const tail = lines.slice(-TAIL_LINES).join('\n')
  return { head, tail, truncated: true }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function __resetAllWindowsForTest(): void {
  for (const w of windows.values()) {
    if (w.timer) clearTimeout(w.timer)
  }
  windows.clear()
  lastCommandIdByWorktree.clear()
  subscribed = false
}

export const __TERMINAL_OUTPUT_TUNABLES_FOR_TEST = {
  MAX_WINDOW_BYTES,
  MAX_WINDOW_MS,
  HEAD_LINES,
  TAIL_LINES
}
