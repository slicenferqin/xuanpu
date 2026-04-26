/**
 * Codex JSON-RPC frame dumper.
 *
 * Gated by env XUANPU_DUMP_CODEX_RPC. When enabled, every JSON-RPC frame
 * (in/out) is appended to ~/.xuanpu/logs/codex-rpc-<threadId|boot>-<ts>.ndjson,
 * one frame per line:
 *
 *   {"ts":"2026-04-26T01:23:45.678Z","dir":"in","threadId":"019d…","raw":"…"}
 *
 * Read with `pnpm tsx scripts/dump-codex-rpc.ts <file>`.
 *
 * Why a sibling module instead of the existing logger:
 *   - We need the *raw* JSON-RPC line, not a structured snapshot.
 *   - We do not want this in the regular xuanpu log (multi-MB per session).
 *   - We want an off switch with literally zero runtime cost when disabled.
 */
import { appendFileSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENV_FLAG = 'XUANPU_DUMP_CODEX_RPC'

function isEnabled(): boolean {
  const value = process.env[ENV_FLAG]
  if (!value) return false
  return value !== '0' && value.toLowerCase() !== 'false'
}

export interface CodexRpcDumper {
  recordIn(threadId: string | undefined, line: string): void
  recordOut(threadId: string | undefined, line: string): void
}

class FileDumper implements CodexRpcDumper {
  private files = new Map<string, number>() // key (threadId or 'boot') → fd
  private dir: string

  constructor() {
    this.dir = process.env.XUANPU_DUMP_CODEX_DIR ?? join(homedir(), '.xuanpu', 'logs')
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch {
      // best effort
    }
  }

  private fdFor(key: string): number | null {
    const existing = this.files.get(key)
    if (existing !== undefined) return existing
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(this.dir, `codex-rpc-${key}-${ts}.ndjson`)
    try {
      const fd = openSync(path, 'a')
      this.files.set(key, fd)
      // Close on exit so OS flushes.
      // Multiple FileDumper handlers attach harmlessly.
      process.once('exit', () => {
        try {
          closeSync(fd)
        } catch {
          /* ignore */
        }
      })
      return fd
    } catch {
      return null
    }
  }

  private write(direction: 'in' | 'out', threadId: string | undefined, line: string): void {
    const key = threadId && threadId.length > 0 ? threadId : 'boot'
    const fd = this.fdFor(key)
    if (fd === null) return
    const frame = JSON.stringify({
      ts: new Date().toISOString(),
      dir: direction,
      threadId: threadId ?? null,
      raw: line
    })
    try {
      appendFileSync(fd, `${frame}\n`)
    } catch {
      /* ignore */
    }
  }

  recordIn(threadId: string | undefined, line: string): void {
    this.write('in', threadId, line)
  }
  recordOut(threadId: string | undefined, line: string): void {
    this.write('out', threadId, line)
  }
}

let cached: CodexRpcDumper | null | undefined

/** Returns a singleton dumper, or null if XUANPU_DUMP_CODEX_RPC is not set. */
export function getCodexRpcDumper(): CodexRpcDumper | null {
  if (cached !== undefined) return cached
  cached = isEnabled() ? new FileDumper() : null
  return cached
}

/** @internal — for tests */
export function __resetCodexRpcDumper(): void {
  cached = undefined
}
