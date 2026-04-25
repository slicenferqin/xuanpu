/**
 * hub-server: node:http + ws.WebSocketServer for the Xuanpu Hub (M1).
 *
 * Listens on 127.0.0.1 only (loopback). Public exposure happens by spawning
 * `cloudflared` (#39) as a child process — never by binding 0.0.0.0.
 *
 * Designed to be DI-friendly so tests don't have to touch electron/app paths:
 *
 *   const server = createHubServer({
 *     db: getDatabase().getDb(),
 *     registry,
 *     bridge,                    // optional — when omitted the /ws/ui route 404s
 *     getMobileDistRoot: () => null  // tests usually don't serve static
 *   })
 *   await server.start(8317)
 *   ...
 *   await server.stop()
 *
 * Routes (all JSON, errors `{ error: { code, message } }`):
 *
 *   GET  /health
 *   GET  /api/setup/status                   { needsSetup, setupKey? }
 *   POST /api/setup        { setupKey, username, password }
 *   POST /api/login        { username, password }
 *   POST /api/logout
 *   GET  /api/me
 *   GET  /api/config                         { authMode, tunnelUrl }
 *   GET  /api/devices
 *   GET  /api/devices/:id/sessions
 *   GET  /api/sessions/:hiveId/history
 *   WS   /ws/ui/:deviceId/:hiveSessionId
 *
 * Auth modes (stored in hub_settings.auth_mode):
 *   - 'password' (default): cookie session required
 *   - 'cf_access':           Cf-Access-Authenticated-User-Email required + allowlisted
 *   - 'hybrid':              either of the above
 *
 * CSRF: state-changing requests must satisfy `isOriginAllowed`. The allowlist
 * is `[http://127.0.0.1:<port>, http://[::1]:<port>, <tunnelUrl?>]`. During
 * the very first /api/setup call we accept any origin so the desktop UI can
 * bootstrap before the hub knows its own port.
 */

import type { Database } from 'better-sqlite3'
import http, { type IncomingMessage, type ServerResponse } from 'http'
import { connect as netConnect, type Socket } from 'net'
import { promises as fs } from 'fs'
import path from 'path'
import { WebSocketServer, type WebSocket } from 'ws'
import { createLogger } from '../logger'
import {
  LoginRateLimiter,
  genCookieSessionId,
  genSetupKey,
  hashPassword,
  isCfAccessEmailAllowed,
  isOriginAllowed,
  readCfAccessEmail,
  verifyPassword
} from './hub-auth'
import type { HubBridge } from './hub-bridge'
import type { HubRegistry, HubSubscriber } from './hub-registry'

const log = createLogger({ component: 'HubServer' })

export const COOKIE_NAME = 'sh_session'
export const COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
export const DEFAULT_HUB_PORT = 8317
/**
 * How many ports past `DEFAULT_HUB_PORT` we're allowed to try before giving
 * up. Protects the host from a hub instance silently claiming a wildly
 * different port after the user's preferred port is taken. 20 is arbitrary
 * but large enough to dodge typical conflict clusters (e.g. several brew
 * services defaulting to 8317–8320).
 */
const PORT_FALLBACK_ATTEMPTS = 20

export type HubAuthMode = 'password' | 'cf_access' | 'hybrid'

const DEFAULT_AUTH_MODE: HubAuthMode = 'password'

const SETTING_KEYS = {
  authMode: 'auth_mode',
  requireDesktopConfirm: 'require_desktop_confirm',
  cfAccessEmails: 'cf_access_emails',
  tunnelUrl: 'tunnel_url'
} as const

// ─── deps ───────────────────────────────────────────────────────────────────

export interface HubServerOptions {
  db: Database
  registry: HubRegistry
  /** Optional — if absent, /ws/ui closes 1011. */
  bridge?: HubBridge
  /**
   * Returns absolute path to the mobile UI dist directory, or null when no
   * static UI is available (e.g. tests).
   */
  getMobileDistRoot?: () => string | null
  /** Override clock for tests. */
  now?: () => number
  /** Override rate-limiter (mostly for tests). */
  rateLimiter?: LoginRateLimiter
}

