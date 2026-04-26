/**
 * hub-controller: single owner of the hub-mode lifecycle.
 *
 * Wires HubRegistry + HubBridge + HubServer + TunnelService together and
 * exposes a small surface area to the IPC layer:
 *
 *   const ctrl = createHubController({ runtimeManager, mainWindow })
 *   await ctrl.start()       // hub-server starts on default port
 *   await ctrl.stop()
 *   ctrl.startTunnel()       // spawn cloudflared
 *   ctrl.stopTunnel()
 *   ctrl.getStatus()         // snapshot for the renderer
 *   ctrl.on('status', cb)    // emits whenever hub/tunnel state changes
 *
 * Mobile-originated prompts are forwarded straight to the runtime — the
 * earlier desktop-confirm gate has been removed in favor of an IM-style
 * flow. Authentication on the hub websocket is the only barrier.
 */

import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { app, type BrowserWindow } from 'electron'
import { getDatabase } from '../../db/database'
import type { AgentRuntimeManager } from '../agent-runtime-manager'
import { getClaudeTranscriptPath } from '../claude-transcript-reader'
import {
  createHubBridge,
  wrapBrowserWindow,
  type HubBridge
} from './hub-bridge'
import { HubRegistry } from './hub-registry'
import {
  createHubServer,
  DEFAULT_HUB_PORT,
  setHubAuthMode,
  setHubCfAccessEmails,
  setHubTunnelUrl,
  type HubAuthMode,
  type HubServer,
  type HubServerStatus
} from './hub-server'
import { TunnelService, type TunnelStatus } from './tunnel-service'
import { createLogger } from '../logger'
import { hashPassword, verifyPassword } from './hub-auth'

const log = createLogger({ component: 'HubController' })

export interface HubControllerOptions {
  runtimeManager: AgentRuntimeManager
  /**
   * The renderer's BrowserWindow. The controller wraps it via
   * `wrapBrowserWindow()` so agent IPC events fan out to mobile clients
   * without touching individual implementers.
   */
  mainWindow: BrowserWindow
  /**
   * Defaults to 8317. Override for tests.
   */
  defaultPort?: number
}

export interface HubStatusSnapshot {
  enabled: boolean
  port: number | null
  host: string | null
  authMode: HubAuthMode
  tunnel: TunnelStatus
  hasAdmin: boolean
  /** Only set when no admin exists yet. */
  setupKey: string | null
}

export class HubController extends EventEmitter {
  readonly registry: HubRegistry
  readonly bridge: HubBridge
  readonly server: HubServer
  readonly tunnel: TunnelService
  /** Wrapped window — pass this to runtimeManager.setMainWindow() in main. */
  readonly wrappedWindow: BrowserWindow
  private readonly defaultPort: number
  private currentTunnel: TunnelStatus = { state: 'stopped' }

