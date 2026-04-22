/**
 * Best-effort terminal command line capture for Phase 21.
 *
 * Per oracle review: this is NOT a reliable command parser. The `\r` heuristic
 * works adequately for simple interactive shell commands like `ls`,
 * `git status`, `pnpm test`. It does NOT reliably handle:
 *   - bracketed paste of multi-line commands
 *   - shell line continuations (`\` at EOL), heredocs, open quotes
 *   - arrow-key history navigation (escape sequences may pollute the buffer)
 *   - commands aborted via Ctrl+C (no completion event)
 *   - TUI applications (vim, less, htop)
 *
 * Phase 21 ships this with the explicit limitation. A reliable command
 * lifecycle requires shell-integration markers (OSC 133 etc.) — out of scope.
 *
 * See docs/prd/phase-21-field-events.md §4.2
 */

const MAX_BUFFER_BYTES = 4096

interface BufferState {
  /** Accumulated visible characters since the last \r. */
  buffer: string
  /** True once the buffer is full and we're discarding additional input. */
  overflowed: boolean
}

const buffers = new Map<string, BufferState>()

/**
 * Strip terminal control sequences from a chunk before line-buffering it.
 *   - Drops bytes < 0x20 except \t, \n, \r
 *   - Drops ESC-introduced sequences (CSI / OSC / SS3 / etc.)
 *   - Drops standalone DEL (0x7f) since it's a backspace, not a character
 *
 * This is intentionally simple. We don't attempt to *interpret* backspaces
 * (would require maintaining a cursor position) — we just don't include them
 * in the captured command line. As a result, commands edited heavily before
 * pressing Enter may end up garbled. That's acceptable for best-effort capture.
 */
function stripControl(input: string): string {
  let out = ''
  let i = 0
  while (i < input.length) {
    const ch = input.charCodeAt(i)

    // ESC introducer — skip the entire control sequence.
    if (ch === 0x1b) {
      // ESC [ … final-byte (0x40–0x7e) — CSI sequence
      if (input.charCodeAt(i + 1) === 0x5b /* [ */) {
        let j = i + 2
        while (j < input.length) {
          const c = input.charCodeAt(j)
          j++
          if (c >= 0x40 && c <= 0x7e) break
        }
        i = j
        continue
      }
      // ESC ] … BEL or ESC \ — OSC sequence
      if (input.charCodeAt(i + 1) === 0x5d /* ] */) {
        let j = i + 2
        while (j < input.length) {
          const c = input.charCodeAt(j)
          if (c === 0x07 /* BEL */) {
            j++
            break
          }
          if (c === 0x1b && input.charCodeAt(j + 1) === 0x5c /* \ */) {
            j += 2
            break
          }
          j++
        }
        i = j
        continue
      }
      // Other ESC … two-char sequences (ESC + one byte)
      i += 2
      continue
    }

    // Drop other control bytes except tab, newline, carriage return
    if (ch < 0x20 && ch !== 0x09 && ch !== 0x0a && ch !== 0x0d) {
      i++
      continue
    }

    // DEL (backspace key)
    if (ch === 0x7f) {
      i++
      continue
    }

    out += input[i]
    i++
  }
  return out
}

/**
 * Feed a chunk of PTY input into the per-worktree line buffer.
 *
 * Returns an array of completed command lines (each \r in the chunk yields
 * one line). The returned strings are trimmed; empty lines are skipped.
 *
 * Behavior:
 *   - On overflow (>4KB accumulated without \r), the buffer is discarded
 *     until the next \r and `onOverflow` is called once.
 */
export function feedTerminalInput(
  worktreeId: string,
  data: string,
  onOverflow?: () => void
): string[] {
  const cleaned = stripControl(data)
  if (cleaned.length === 0) return []

  let state = buffers.get(worktreeId)
  if (!state) {
    state = { buffer: '', overflowed: false }
    buffers.set(worktreeId, state)
  }

  const completedLines: string[] = []

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (ch === '\r') {
      if (!state.overflowed) {
        const line = state.buffer.trim()
        if (line.length > 0) completedLines.push(line)
      }
      state.buffer = ''
      state.overflowed = false
      continue
    }
    if (state.overflowed) continue

    state.buffer += ch
    if (state.buffer.length > MAX_BUFFER_BYTES) {
      state.overflowed = true
      state.buffer = ''
      if (onOverflow) onOverflow()
    }
  }

  return completedLines
}

/**
 * Drop the buffer for a worktree (e.g. when the PTY is destroyed).
 * Safe to call for unknown worktreeIds.
 */
export function clearTerminalBuffer(worktreeId: string): void {
  buffers.delete(worktreeId)
}

/** Test helper. */
export function __resetAllBuffersForTest(): void {
  buffers.clear()
}

export const __TUNABLES_FOR_TEST = { MAX_BUFFER_BYTES }
