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
 *   ctrl.respondConfirmation(confirmId, true)
 *   ctrl.on('status', cb)    // emits whenever hub/tunnel state changes
 *   ctrl.on('confirmation', cb)  // mobile-originated prompt awaiting approval
 *
 * The PromptConfirmer plumbed into HubBridge is backed by a Map of pending
 * confirmations. The desktop UI pulls them via `pendingConfirmations()` (or
 * subscribes to the `confirmation` event) and resolves them via
 * `respondConfirmation()`. CONFIRM_TIMEOUT_MS in HubBridge guarantees
 * stragglers never leak.
 */

import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import path from 'path'
import { app, type BrowserWindow } from 'electron'
import { getDatabase } from '../../db/database'
import type { AgentRuntimeManager } from '../agent-runtime-manager'
import {
  createHubBridge,
  wrapBrowserWindow,
  type HubBridge,
  type PromptConfirmer
} from './hub-bridge'
import { HubRegistry } from './hub-registry'
import {
  createHubServer,
  DEFAULT_HUB_PORT,
  setHubAuthMode,
  setHubCfAccessEmails,
  setHubRequireDesktopConfirm,
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

export interface PendingConfirmation {
  confirmId: string
  hiveSessionId: string
  preview: string
  createdAt: number
}

export interface HubStatusSnapshot {
  enabled: boolean
  port: number | null
  host: string | null
  authMode: HubAuthMode
  requireDesktopConfirm: boolean
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
  private readonly pending = new Map<
    string,
    { meta: PendingConfirmation; resolve: (v: { approved: boolean; reason?: string }) => void }
  >()
  private currentTunnel: TunnelStatus = { state: 'stopped' }

  constructor(opts: HubControllerOptions) {
    super()
    this.defaultPort = opts.defaultPort ?? DEFAULT_HUB_PORT

    this.registry = new HubRegistry()

    const confirmer: PromptConfirmer = {
      confirm: (req) =>
        new Promise((resolve) => {
          const meta: PendingConfirmation = {
            confirmId: req.confirmId,
            hiveSessionId: req.hiveSessionId,
            preview: req.preview,
            createdAt: Date.now()
          }
          this.pending.set(req.confirmId, { meta, resolve })
          this.emit('confirmation', meta)
        })
    }

    this.bridge = createHubBridge({
      registry: this.registry,
      runtimeManager: opts.runtimeManager,
      confirmer,
      // Read the live setting on each prompt so toggling the UI takes effect
      // immediately. Default to true (require confirm) when the setting is
      // missing or malformed — fail-safe.
      shouldConfirmPrompt: () => {
        try {
          const db = getDatabase().getDb()
          const row = db
            .prepare('SELECT value FROM hub_settings WHERE key = ?')
            .get('require_desktop_confirm') as { value: string } | undefined
          // Stored as '1' (on) or '0' (off). Anything else (including missing
          // row) is treated as on.
          return row?.value !== '0'
        } catch (err) {
          log.warn('shouldConfirmPrompt: failed to read setting, defaulting to true', {
            error: err instanceof Error ? err.message : String(err)
          })
          return true
        }
      },
      // No callsite ever invokes registerSessionRouting() in M1 — the bridge
      // would always answer SESSION_NOT_FOUND otherwise. Fall back to asking
      // the runtime by hiveSessionId so any desktop-opened session is
      // controllable from the mobile UI without extra plumbing.
      routingResolver: (hiveSessionId) => {
        try {
          const impl = opts.runtimeManager.getImplementer('claude-code') as unknown as {
            findRoutingByHive?: (
              h: string
            ) => { worktreePath: string; agentSessionId: string } | null
          }
          return impl.findRoutingByHive?.(hiveSessionId) ?? null
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
    const requireDesktopConfirm = setting('require_desktop_confirm') !== '0'
    const serverStatus = this.server.status()
    return {
      enabled: serverStatus.running,
      port: serverStatus.port,
      host: serverStatus.host,
      authMode,
      requireDesktopConfirm,
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

  setRequireDesktopConfirm(value: boolean): void {
    setHubRequireDesktopConfirm(getDatabase().getDb(), value)
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

  // ─── pending confirmations ────────────────────────────────────────────────

  pendingConfirmations(): PendingConfirmation[] {
    return Array.from(this.pending.values()).map((e) => e.meta)
  }

  respondConfirmation(confirmId: string, approve: boolean, reason?: string): boolean {
    const entry = this.pending.get(confirmId)
    if (!entry) return false
    this.pending.delete(confirmId)
    entry.resolve({ approved: approve, reason })
    return true
  }

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
