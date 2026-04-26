/**
 * tunnel-service: manages a `cloudflared tunnel --url http://<host>:<port>`
 * child process and surfaces the quick-tunnel URL it prints.
 *
 * Quick tunnels are anonymous; they don't require a Cloudflare account. The
 * binary emits a URL like `https://random-words.trycloudflare.com` on stderr
 * once the tunnel is up.
 *
 * Lifecycle:
 *
 *   stopped ──start()──► starting ──(url parsed)──► running{ url }
 *                              │                          │
 *                              └─ spawn error ─► error ◄──┘ (exit != 0)
 *
 * When `enabled` is still true after an unexpected exit we schedule a
 * restart with exponential backoff (1s → 3s → 9s), up to 3 attempts, then
 * transition to `error` and give up. Manual `stop()` clears enabled and
 * cancels any pending restart.
 *
 * The service is intentionally framework-agnostic: the caller injects a
 * `resolveBinary()` and `spawn()` so tests can drive it without a real
 * cloudflared binary on disk.
 */

import { spawn as nodeSpawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import path from 'path'
import { createLogger } from '../logger'

const log = createLogger({ component: 'TunnelService' })

export type TunnelStatus =
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'running'; url: string }
  | { state: 'error'; message: string }

export interface TunnelServiceEvents {
  statusChange: (status: TunnelStatus) => void
}

export interface TunnelServiceOptions {
  /** Returns absolute path to cloudflared, or null if not bundled. */
  resolveBinary?: () => string | null
  /** Injection point for tests. Defaults to child_process.spawn. */
  spawn?: typeof nodeSpawn
  /** Milliseconds before the first backoff step. Defaults to 1000. */
  baseBackoffMs?: number
  /** Max auto-restarts per enable cycle. Defaults to 3. */
  maxRestarts?: number
  /** Override clock (for tests). */
  now?: () => number
  /** Scheduler override (for tests). Defaults to global setTimeout/clearTimeout. */
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}

/**
 * Regex matches stdout/stderr lines like:
 *   |  https://proud-brief-labs.trycloudflare.com
 * We match any `https://.*\.trycloudflare\.com` exactly.
 */
const TUNNEL_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i

export class TunnelService extends EventEmitter {
  private readonly resolveBinary: () => string | null
  private readonly spawnFn: typeof nodeSpawn
  private readonly baseBackoffMs: number
  private readonly maxRestarts: number
  private readonly setTimeoutFn: typeof setTimeout
  private readonly clearTimeoutFn: typeof clearTimeout

