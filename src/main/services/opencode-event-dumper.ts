/**
 * OpenCode event dumper.
 *
 * Purpose:
 * - Capture enough evidence from OpenCode sessions that we can debug
 *   plan/todo/question/approval/token/compaction behavior after a manual run
 *   without relying on user recollection.
 * - Keep data OUT of the regular xuanpu log file; event streams can be noisy.
 * - Make analysis dead simple: one NDJSON line per record.
 *
 * Default behavior:
 * - Enabled automatically in development (NODE_ENV === 'development')
 * - Can be forced on/off with XUANPU_DUMP_OPENCODE_EVENTS=1/0
 * - Output directory defaults to ~/.xuanpu/logs, overridable with
 *   XUANPU_DUMP_OPENCODE_DIR
 *
 * File format:
 *   ~/.xuanpu/logs/opencode-events-<sessionKey|boot>-<ts>.ndjson
 *
 * Record shapes:
 *   { ts, kind: 'sdk_event', sessionKey, payload }
 *   { ts, kind: 'canonical_event', sessionKey, payload }
 *   { ts, kind: 'marker', sessionKey, payload }
 */
import { appendFileSync, mkdirSync, openSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENV_FLAG = 'XUANPU_DUMP_OPENCODE_EVENTS'

function isEnabled(): boolean {
  const value = process.env[ENV_FLAG]
  if (value) {
    return value !== '0' && value.toLowerCase() !== 'false'
  }
  return process.env.NODE_ENV === 'development'
}

function sanitizeKey(key: string | undefined): string {
  if (!key || key.length === 0) return 'boot'
  return key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
}

export interface OpenCodeEventDumper {
  recordSdkEvent(sessionKey: string | undefined, payload: unknown): void
  recordCanonicalEvent(sessionKey: string | undefined, payload: unknown): void
  recordMarker(sessionKey: string | undefined, payload: unknown): void
}

class FileDumper implements OpenCodeEventDumper {
  private files = new Map<string, number>()
  private dir: string

  constructor() {
    this.dir = process.env.XUANPU_DUMP_OPENCODE_DIR ?? join(homedir(), '.xuanpu', 'logs')
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch {
      // best effort
    }
  }

  private fdFor(key: string): number | null {
    const sanitized = sanitizeKey(key)
    const existing = this.files.get(sanitized)
    if (existing !== undefined) return existing
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(this.dir, `opencode-events-${sanitized}-${ts}.ndjson`)
    try {
      const fd = openSync(path, 'a')
      this.files.set(sanitized, fd)
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

  private write(kind: 'sdk_event' | 'canonical_event' | 'marker', sessionKey: string | undefined, payload: unknown): void {
    const key = sanitizeKey(sessionKey)
    const fd = this.fdFor(key)
    if (fd === null) return
    try {
      appendFileSync(
        fd,
        `${JSON.stringify({ ts: new Date().toISOString(), kind, sessionKey: sessionKey ?? null, payload })}\n`
      )
    } catch {
      /* ignore */
    }
  }

  recordSdkEvent(sessionKey: string | undefined, payload: unknown): void {
    this.write('sdk_event', sessionKey, payload)
  }

  recordCanonicalEvent(sessionKey: string | undefined, payload: unknown): void {
    this.write('canonical_event', sessionKey, payload)
  }

  recordMarker(sessionKey: string | undefined, payload: unknown): void {
    this.write('marker', sessionKey, payload)
  }
}

let cached: OpenCodeEventDumper | null | undefined

export function getOpenCodeEventDumper(): OpenCodeEventDumper | null {
  if (cached !== undefined) return cached
  cached = isEnabled() ? new FileDumper() : null
  return cached
}

export function __resetOpenCodeEventDumper(): void {
  cached = undefined
}