export interface HubServerStatus {
  running: boolean
  port: number | null
  host: string | null
}

// ─── helpers ────────────────────────────────────────────────────────────────

interface JsonError {
  status: number
  code: string
  message?: string
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers
  })
  res.end(payload)
}

function sendError(res: ServerResponse, e: JsonError): void {
  sendJson(res, e.status, { error: { code: e.code, message: e.message ?? e.code } })
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim()
  return req.socket.remoteAddress ?? 'unknown'
}

function setSessionCookie(res: ServerResponse, sid: string, maxAgeMs: number): void {
  // Loopback only — Secure/SameSite=Strict is fine; tunnel users already have
  // the cookie set on the loopback origin during login.
  const maxAgeSecs = Math.floor(maxAgeMs / 1000)
  const value = `${COOKIE_NAME}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSecs}`
  res.setHeader('set-cookie', value)
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('set-cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

// ─── settings & users ───────────────────────────────────────────────────────

interface UserRow {
  id: number
  username: string
  password_hash: string
  created_at: number
}

interface CookieSessionRow {
  id: string
  user_id: number
  created_at: number
  expires_at: number
}

function getSetting(db: Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM hub_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

function setSetting(db: Database, key: string, value: string): void {
  db.prepare(
    'INSERT INTO hub_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

function getAuthMode(db: Database): HubAuthMode {
  const v = getSetting(db, SETTING_KEYS.authMode)
  if (v === 'password' || v === 'cf_access' || v === 'hybrid') return v
  return DEFAULT_AUTH_MODE
}

function getCfAccessEmails(db: Database): string[] {
  const v = getSetting(db, SETTING_KEYS.cfAccessEmails)
  if (!v) return []
  try {
    const arr = JSON.parse(v)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function getTunnelUrl(db: Database): string | null {
  return getSetting(db, SETTING_KEYS.tunnelUrl)
}

function getRequireDesktopConfirm(_db: Database): boolean {
  // DEPRECATED stub. Confirm-on-desktop was removed; always false now.
  // Retained so any external code that still imports this lib doesn't crash.
  return false
}
// Acknowledge the noUnusedLocals lint without deleting the public-ish stub.
void getRequireDesktopConfirm

function countUsers(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) as n FROM hub_users').get() as { n: number }
  return row.n
}

/**
 * Probe whether `port` is currently being listened on by anyone (us or
 * another process). Used to detect dual-stack collisions where a v6 wildcard
 * socket co-exists with a v4 loopback bind without throwing EADDRINUSE.
 *
 * Tries 127.0.0.1 first, then ::1. Resolves true if either accepts a TCP
 * connection within the timeout. False positives are tolerable here — the
 * cost is just walking to the next port — but false negatives let the bug
 * back in, so we err on the side of "in use" if either probe succeeds.
 */
function isPortInUse(port: number, timeoutMs = 200): Promise<boolean> {
  const probe = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = netConnect({ host, port })
      const finish = (used: boolean): void => {
        socket.removeAllListeners()
        try {
          socket.destroy()
        } catch {
          /* ignore */
        }
        resolve(used)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        finish(true)
      })
      socket.once('error', () => {
        clearTimeout(timer)
        finish(false)
      })
    })
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then((rs) => rs.some(Boolean))
}

function findUserByName(db: Database, username: string): UserRow | null {
  const row = db.prepare('SELECT * FROM hub_users WHERE username = ?').get(username) as
    | UserRow
    | undefined
  return row ?? null
}

function findUserById(db: Database, id: number): UserRow | null {
  const row = db.prepare('SELECT * FROM hub_users WHERE id = ?').get(id) as UserRow | undefined
  return row ?? null
}

function findCookieSession(db: Database, id: string, now: number): CookieSessionRow | null {
  const row = db.prepare('SELECT * FROM hub_cookie_sessions WHERE id = ?').get(id) as
    | CookieSessionRow
    | undefined
  if (!row) return null
  if (row.expires_at < now) {
    db.prepare('DELETE FROM hub_cookie_sessions WHERE id = ?').run(id)
    return null
  }
  return row
}

function createCookieSession(db: Database, userId: number, now: number, ttlMs: number): string {
  const id = genCookieSessionId()
  db.prepare(
    'INSERT INTO hub_cookie_sessions(id, user_id, created_at, expires_at) VALUES(?,?,?,?)'
  ).run(id, userId, now, now + ttlMs)
  return id
}

function deleteCookieSession(db: Database, id: string): void {
  db.prepare('DELETE FROM hub_cookie_sessions WHERE id = ?').run(id)
}

// ─── auth resolver ──────────────────────────────────────────────────────────

interface AuthedUser {
  via: 'cookie' | 'cf_access'
  userId?: number
  username?: string
  email?: string
}

function resolveAuth(
  db: Database,
  req: IncomingMessage,
  now: number
): AuthedUser | null {
  const mode = getAuthMode(db)

  if (mode === 'password' || mode === 'hybrid') {
    const cookies = parseCookies(req.headers['cookie'])
    const sid = cookies[COOKIE_NAME]
    if (sid) {
      const sess = findCookieSession(db, sid, now)
      if (sess) {
        const user = findUserById(db, sess.user_id)
        if (user) return { via: 'cookie', userId: user.id, username: user.username }
      }
    }
  }

  if (mode === 'cf_access' || mode === 'hybrid') {
    const email = readCfAccessEmail(req.headers)
    if (email && isCfAccessEmailAllowed(email, getCfAccessEmails(db))) {
      return { via: 'cf_access', email }
    }
  }

  return null
}

// ─── server ─────────────────────────────────────────────────────────────────

export interface HubServer {
  start(port?: number): Promise<HubServerStatus>
  stop(): Promise<void>
  status(): HubServerStatus
  /**
   * If no admin exists, returns the one-shot setup key (generated lazily on
   * first call). Returns null when an admin already exists. Callers MUST
   * write the key to process.stdout — never to a logger that lands on disk.
   */
  ensureSetupKey(): string | null
}

export function createHubServer(opts: HubServerOptions): HubServer {
  return new HubServerImpl(opts)
}

class HubServerImpl implements HubServer {
  private readonly db: Database
  private readonly registry: HubRegistry
  private readonly bridge?: HubBridge
  private readonly getMobileDistRoot?: () => string | null
  private readonly now: () => number
  private readonly rateLimiter: LoginRateLimiter
  private httpServer: http.Server | null = null
  private wss: WebSocketServer | null = null
  private boundHost: string | null = null
  private boundPort: number | null = null
  private setupKey: string | null = null

  constructor(o: HubServerOptions) {
    this.db = o.db
    this.registry = o.registry
    this.bridge = o.bridge
    this.getMobileDistRoot = o.getMobileDistRoot
    this.now = o.now ?? Date.now
    this.rateLimiter = o.rateLimiter ?? new LoginRateLimiter()
  }

  status(): HubServerStatus {
    return {
      running: this.httpServer !== null,
      port: this.boundPort,
      host: this.boundHost
    }
  }

  ensureSetupKey(): string | null {
    if (countUsers(this.db) > 0) {
      this.setupKey = null
      return null
    }
    if (!this.setupKey) this.setupKey = genSetupKey()
    return this.setupKey
  }

  async start(port: number = DEFAULT_HUB_PORT): Promise<HubServerStatus> {
    if (this.httpServer) return this.status()

    const server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        log.error(
          'unhandled request error',
          err instanceof Error ? err : new Error(String(err)),
          { url: req.url }
        )
        if (!res.headersSent) {
          sendError(res, { status: 500, code: 'INTERNAL', message: 'internal error' })
        } else {
          res.destroy()
        }
      })
    })

    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as Socket, head, wss)
    })

    // Port conflict fallback: if the preferred port (default 8317) is already
    // taken — e.g. by a brew-installed background agent — walk forward up to
    // `PORT_FALLBACK_ATTEMPTS` ports and grab the first one that's free.
    // Prefer IPv4 loopback; if the host has no IPv4 stack fall back to ::1
    // for that single attempt. We persist the chosen port on `boundPort` so
    // `/api/config`, cloudflared tunnel, and the renderer UI all agree.
    const { host, port: boundPort } = await this.listenWithFallback(server, port)
    this.boundHost = host
    this.boundPort = boundPort
    this.httpServer = server
    this.wss = wss
    log.info('hub-server listening', {
      host: this.boundHost,
      port: this.boundPort,
      requestedPort: port,
      fellBack: boundPort !== port
    })
    return this.status()
  }

  private async listenWithFallback(
    server: http.Server,
    startPort: number
  ): Promise<{ host: string; port: number }> {
    let lastErr: unknown = null
    for (let i = 0; i < PORT_FALLBACK_ATTEMPTS; i++) {
      const port = startPort + i
      // Pre-flight probe: macOS happily lets us bind 127.0.0.1:N even when
      // someone else is listening on `*:N` (IPv6 dual-stack). Both sockets
      // succeed but client connects to 127.0.0.1 may be routed to either,
      // depending on listen order. Detect the dual-stack collision by
      // probing both 127.0.0.1 and ::1 — if either accepts a connection,
      // walk to the next port. See: https://github.com/nodejs/node/issues/14338
      if (await isPortInUse(port)) {
        log.warn('hub-server: port already accepting connections, trying next', { port })
        continue
      }
      try {
        await this.listenOn(server, port, '127.0.0.1')
        return { host: '127.0.0.1', port }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EADDRNOTAVAIL') {
          // No IPv4 stack. Retry once on ::1 and return regardless — this is
          // a host-level problem, not a per-port one, so there's no point
          // walking further.
          await this.listenOn(server, port, '::1')
          return { host: '::1', port }
        }
        if (code === 'EADDRINUSE') {
          log.warn('hub-server: port busy, trying next', { port })
          lastErr = err
          continue
        }
        throw err
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`no free port in [${startPort}..${startPort + PORT_FALLBACK_ATTEMPTS - 1}]`)
  }

  private listenOn(server: http.Server, port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
  }

  async stop(): Promise<void> {
    const wss = this.wss
    const server = this.httpServer
    this.wss = null
    this.httpServer = null
    this.boundHost = null
    this.boundPort = null
    if (wss) {
      for (const client of wss.clients) {
        try {
          client.close()
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
    }
  }

  // ─── routing ──────────────────────────────────────────────────────────────

  private allowedOrigins(): string[] {
    const origins: string[] = []
    if (this.boundPort) {
      origins.push(`http://127.0.0.1:${this.boundPort}`)
      origins.push(`http://[::1]:${this.boundPort}`)
      origins.push(`http://localhost:${this.boundPort}`)
    }
    const tunnel = getTunnelUrl(this.db)
    if (tunnel) {
      try {
        const u = new URL(tunnel)
        origins.push(`${u.protocol}//${u.host}`)
      } catch {
        /* ignore malformed tunnel url */
      }
    }
    return origins
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/'
    const method = (req.method ?? 'GET').toUpperCase()
    const pathname = url.split('?')[0]!

    // ── CORS: inject Allow-Origin + Credentials on every response ──
    const reqOrigin = req.headers.origin ?? ''
    if (reqOrigin) {
      const allowed = this.allowedOrigins()
      const matchedOrigin = allowed.find((o) => o === reqOrigin)
      if (matchedOrigin) {
        res.setHeader('access-control-allow-origin', matchedOrigin)
        res.setHeader('access-control-allow-credentials', 'true')
      }
    }

    // CORS / Origin check for state-changing requests. Setup bootstrap is the
    // one exception: when no admin exists we accept any origin so the very
    // first /api/setup call can land before the desktop UI knows our port.
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const allowList =
        pathname === '/api/setup' && countUsers(this.db) === 0 ? [] : this.allowedOrigins()
      if (!isOriginAllowed(req.headers, allowList)) {
        return sendError(res, { status: 403, code: 'BAD_ORIGIN', message: 'origin not allowed' })
      }
    }

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type'
      })
      res.end()
      return
    }

    // ── public ──
    if (method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true })
    }
    if (method === 'GET' && pathname === '/api/setup/status') {
      const needsSetup = countUsers(this.db) === 0
      const setupKey = needsSetup ? this.ensureSetupKey() : null
      return sendJson(res, 200, { needsSetup, setupKey })
    }
    if (method === 'POST' && pathname === '/api/setup') {
      return this.routeSetup(req, res)
    }
    if (method === 'POST' && pathname === '/api/login') {
      return this.routeLogin(req, res)
    }

    // ── auth required ──
    if (method === 'POST' && pathname === '/api/logout') {
      return this.routeLogout(req, res)
    }
    if (method === 'GET' && pathname === '/api/me') {
      return this.routeMe(req, res)
    }
    if (method === 'GET' && pathname === '/api/config') {
      return this.routeConfig(req, res)
    }
    if (method === 'GET' && pathname === '/api/devices') {
      return this.routeDevices(req, res)
    }
    {
      const m = pathname.match(/^\/api\/devices\/([^/]+)\/sessions$/)
      if (m && method === 'GET') {
        return this.routeDeviceSessions(req, res, decodeURIComponent(m[1]!))
      }
    }
    {
      const m = pathname.match(/^\/api\/sessions\/([^/]+)\/history$/)
      if (m && method === 'GET') {
        return this.routeSessionHistory(req, res, decodeURIComponent(m[1]!))
      }
    }

    // ── static (mobile UI) ──
    if (method === 'GET') {
      const served = await this.tryServeStatic(pathname, res)
      if (served) return
    }

    sendError(res, { status: 404, code: 'NOT_FOUND', message: pathname })
  }

  // ─── route handlers ───────────────────────────────────────────────────────

  private async routeSetup(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (countUsers(this.db) > 0) {
      return sendError(res, { status: 409, code: 'SETUP_DONE', message: 'setup already done' })
    }
    let body: { setupKey?: string; username?: string; password?: string }
    try {
      body = (await readJsonBody(req)) as typeof body
    } catch (err) {
      return sendError(res, {
        status: 400,
        code: 'BAD_REQUEST',
        message: err instanceof Error ? err.message : 'invalid body'
      })
    }
    const expected = this.ensureSetupKey()
    if (!expected || body.setupKey !== expected) {
      return sendError(res, { status: 403, code: 'BAD_SETUP_KEY', message: 'bad setup key' })
    }
    const username = (body.username ?? '').trim()
    const password = body.password ?? ''
    if (!username || password.length < 8) {
      return sendError(res, {
        status: 400,
        code: 'BAD_REQUEST',
        message: 'username required, password >= 8 chars'
      })
    }
    const now = this.now()
    let userId: number
    try {
      const hash = await hashPassword(password)
      const result = this.db
        .prepare('INSERT INTO hub_users(username, password_hash, created_at) VALUES(?, ?, ?)')
        .run(username, hash, now)
      userId = Number(result.lastInsertRowid)
    } catch (err) {
      return sendError(res, {
        status: 409,
        code: 'USER_EXISTS',
        message: err instanceof Error ? err.message : 'user exists'
      })
    }
    this.setupKey = null
    const sid = createCookieSession(this.db, userId, now, COOKIE_TTL_MS)
    setSessionCookie(res, sid, COOKIE_TTL_MS)
    sendJson(res, 200, { username })
  }

  private async routeLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIp(req)
    if (!this.rateLimiter.check(ip)) {
      return sendError(res, { status: 429, code: 'RATE_LIMITED', message: 'too many attempts' })
    }
    let body: { username?: string; password?: string }
    try {
      body = (await readJsonBody(req)) as typeof body
    } catch (err) {
      return sendError(res, {
        status: 400,
        code: 'BAD_REQUEST',
        message: err instanceof Error ? err.message : 'invalid body'
      })
    }
    const username = (body.username ?? '').trim()
    const password = body.password ?? ''
    const user = findUserByName(this.db, username)
    const ok = user ? await verifyPassword(password, user.password_hash) : false
    if (!user || !ok) {
      this.rateLimiter.record(ip)
      return sendError(res, { status: 401, code: 'BAD_CREDENTIALS', message: 'bad credentials' })
    }
    this.rateLimiter.reset(ip)
    const sid = createCookieSession(this.db, user.id, this.now(), COOKIE_TTL_MS)
    setSessionCookie(res, sid, COOKIE_TTL_MS)
    sendJson(res, 200, { username: user.username })
  }

  private routeLogout(req: IncomingMessage, res: ServerResponse): void {
    const cookies = parseCookies(req.headers['cookie'])
    const sid = cookies[COOKIE_NAME]
    if (sid) deleteCookieSession(this.db, sid)
    clearSessionCookie(res)
    sendJson(res, 200, { ok: true })
  }

  private routeMe(req: IncomingMessage, res: ServerResponse): void {
    const user = resolveAuth(this.db, req, this.now())
    if (!user) return sendError(res, { status: 401, code: 'AUTH_REQUIRED' })
    sendJson(res, 200, {
      via: user.via,
      username: user.username ?? null,
      email: user.email ?? null
    })
  }

  private routeConfig(req: IncomingMessage, res: ServerResponse): void {
    const user = resolveAuth(this.db, req, this.now())
    if (!user) return sendError(res, { status: 401, code: 'AUTH_REQUIRED' })
    sendJson(res, 200, {
      authMode: getAuthMode(this.db),
      tunnelUrl: getTunnelUrl(this.db)
    })
  }

  private routeDevices(req: IncomingMessage, res: ServerResponse): void {
    const user = resolveAuth(this.db, req, this.now())
    if (!user) return sendError(res, { status: 401, code: 'AUTH_REQUIRED' })
    sendJson(res, 200, { devices: this.registry.listDevices() })
  }

  private routeDeviceSessions(
    req: IncomingMessage,
    res: ServerResponse,
    deviceId: string
  ): void {
    const user = resolveAuth(this.db, req, this.now())
    if (!user) return sendError(res, { status: 401, code: 'AUTH_REQUIRED' })
    const device = this.registry.getDevice(deviceId)
    if (!device) return sendError(res, { status: 404, code: 'DEVICE_NOT_FOUND' })

    // Only the local device is supported in M1 — pull live sessions plus any
    // recent worktree-attached sessions from the DB so the mobile UI has
    // something to show even before the agent runtime warms up.
    const rows = this.db
      .prepare(
        `SELECT s.id as id, s.name as name, s.status as status, s.updated_at as updated_at,
                w.id as worktree_id, w.name as worktree_name, w.path as worktree_path,
                p.id as project_id, p.name as project_name
           FROM sessions s
           LEFT JOIN worktrees w ON w.id = s.worktree_id
           LEFT JOIN projects p ON p.id = s.project_id
          WHERE s.status = 'active'
          ORDER BY s.updated_at DESC
          LIMIT 200`
      )
      .all() as Array<{
      id: string
      name: string | null
      status: string
      updated_at: string
      worktree_id: string | null
      worktree_name: string | null
      worktree_path: string | null
      project_id: string
      project_name: string
    }>

    const sessions = rows.map((r) => ({
      hiveSessionId: r.id,
      name: r.name,
      status: r.status,
      updatedAt: r.updated_at,
      worktree: r.worktree_id
        ? { id: r.worktree_id, name: r.worktree_name, path: r.worktree_path }
        : null,
      project: { id: r.project_id, name: r.project_name },
      runtimeStatus:
        this.registry.getSession(deviceId, r.id)?.status ?? 'idle'
    }))
    sendJson(res, 200, { device, sessions })
  }

  private routeSessionHistory(
    req: IncomingMessage,
    res: ServerResponse,
    hiveId: string
  ): void {
    const user = resolveAuth(this.db, req, this.now())
    if (!user) return sendError(res, { status: 401, code: 'AUTH_REQUIRED' })

    const messages = this.db
      .prepare(
        `SELECT id, role, content, created_at
           FROM session_messages
          WHERE session_id = ?
          ORDER BY created_at ASC
          LIMIT 1000`
      )
      .all(hiveId) as Array<{
      id: string
      role: string
      content: string
      created_at: string
    }>

    const activities = this.db
      .prepare(
        `SELECT id, kind, tone, summary, payload_json, created_at
           FROM session_activities
          WHERE session_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT 1000`
      )
      .all(hiveId) as Array<{
      id: string
      kind: string
      tone: string
      summary: string
      payload_json: string | null
      created_at: string
    }>

    sendJson(res, 200, { hiveId, messages, activities })
  }

  // ─── static ──────────────────────────────────────────────────────────────

  private async tryServeStatic(pathname: string, res: ServerResponse): Promise<boolean> {
    const root = this.getMobileDistRoot?.() ?? null
    if (!root) return false
    // Path traversal guard: only allow paths that resolve under root.
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const target = path.resolve(root, rel)
    if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) {
      return false
    }
    try {
      const stat = await fs.stat(target)
      if (stat.isDirectory()) {
        return this.tryServeStatic(path.join(pathname, 'index.html'), res)
      }
      const data = await fs.readFile(target)
      res.writeHead(200, {
        'content-type': contentTypeFor(target),
        'content-length': data.length,
        'cache-control': 'no-cache'
      })
      res.end(data)
      return true
    } catch {
      // Fall back to index.html (SPA route)
      if (rel !== 'index.html') {
        return this.tryServeStatic('/index.html', res)
      }
      return false
    }
  }

  // ─── upgrade / WS ─────────────────────────────────────────────────────────

  /**
   * Write a short HTTP rejection response and tear the socket down. Both
   * `socket.write` and `socket.destroy` can race with a peer that's already
   * gone (mobile network drops, user closed the tab) and emit EPIPE on a
   * write to a closed pipe; without a try/catch the error reaches Node's
   * default handler and produces an "Uncaught Exception" dialog.
   */
  private rejectUpgrade(socket: Socket, status: string): void {
    try {
      if (socket.writable) {
        socket.write(`HTTP/1.1 ${status}\r\n\r\n`)
      }
    } catch {
      /* peer already gone — nothing to send */
    }
    try {
      socket.destroy()
    } catch {
      /* idempotent */
    }
  }

  private handleUpgrade(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
    wss: WebSocketServer
  ): void {
    const url = req.url ?? ''
    const m = url.match(/^\/ws\/ui\/([^/?]+)\/([^/?]+)/)
    if (!m) {
      this.rejectUpgrade(socket, '404 Not Found')
      return
    }
    if (!isOriginAllowed(req.headers, this.allowedOrigins())) {
      this.rejectUpgrade(socket, '403 Forbidden')
      return
    }
    const user = resolveAuth(this.db, req, this.now())
    if (!user) {
      this.rejectUpgrade(socket, '401 Unauthorized')
      return
    }
    const deviceId = decodeURIComponent(m[1]!)
    const hiveSessionId = decodeURIComponent(m[2]!)
    const bridge = this.bridge
    if (!bridge) {
      this.rejectUpgrade(socket, '503 Service Unavailable')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      this.attachClient(ws, deviceId, hiveSessionId, bridge)
    })
  }

  private attachClient(
    ws: WebSocket,
    deviceId: string,
    hiveSessionId: string,
    bridge: HubBridge
  ): void {
    const subscriber: HubSubscriber = {
      send: (data) => ws.send(data),
      readyState: ws.readyState
    }
    // Keep readyState live (the registry uses it to prune dead subs).
    Object.defineProperty(subscriber, 'readyState', { get: () => ws.readyState })

    log.info('hub-server: ws attach', {
      deviceId,
      hiveSessionId,
      localDeviceId: this.registry.localDeviceId,
      deviceMatch: deviceId === this.registry.localDeviceId
    })
    const snapshot = this.registry.subscribe(subscriber, deviceId, hiveSessionId)
    // Pull the last 10 durable messages from SQLite so the phone sees prior
    // turns immediately on entry — the registry's ring buffer only carries
    // events emitted since the desktop app was started, which leaves cold
    // sessions empty even when the SQLite transcript is full.
    const history = bridge.getHistorySnapshot(hiveSessionId, 10)
    try {
      ws.send(
        JSON.stringify({
          type: 'session/snapshot',
          seq: snapshot.lastSeq,
          status: snapshot.status,
          messages: history,
          lastSeq: snapshot.lastSeq
        })
      )
      // Only replay the in-memory ring buffer when there's no DB history.
      // With history present, replaying ring buffer frames re-appends bubbles
      // that are already in the snapshot (DB persisted + ring buffer emitted
      // the same turn), producing duplicates on re-entry. Live frames emitted
      // AFTER subscribe() still flow through broadcast normally.
      if (history.length === 0) {
        for (const f of snapshot.frames) ws.send(JSON.stringify(f))
      }
    } catch {
      /* ignore */
    }

    ws.on('message', (raw) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
      } catch {
        ws.send(JSON.stringify({ type: 'error', code: 'BAD_REQUEST', message: 'invalid JSON' }))
        return
      }
      bridge.handleClientMessage(subscriber, hiveSessionId, parsed).catch((err) => {
        log.warn('handleClientMessage threw', {
          error: err instanceof Error ? err.message : String(err)
        })
      })
    })

    ws.on('close', () => {
      this.registry.unsubscribe(subscriber, deviceId, hiveSessionId)
    })
    ws.on('error', () => {
      this.registry.unsubscribe(subscriber, deviceId, hiveSessionId)
    })
  }
}

// ─── content-type ───────────────────────────────────────────────────────────

function contentTypeFor(file: string): string {
  const ext = path.extname(file).toLowerCase()
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
    case '.mjs':
      return 'application/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.ico':
      return 'image/x-icon'
    case '.webmanifest':
      return 'application/manifest+json'
    default:
      return 'application/octet-stream'
  }
}

// ─── settings setters (re-exported for ipc handlers) ────────────────────────

export function setHubAuthMode(db: Database, mode: HubAuthMode): void {
  setSetting(db, SETTING_KEYS.authMode, mode)
}

export function setHubCfAccessEmails(db: Database, emails: readonly string[]): void {
  setSetting(db, SETTING_KEYS.cfAccessEmails, JSON.stringify(emails))
}

export function setHubRequireDesktopConfirm(db: Database, value: boolean): void {
  setSetting(db, SETTING_KEYS.requireDesktopConfirm, value ? '1' : '0')
}

export function setHubTunnelUrl(db: Database, url: string | null): void {
  if (url === null) {
    db.prepare('DELETE FROM hub_settings WHERE key = ?').run(SETTING_KEYS.tunnelUrl)
  } else {
    setSetting(db, SETTING_KEYS.tunnelUrl, url)
  }
}
