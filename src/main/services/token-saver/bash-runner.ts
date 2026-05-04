/**
 * BashCommandRunner — Token Saver stage 2.
 *
 * A focused, dependency-light wrapper around `child_process.spawn` that gives
 * us the parts of the SDK's built-in Bash semantics we actually need to honor
 * once we're shadowing it via MCP:
 *
 *   - Run a single shell command with a configurable timeout
 *   - Collect stdout + stderr separately AND in interleaved order
 *   - Honor an AbortSignal so the agent's interrupt path can kill the process
 *   - Use a configurable cwd (per-session worktree path)
 *   - Use a configurable env (defaults to inherit; tests override)
 *   - Cap output buffer size to protect main process memory (very large
 *     outputs are still archived in full by the offload-store, but this
 *     buffer is only what we keep in RAM for compression)
 *
 * NOT yet handled (deferred):
 *   - run_in_background (background tasks with task IDs) — stage 4
 *   - dangerouslyDisableSandbox — we never sandbox; flag is no-op
 *   - macOS sandbox (sandbox-exec) — handled higher up if at all
 *
 * The runner does NOT do compression itself. Composition:
 *
 *     const result = await runBashCommand({...})
 *     await offloadStore.write({ sessionId, body: result.combined })
 *     const compressed = pipeline.run(result.combined, { exitCode: result.exitCode })
 *     return { ...compressed, archive }
 */
import { spawn } from 'node:child_process'

export interface RunBashOptions {
  /** Shell command to execute. Run via `/bin/sh -c <command>` on POSIX. */
  command: string
  /** Working directory. REQUIRED — explicit > inherited surprise. */
  cwd: string
  /** Environment variables. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Timeout in ms. Default 120_000. Hard upper bound is 600_000. */
  timeoutMs?: number
  /** Caller-provided abort signal. SIGTERM → SIGKILL escalation handled. */
  signal?: AbortSignal
  /**
   * Hard cap on bytes retained in memory per stream. Default 4 MiB.
   * If exceeded, output is truncated with a marker; full text still flows
   * to the optional `tee` callback for archival.
   */
  maxBufferBytes?: number
  /**
   * Optional callback invoked for each chunk (stdout or stderr) with the
   * raw bytes. Used by the MCP wrapper to stream into ContextOffloadStore
   * without doubling memory.
   */
  tee?: (chunk: Buffer, stream: 'stdout' | 'stderr') => void
}

export interface RunBashResult {
  /** Process exit code. -1 if killed by signal. */
  exitCode: number
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /** UTF-8 stdout (truncated at maxBufferBytes; `truncated.stdout=true` if so). */
  stdout: string
  /** UTF-8 stderr (truncated at maxBufferBytes; `truncated.stderr=true` if so). */
  stderr: string
  /**
   * Combined view: stdout + a separator + stderr. Used for archival and
   * for compression context. Order is "all stdout, then all stderr" — we
   * do NOT interleave by arrival because chunk timing is unreliable across
   * platforms.
   */
  combined: string
  truncated: { stdout: boolean; stderr: boolean }
  /** True if killed because the timeout fired. */
  timedOut: boolean
  /** True if killed because the caller's AbortSignal fired. */
  aborted: boolean
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024 // 4 MiB
const KILL_GRACE_MS = 1_500 // SIGTERM → wait → SIGKILL escalation

export async function runBashCommand(options: RunBashOptions): Promise<RunBashResult> {
  if (!options.command || typeof options.command !== 'string') {
    throw new Error('runBashCommand: command is required')
  }
  if (!options.cwd || typeof options.cwd !== 'string') {
    throw new Error('runBashCommand: cwd is required')
  }
  const timeoutMs = clamp(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS)
  const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER
  const tee = options.tee

  return new Promise<RunBashResult>((resolve, reject) => {
    const startedAt = Date.now()

    let child
    try {
      child = spawn('/bin/sh', ['-c', options.command], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let aborted = false

    const timeoutHandle = setTimeout(() => {
      timedOut = true
      escalateKill(child)
    }, timeoutMs)

    const onAbort = (): void => {
      aborted = true
      escalateKill(child)
    }
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (tee) {
        try {
          tee(chunk, 'stdout')
        } catch {
          // tee errors must not break the runner
        }
      }
      if (stdoutBytes < maxBuffer) {
        const remaining = maxBuffer - stdoutBytes
        if (chunk.length <= remaining) {
          stdoutChunks.push(chunk)
          stdoutBytes += chunk.length
        } else {
          stdoutChunks.push(chunk.subarray(0, remaining))
          stdoutBytes += remaining
          stdoutTruncated = true
        }
      } else {
        stdoutTruncated = true
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (tee) {
        try {
          tee(chunk, 'stderr')
        } catch {
          // tee errors must not break the runner
        }
      }
      if (stderrBytes < maxBuffer) {
        const remaining = maxBuffer - stderrBytes
        if (chunk.length <= remaining) {
          stderrChunks.push(chunk)
          stderrBytes += chunk.length
        } else {
          stderrChunks.push(chunk.subarray(0, remaining))
          stderrBytes += remaining
          stderrTruncated = true
        }
      } else {
        stderrTruncated = true
      }
    })

    child.on('error', (err) => {
      clearTimeout(timeoutHandle)
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
      reject(err)
    })

    child.on('close', (code, signalName) => {
      clearTimeout(timeoutHandle)
      if (options.signal) options.signal.removeEventListener('abort', onAbort)

      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')

      // Build combined view. Mark truncation explicitly so the agent knows.
      const parts: string[] = []
      if (stdout.length > 0) {
        parts.push(stdout + (stdoutTruncated ? '\n[stdout truncated]' : ''))
      }
      if (stderr.length > 0) {
        if (parts.length > 0) parts.push('--- stderr ---')
        parts.push(stderr + (stderrTruncated ? '\n[stderr truncated]' : ''))
      }
      const combined = parts.join('\n')

      const exitCode =
        typeof code === 'number'
          ? code
          : signalName
            ? -1
            : 0

      resolve({
        exitCode,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        combined,
        truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
        timedOut,
        aborted
      })
    })
  })
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.min(Math.max(Math.floor(n), lo), hi)
}

/**
 * Escalation: SIGTERM first, then SIGKILL after a grace window if still alive.
 * This matches the SDK's built-in Bash behavior and avoids leaving zombie
 * processes when the agent interrupts mid-execution.
 */
function escalateKill(child: import('node:child_process').ChildProcess): void {
  if (!child.pid || child.killed) return
  try {
    child.kill('SIGTERM')
  } catch {
    // already gone
    return
  }
  setTimeout(() => {
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
  }, KILL_GRACE_MS).unref()
}