  private _status: TunnelStatus = { state: 'stopped' }
  private proc: ChildProcessWithoutNullStreams | null = null
  private localPort = 0
  private localHost = '127.0.0.1'
  private enabled = false
  private restartCount = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: TunnelServiceOptions = {}) {
    super()
    this.resolveBinary = opts.resolveBinary ?? defaultResolveCloudflaredBinary
    this.spawnFn = opts.spawn ?? nodeSpawn
    this.baseBackoffMs = opts.baseBackoffMs ?? 1000
    this.maxRestarts = opts.maxRestarts ?? 3
    this.setTimeoutFn = opts.setTimeout ?? setTimeout
    this.clearTimeoutFn = opts.clearTimeout ?? clearTimeout
  }

  get status(): TunnelStatus {
    return this._status
  }

  /**
   * Start the tunnel. If already starting/running, returns the current
   * status unchanged.
   */
  start(localPort: number, localHost = '127.0.0.1'): TunnelStatus {
    if (this._status.state === 'starting' || this._status.state === 'running') {
      return this._status
    }
    this.localPort = localPort
    this.localHost = localHost
    this.enabled = true
    this.restartCount = 0
    this.spawnOnce()
    return this._status
  }

  /** Stop the tunnel and prevent further auto-restarts. */
  async stop(): Promise<void> {
    this.enabled = false
    if (this.restartTimer) {
      this.clearTimeoutFn(this.restartTimer)
      this.restartTimer = null
    }
    const p = this.proc
    this.proc = null
    if (p && !p.killed) {
      await new Promise<void>((resolve) => {
        const onExit = (): void => resolve()
        p.once('exit', onExit)
        p.once('close', onExit)
        try {
          p.kill('SIGTERM')
          // Give cloudflared 2s to clean up, then SIGKILL.
          this.setTimeoutFn(() => {
            if (!p.killed) {
              try {
                p.kill('SIGKILL')
              } catch {
                /* ignore */
              }
            }
          }, 2000)
        } catch {
          resolve()
        }
      })
    }
    this.setStatus({ state: 'stopped' })
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private spawnOnce(): void {
    const bin = this.resolveBinary()
    if (!bin) {
      this.setStatus({
        state: 'error',
        message: 'cloudflared binary not found; tunnel feature unavailable'
      })
      this.enabled = false
      return
    }
    const originHost = this.localHost.includes(':') ? `[${this.localHost}]` : this.localHost
    // Force http2 instead of the default quic. cloudflared's quic transport uses
    // UDP/7844, which is silently dropped by many proxies/VPNs (notably the
    // tun-routed setups common on CN networks) — the connector then prints a
    // trycloudflare URL but never establishes an edge session, so visitors get
    // Cloudflare error 1033. http2 rides on TCP/443 and works wherever HTTPS does.
    const args = [
      'tunnel',
      '--no-autoupdate',
      '--protocol',
      'http2',
      '--url',
      `http://${originHost}:${this.localPort}`
    ]
    this.setStatus({ state: 'starting' })
    log.info('spawning cloudflared', { bin, host: this.localHost, port: this.localPort })

    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawnFn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env
      }) as unknown as ChildProcessWithoutNullStreams
    } catch (err) {
      this.handleFailure(err instanceof Error ? err.message : String(err))
      return
    }
    this.proc = child

    const onLine = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      if (this._status.state !== 'running') {
        const m = text.match(TUNNEL_URL_RE)
        if (m) {
          this.restartCount = 0 // success — reset backoff
          this.setStatus({ state: 'running', url: m[0] })
        }
      }
    }
    child.stdout.on('data', onLine)
    child.stderr.on('data', onLine)

    child.on('error', (err) => {
      this.handleFailure(err.message)
    })
    child.on('exit', (code, signal) => {
      log.info('cloudflared exited', { code, signal })
      if (this.proc !== child) return // stop() already swapped it out
      this.proc = null
      if (!this.enabled) {
        this.setStatus({ state: 'stopped' })
        return
      }
      // Unexpected exit — schedule backoff restart if we have attempts left.
      this.scheduleRestart(`cloudflared exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
    })
  }

  private scheduleRestart(reason: string): void {
    if (this.restartCount >= this.maxRestarts) {
      this.setStatus({
        state: 'error',
        message: `${reason}; giving up after ${this.maxRestarts} attempts`
      })
      this.enabled = false
      return
    }
    const delay = this.baseBackoffMs * Math.pow(3, this.restartCount)
    this.restartCount += 1
    log.warn('cloudflared restart scheduled', {
      attempt: this.restartCount,
      delayMs: delay,
      reason
    })
    this.setStatus({ state: 'starting' })
    this.restartTimer = this.setTimeoutFn(() => {
      this.restartTimer = null
      if (this.enabled) this.spawnOnce()
    }, delay)
  }

  private handleFailure(message: string): void {
    if (!this.enabled) {
      this.setStatus({ state: 'stopped' })
      return
    }
    this.scheduleRestart(message)
  }

  private setStatus(status: TunnelStatus): void {
    this._status = status
    this.emit('statusChange', status)
  }
}

// ─── Binary resolver ────────────────────────────────────────────────────────

/**
 * Walks the four shapes cloudflared can live in, in order:
 * 1. Packaged build: `process.resourcesPath/cloudflared/<platform>/cloudflared(.exe)`
 * 2. Dev mode: `<repo>/resources/cloudflared/<platform>/cloudflared(.exe)`
 * 3. `CLOUDFLARED_BIN` env override (absolute path).
 * 4. `PATH` lookup — last resort so devs can pre-install via homebrew.
 */
export function defaultResolveCloudflaredBinary(): string | null {
  const envOverride = process.env.CLOUDFLARED_BIN
  if (envOverride && existsSync(envOverride)) return envOverride

  const platform = detectPlatform()
  if (!platform) return null
  const binName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'

  const candidates: string[] = []
  // Packaged: process.resourcesPath is only set inside Electron.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'cloudflared', platform, binName))
  }
  // Dev mode: project root is 4 levels up from this file when transpiled
  // (out/main/services/hub/tunnel-service.js) — but using process.cwd() is
  // more reliable for dev scripts.
  candidates.push(path.join(process.cwd(), 'resources', 'cloudflared', platform, binName))

  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  // PATH fallback — last resort so devs can pre-install via homebrew
  // (`brew install cloudflared`) and packaged builds that somehow shipped
  // without the bundled binary still work if the user installed one.
  return resolveOnPath(binName)
}

/**
 * Look up `binName` on the user's $PATH. Uses `/usr/bin/which` on POSIX and
 * `where.exe` on Windows. Returns null when not found.
 *
 * Why not iterate process.env.PATH ourselves? `which`/`where` already handle
 * the per-shell quirks (PATHEXT on Windows, executable bits on POSIX) and
 * work even when PATH was inherited from the GUI launchd context (which
 * doesn't include /opt/homebrew/bin by default — there's nothing we can do
 * about that, but `which` will at least give a definitive answer).
 */
function resolveOnPath(binName: string): string | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : '/usr/bin/which'
    const result = spawnSync(cmd, [binName], { encoding: 'utf8' })
    if (result.status !== 0) return null
    const first = result.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
    return first && existsSync(first) ? first : null
  } catch {
    return null
  }
}

export function detectPlatform(): string | null {
  const arch = process.arch // 'arm64' | 'x64' | ...
  switch (process.platform) {
    case 'darwin':
      return arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64'
    case 'win32':
      return arch === 'arm64' ? 'windows-arm64' : 'windows-amd64'
    case 'linux':
      return arch === 'arm64' ? 'linux-arm64' : 'linux-amd64'
    default:
      return null
  }
}