  constructor(opts: HubControllerOptions) {
    super()
    this.defaultPort = opts.defaultPort ?? DEFAULT_HUB_PORT

    this.registry = new HubRegistry()

    this.bridge = createHubBridge({
      registry: this.registry,
      runtimeManager: opts.runtimeManager,
      // No callsite ever invokes registerSessionRouting() in M1 — the bridge
      // would always answer SESSION_NOT_FOUND otherwise. Resolution order:
      // (1) try every implementer's in-memory `findRoutingByHive` for a
      //     desktop-opened session, (2) if all miss, read DB sessions row to
      //     pick the right runtime by `agent_sdk` and lazy-materialize via
      //     reconnect(). Returning the runtime id alongside the routing tuple
      //     lets the bridge dispatch inbound prompts to the correct runtime
      //     instead of always defaulting to claude-code.
      routingResolver: async (hiveSessionId) => {
        const runtimeIds = ['claude-code', 'codex', 'opencode'] as const
        try {
          // (1) in-memory scan across runtimes
          for (const rid of runtimeIds) {
            const impl = this.tryGetImplementer(opts.runtimeManager, rid)
            const live = (
              impl as unknown as {
                findRoutingByHive?: (
                  h: string
                ) => { worktreePath: string; agentSessionId: string } | null
              }
            )?.findRoutingByHive?.(hiveSessionId)
            if (live) {
              return { ...live, runtimeId: rid }
            }
          }
          // (2) DB lookup → pick implementer by agent_sdk → reconnect
          return await this.lazyMaterialize(opts.runtimeManager, hiveSessionId)
        } catch (err) {
          log.warn('routingResolver: lookup failed', {
            hiveSessionId,
            error: err instanceof Error ? err.message : String(err)
          })
          return null
        }
      }
    })

    this.wrappedWindow = wrapBrowserWindow(opts.mainWindow, this.bridge)

    this.server = createHubServer({
      db: getDatabase().getDb(),
      registry: this.registry,
      bridge: this.bridge,
      getMobileDistRoot: defaultMobileDistRoot
    })

    this.tunnel = new TunnelService()
    this.tunnel.on('statusChange', (s) => {
      this.currentTunnel = s
      // Persist tunnel URL so /api/config + WS-origin allowlist see it.
      try {
        if (s.state === 'running') setHubTunnelUrl(getDatabase().getDb(), s.url)
        else if (s.state === 'stopped' || s.state === 'error') {
          setHubTunnelUrl(getDatabase().getDb(), null)
        }
      } catch (err) {
        log.warn('failed to persist tunnel url', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
      this.emit('status', this.getStatus())
    })
  }

  async start(): Promise<HubServerStatus> {
    const status = await this.server.start(this.defaultPort)
    this.emit('status', this.getStatus())
    return status
  }

  async stop(): Promise<void> {
    await this.tunnel.stop()
    await this.server.stop()
    this.emit('status', this.getStatus())
  }

  startTunnel(): TunnelStatus {
    const status = this.server.status()
    if (!status.running || status.port === null || status.host === null) {
      const err: TunnelStatus = { state: 'error', message: 'hub server not running' }
      return err
    }
    return this.tunnel.start(status.port, status.host)
  }

  async stopTunnel(): Promise<void> {
    await this.tunnel.stop()
  }

  getStatus(): HubStatusSnapshot {
    const db = getDatabase().getDb()
    const adminCount = (db.prepare('SELECT COUNT(*) as n FROM hub_users').get() as { n: number })
      .n
    const hasAdmin = adminCount > 0
    const setupKey = hasAdmin ? null : this.server.ensureSetupKey()
    const setting = (key: string): string | null => {
      const row = db.prepare('SELECT value FROM hub_settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined
      return row?.value ?? null
    }
    const authMode = (setting('auth_mode') as HubAuthMode | null) ?? 'password'
    const serverStatus = this.server.status()
    return {
      enabled: serverStatus.running,
      port: serverStatus.port,
      host: serverStatus.host,
      authMode,
      tunnel: this.currentTunnel,
      hasAdmin,
      setupKey
    }
  }

  // ─── settings (delegated to hub-server helpers) ───────────────────────────

  setAuthMode(mode: HubAuthMode): void {
    setHubAuthMode(getDatabase().getDb(), mode)
    this.emit('status', this.getStatus())
  }

  setCfAccessEmails(emails: readonly string[]): void {
    setHubCfAccessEmails(getDatabase().getDb(), emails)
    this.emit('status', this.getStatus())
  }

  // ─── users ────────────────────────────────────────────────────────────────

  async createInitialAdmin(input: {
    setupKey: string
    username: string
    password: string
  }): Promise<{ success: boolean; error?: string }> {
    const db = getDatabase().getDb()
    const adminCount = (db.prepare('SELECT COUNT(*) as n FROM hub_users').get() as { n: number })
      .n
    if (adminCount > 0) return { success: false, error: 'admin already exists' }
    const expected = this.server.ensureSetupKey()
    if (!expected || input.setupKey !== expected) {
      return { success: false, error: 'bad setup key' }
    }
    const username = input.username.trim()
    if (!username || input.password.length < 8) {
      return { success: false, error: 'username required, password >= 8 chars' }
    }
    try {
      const hash = await hashPassword(input.password)
      db.prepare(
        'INSERT INTO hub_users(username, password_hash, created_at) VALUES(?, ?, ?)'
      ).run(username, hash, Date.now())
      this.emit('status', this.getStatus())
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'insert failed' }
    }
  }

  async changePassword(input: {
    username: string
    oldPassword: string
    newPassword: string
  }): Promise<{ success: boolean; error?: string }> {
    if (input.newPassword.length < 8) {
      return { success: false, error: 'new password must be >= 8 chars' }
    }
    const db = getDatabase().getDb()
    const row = db
      .prepare('SELECT id, password_hash FROM hub_users WHERE username = ?')
      .get(input.username) as { id: number; password_hash: string } | undefined
    if (!row) return { success: false, error: 'user not found' }
    const ok = await verifyPassword(input.oldPassword, row.password_hash)
    if (!ok) return { success: false, error: 'bad credentials' }
    const newHash = await hashPassword(input.newPassword)
    db.prepare('UPDATE hub_users SET password_hash = ? WHERE id = ?').run(newHash, row.id)
    return { success: true }
  }

  // ─── routing ──────────────────────────────────────────────────────────────

  /** Forget a session's routing — call when a session is destroyed. */
  forgetSession(hiveSessionId: string): void {
    this.bridge.forgetSession(hiveSessionId)
  }

  /** Tell the bridge how to resolve a hive session back to runtime args. */
  registerSessionRouting(
    hiveSessionId: string,
    worktreePath: string,
    agentSessionId: string
  ): void {
    this.bridge.registerSessionRouting(hiveSessionId, worktreePath, agentSessionId)
  }

  // ─── lazy materialization helpers ─────────────────────────────────────────

  private tryGetImplementer(
    mgr: AgentRuntimeManager,
    runtimeId: 'claude-code' | 'codex' | 'opencode'
  ): unknown {
    try {
      return mgr.getImplementer(runtimeId)
    } catch {
      return null
    }
  }

  /**
   * Look up `hiveSessionId` in SQLite, pick the implementer named in
   * `sessions.agent_sdk`, and call `reconnect()` so the bridge can route
   * inbound messages immediately. Returns null when no DB row exists, the
   * worktree is missing, the implementer doesn't exist, or reconnect throws.
   *
   * For claude-code we additionally probe the on-disk transcript: if the
   * stored `opencode_session_id` (which doubles as the claude SDK id) has no
   * transcript file, claude's `--resume` would crash with "No conversation
   * found", so we synthesize a `pending::` placeholder instead — the next
   * prompt will start a fresh claude session under the same hiveSessionId.
   */
  private async lazyMaterialize(
    mgr: AgentRuntimeManager,
    hiveSessionId: string
  ): Promise<{
    worktreePath: string
    agentSessionId: string
    runtimeId: 'claude-code' | 'codex' | 'opencode'
  } | null> {
    const db = getDatabase()
    const session = db.getSession(hiveSessionId)
    if (!session || !session.worktree_id) return null
    const wt = db.getWorktree(session.worktree_id)
    if (!wt) return null
    const worktreePath = wt.path
    const rawSdk = (session as unknown as { agent_sdk?: string }).agent_sdk
    const runtimeId =
      rawSdk === 'claude-code' || rawSdk === 'codex' || rawSdk === 'opencode'
        ? rawSdk
        : 'claude-code'

    const impl = this.tryGetImplementer(mgr, runtimeId) as {
      reconnect?: (
        worktreePath: string,
        agentSessionId: string,
        hiveSessionId: string
      ) => Promise<unknown>
    } | null
    if (!impl?.reconnect) {
      log.warn('lazyMaterialize: implementer missing reconnect', {
        hiveSessionId,
        runtimeId
      })
      return null
    }

    let agentSessionId =
      session.opencode_session_id && session.opencode_session_id.length > 0
        ? session.opencode_session_id
        : `pending::synth-${randomUUID()}`

    if (runtimeId === 'claude-code' && !agentSessionId.startsWith('pending::')) {
      // Claude requires the transcript JSONL on disk for `--resume`.
      // Synthesize a pending id when it's missing so the next prompt starts
      // fresh instead of crashing with "No conversation found".
      try {
        const path = getClaudeTranscriptPath(worktreePath, agentSessionId)
        if (!existsSync(path)) {
          log.info('lazyMaterialize: claude transcript missing, falling back to fresh', {
            hiveSessionId,
            agentSessionId,
            transcriptPath: path
          })
          agentSessionId = `pending::synth-${randomUUID()}`
        }
      } catch {
        agentSessionId = `pending::synth-${randomUUID()}`
      }
    }

    try {
      const result = await impl.reconnect(worktreePath, agentSessionId, hiveSessionId)
      if (!result?.success) {
        log.warn('lazyMaterialize: reconnect returned unsuccessful result', {
          hiveSessionId,
          runtimeId,
          worktreePath,
          agentSessionId
        })
        return null
      }
    } catch (err) {
      log.warn('lazyMaterialize: reconnect failed', {
        hiveSessionId,
        runtimeId,
        worktreePath,
        agentSessionId,
        error: err instanceof Error ? err.message : String(err)
      })
      return null
    }
    return { worktreePath, agentSessionId, runtimeId }
  }
}

let singleton: HubController | null = null

export function getHubController(): HubController | null {
  return singleton
}

export function createHubController(opts: HubControllerOptions): HubController {
  singleton = new HubController(opts)
  return singleton
}

/**
 * Resolve the mobile UI dist directory:
 *  - packaged: process.resourcesPath/mobile-ui (electron-builder copies it via
 *    extraResources, see #47)
 *  - dev: <repo>/mobile/dist  (run `pnpm build:mobile` first; or visit
 *    http://<laptop-ip>:5173 directly when running `pnpm dev:mobile`)
 *
 * Returns null if no dist exists yet — hub-server falls back to 404 then,
 * which is fine in dev because users hit the standalone Vite dev server.
 */
function defaultMobileDistRoot(): string | null {
  const candidates: string[] = []
  if (app.isPackaged && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'mobile-ui'))
  }
  candidates.push(path.join(process.cwd(), 'mobile', 'dist'))
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}
