import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import Database from 'better-sqlite3'
import type { AddressInfo } from 'net'
import {
  createHubServer,
  COOKIE_NAME,
  setHubAuthMode,
  setHubCfAccessEmails,
  setHubTunnelUrl
} from '../../src/main/services/hub/hub-server'
import { HubRegistry } from '../../src/main/services/hub/hub-registry'
import { LoginRateLimiter } from '../../src/main/services/hub/hub-auth'

// Minimal in-memory schema — just the hub tables + the tables our read-only
// session routes touch. Keeps tests from depending on the full migration set.
function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE hub_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE hub_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      hash TEXT NOT NULL,
      prefix TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used INTEGER,
      last_device_id TEXT,
      disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE hub_cookie_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES hub_users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE hub_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL
    );
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      worktree_id TEXT,
      project_id TEXT NOT NULL,
      name TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at TEXT NOT NULL DEFAULT '2020-01-01'
    );
    CREATE TABLE session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE session_activities (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      tone TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
  `)
  return db
}

interface TestCtx {
  db: Database.Database
  registry: HubRegistry
  server: ReturnType<typeof createHubServer>
  baseUrl: string
}

async function boot(
  overrides: { rateLimiter?: LoginRateLimiter } = {}
): Promise<TestCtx> {
  const db = makeDb()
  const registry = new HubRegistry({ localDeviceId: 'dev-local', localDeviceName: 'laptop' })
  const server = createHubServer({
    db,
    registry,
    rateLimiter: overrides.rateLimiter
  })
  await server.start(0)
  // Dig out the actual port that got assigned.
  // start() returns status with `port` set to the number we passed in — we
  // instead read it off the internal http server via a side channel.
  // Simplest: use /health on boundHost with the reported port from status().
  // When port=0, Node picks a free port but we set boundPort=0 — so we need
  // to expose the real port. We patch here via reflection.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const httpServer = (server as any).httpServer as import('http').Server | null
  const addr = httpServer?.address() as AddressInfo | null
  if (!addr) throw new Error('no address')
  // Overwrite boundPort so allowedOrigins() uses the real port.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(server as any).boundPort = addr.port
  const baseUrl = `http://127.0.0.1:${addr.port}`
  return { db, registry, server, baseUrl }
}

interface FetchResult {
  status: number
  body: unknown
  cookie: string | null
  rawSetCookie: string | null
}

async function req(
  url: string,
  init: {
    method?: string
    json?: unknown
    cookie?: string
    origin?: string
    headers?: Record<string, string>
  } = {}
): Promise<FetchResult> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(init.headers ?? {})
  }
  if (init.json !== undefined) headers['content-type'] = 'application/json'
  if (init.origin) headers['origin'] = init.origin
  if (init.cookie) headers['cookie'] = init.cookie
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    /* keep as string */
  }
  const rawSetCookie = res.headers.get('set-cookie')
  let cookie: string | null = null
  if (rawSetCookie) {
    const eq = rawSetCookie.indexOf(';')
    cookie = eq === -1 ? rawSetCookie : rawSetCookie.slice(0, eq)
  }
  return { status: res.status, body, cookie, rawSetCookie }
}

let ctx: TestCtx

afterEach(async () => {
  if (ctx) {
    await ctx.server.stop()
    ctx.db.close()
  }
})

describe('hub-server: /health + setup bootstrap', () => {
  beforeEach(async () => {
    ctx = await boot()
  })

  it('/health returns ok without auth', async () => {
    const r = await req(`${ctx.baseUrl}/health`)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
  })

  it('/api/setup/status flags needsSetup and returns setupKey', async () => {
    const r = await req(`${ctx.baseUrl}/api/setup/status`)
    expect(r.status).toBe(200)
    const body = r.body as { needsSetup: boolean; setupKey: string }
    expect(body.needsSetup).toBe(true)
    expect(typeof body.setupKey).toBe('string')
    expect(body.setupKey.length).toBeGreaterThan(4)
  })

  it('POST /api/setup creates admin and sets cookie; further setup rejected', async () => {
    const statusResp = await req(`${ctx.baseUrl}/api/setup/status`)
    const setupKey = (statusResp.body as { setupKey: string }).setupKey

    const r = await req(`${ctx.baseUrl}/api/setup`, {
      method: 'POST',
      json: { setupKey, username: 'alice', password: 'password123' }
    })
    expect(r.status).toBe(200)
    expect(r.cookie).toMatch(new RegExp(`^${COOKIE_NAME}=`))

    // Second setup is refused (admin now exists).
    const again = await req(`${ctx.baseUrl}/api/setup`, {
      method: 'POST',
      json: { setupKey, username: 'bob', password: 'password123' },
      origin: ctx.baseUrl
    })
    expect(again.status).toBe(409)
  })

  it('POST /api/setup rejects wrong setup-key', async () => {
    const r = await req(`${ctx.baseUrl}/api/setup`, {
      method: 'POST',
      json: { setupKey: 'nope', username: 'alice', password: 'password123' }
    })
    expect(r.status).toBe(403)
    expect((r.body as { error: { code: string } }).error.code).toBe('BAD_SETUP_KEY')
  })

  it('POST /api/setup rejects short password', async () => {
    const statusResp = await req(`${ctx.baseUrl}/api/setup/status`)
    const setupKey = (statusResp.body as { setupKey: string }).setupKey
    const r = await req(`${ctx.baseUrl}/api/setup`, {
      method: 'POST',
      json: { setupKey, username: 'alice', password: 'short' }
    })
    expect(r.status).toBe(400)
  })
})

describe('hub-server: login / me / logout', () => {
  beforeEach(async () => {
    ctx = await boot()
    const statusResp = await req(`${ctx.baseUrl}/api/setup/status`)
    const setupKey = (statusResp.body as { setupKey: string }).setupKey
    await req(`${ctx.baseUrl}/api/setup`, {
      method: 'POST',
      json: { setupKey, username: 'alice', password: 'password123' }
    })
  })

  it('/api/me returns 401 without cookie', async () => {
    const r = await req(`${ctx.baseUrl}/api/me`)
    expect(r.status).toBe(401)
  })

  it('login -> me -> logout roundtrip', async () => {
    const login = await req(`${ctx.baseUrl}/api/login`, {
      method: 'POST',
      json: { username: 'alice', password: 'password123' },
      origin: ctx.baseUrl
    })
    expect(login.status).toBe(200)
    expect(login.cookie).toBeTruthy()

    const me = await req(`${ctx.baseUrl}/api/me`, { cookie: login.cookie! })
    expect(me.status).toBe(200)
    expect((me.body as { username: string }).username).toBe('alice')

    const logout = await req(`${ctx.baseUrl}/api/logout`, {
      method: 'POST',
      cookie: login.cookie!,
      origin: ctx.baseUrl
    })
    expect(logout.status).toBe(200)

    const meAfter = await req(`${ctx.baseUrl}/api/me`, { cookie: login.cookie! })
    expect(meAfter.status).toBe(401)
  })

  it('login rejects bad credentials', async () => {
    const r = await req(`${ctx.baseUrl}/api/login`, {
      method: 'POST',
      json: { username: 'alice', password: 'wrong-wrong' },
      origin: ctx.baseUrl
    })
    expect(r.status).toBe(401)
  })

  it('login enforces rate-limit after repeated failures', async () => {
    const limiter = new LoginRateLimiter({ max: 2, windowMs: 60_000 })
    await ctx.server.stop()
    ctx.db.close()
    ctx = await boot({ rateLimiter: limiter })
    const status = await req(`${ctx.baseUrl}/api/setup/status`)
    await req(`${ctx.baseUrl}/api/setup`, {
      method: 'POST',
      json: {
        setupKey: (status.body as { setupKey: string }).setupKey,
        username: 'alice',
        password: 'password123'
      }
    })
    for (let i = 0; i < 2; i++) {
      const r = await req(`${ctx.baseUrl}/api/login`, {
        method: 'POST',
        json: { username: 'alice', password: 'wrong-wrong' },
        origin: ctx.baseUrl
      })
      expect(r.status).toBe(401)
    }
    const blocked = await req(`${ctx.baseUrl}/api/login`, {
      method: 'POST',
      json: { username: 'alice', password: 'wrong-wrong' },
      origin: ctx.baseUrl
    })
    expect(blocked.status).toBe(429)
  })
})

describe('hub-server: protected routes', () => {
  let cookie: string

  beforeEach(async () => {
    ctx = await boot()
    const status = await req(`${ctx.baseUrl}/api/setup/status`)
    const setup = await req(`${ctx.baseUrl}/api/setup`, {
      method: 'POST',
      json: {
        setupKey: (status.body as { setupKey: string }).setupKey,
        username: 'alice',
        password: 'password123'
      }
    })
    cookie = setup.cookie!
  })

  it('/api/config reflects hub_settings', async () => {
    setHubAuthMode(ctx.db, 'hybrid')
    setHubTunnelUrl(ctx.db, 'https://abc.trycloudflare.com')
    const r = await req(`${ctx.baseUrl}/api/config`, { cookie })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      authMode: 'hybrid',
      requireDesktopConfirm: true,
      tunnelUrl: 'https://abc.trycloudflare.com'
    })
  })

  it('/api/devices returns the local device', async () => {
    const r = await req(`${ctx.baseUrl}/api/devices`, { cookie })
    expect(r.status).toBe(200)
    const body = r.body as { devices: Array<{ id: string }> }
    expect(body.devices.map((d) => d.id)).toContain('dev-local')
  })

  it('/api/devices/:id/sessions lists active sessions from DB', async () => {
    ctx.db
      .prepare('INSERT INTO projects(id,name,path) VALUES(?,?,?)')
      .run('p1', 'proj', '/p')
    ctx.db
      .prepare('INSERT INTO worktrees(id,project_id,name,path) VALUES(?,?,?,?)')
      .run('w1', 'p1', 'wt', '/p/wt')
    ctx.db
      .prepare(
        'INSERT INTO sessions(id,worktree_id,project_id,name,status,updated_at) VALUES(?,?,?,?,?,?)'
      )
      .run('s1', 'w1', 'p1', 'First', 'active', '2025-01-01')

    const r = await req(`${ctx.baseUrl}/api/devices/dev-local/sessions`, { cookie })
    expect(r.status).toBe(200)
    const body = r.body as { sessions: Array<{ hiveSessionId: string; name: string }> }
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0].hiveSessionId).toBe('s1')
  })

  it('/api/devices/unknown/sessions -> 404', async () => {
    const r = await req(`${ctx.baseUrl}/api/devices/other/sessions`, { cookie })
    expect(r.status).toBe(404)
  })

  it('/api/sessions/:id/history returns messages + activities', async () => {
    ctx.db
      .prepare(
        'INSERT INTO session_messages(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)'
      )
      .run('m1', 'sess-1', 'user', 'hello', '2025-01-01')
    ctx.db
      .prepare(
        'INSERT INTO session_activities(id,session_id,kind,tone,summary,payload_json,created_at) VALUES(?,?,?,?,?,?,?)'
      )
      .run('a1', 'sess-1', 'tool', 'info', 'ran Read', null, '2025-01-01')

    const r = await req(`${ctx.baseUrl}/api/sessions/sess-1/history`, { cookie })
    expect(r.status).toBe(200)
    const body = r.body as {
      hiveId: string
      messages: Array<{ id: string }>
      activities: Array<{ id: string }>
    }
    expect(body.hiveId).toBe('sess-1')
    expect(body.messages.map((m) => m.id)).toEqual(['m1'])
    expect(body.activities.map((a) => a.id)).toEqual(['a1'])
  })

  it('all protected routes refuse missing auth', async () => {
    for (const p of [
      '/api/me',
      '/api/config',
      '/api/devices',
      '/api/devices/dev-local/sessions',
      '/api/sessions/x/history'
    ]) {
      const r = await req(`${ctx.baseUrl}${p}`)
      expect(r.status, p).toBe(401)
    }
  })
})

describe('hub-server: CF Access mode', () => {
  beforeEach(async () => {
    ctx = await boot()
    const status = await req(`${ctx.baseUrl}/api/setup/status`)
    await req(`${ctx.baseUrl}/api/setup`, {
      method: 'POST',
      json: {
        setupKey: (status.body as { setupKey: string }).setupKey,
        username: 'alice',
        password: 'password123'
      }
    })
    setHubAuthMode(ctx.db, 'cf_access')
    setHubCfAccessEmails(ctx.db, ['bob@example.com'])
  })

  it('accepts allowlisted CF Access email', async () => {
    const r = await req(`${ctx.baseUrl}/api/me`, {
      headers: { 'cf-access-authenticated-user-email': 'bob@example.com' }
    })
    expect(r.status).toBe(200)
    expect((r.body as { email: string }).email).toBe('bob@example.com')
  })

  it('rejects email not in allowlist', async () => {
    const r = await req(`${ctx.baseUrl}/api/me`, {
      headers: { 'cf-access-authenticated-user-email': 'evil@example.com' }
    })
    expect(r.status).toBe(401)
  })

  it('in cf_access mode, cookie alone is rejected', async () => {
    const login = await req(`${ctx.baseUrl}/api/login`, {
      method: 'POST',
      json: { username: 'alice', password: 'password123' },
      origin: ctx.baseUrl
    })
    // Switch to cf_access — already set above. Cookie should now fail.
    const r = await req(`${ctx.baseUrl}/api/me`, { cookie: login.cookie! })
    expect(r.status).toBe(401)
  })
})

describe('hub-server: origin check', () => {
  beforeEach(async () => {
    ctx = await boot()
  })

  it('once admin exists, POST with disallowed origin is rejected', async () => {
    const status = await req(`${ctx.baseUrl}/api/setup/status`)
    await req(`${ctx.baseUrl}/api/setup`, {
      method: 'POST',
      json: {
        setupKey: (status.body as { setupKey: string }).setupKey,
        username: 'alice',
        password: 'password123'
      }
    })
    const r = await req(`${ctx.baseUrl}/api/login`, {
      method: 'POST',
      json: { username: 'alice', password: 'password123' },
      origin: 'https://evil.example.com'
    })
    expect(r.status).toBe(403)
    expect((r.body as { error: { code: string } }).error.code).toBe('BAD_ORIGIN')
  })

  it('POST /api/setup with no admin yet accepts any origin', async () => {
    const status = await req(`${ctx.baseUrl}/api/setup/status`)
    const r = await req(`${ctx.baseUrl}/api/setup`, {
      method: 'POST',
      json: {
        setupKey: (status.body as { setupKey: string }).setupKey,
        username: 'alice',
        password: 'password123'
      },
      origin: 'https://unknown.example.com'
    })
    expect(r.status).toBe(200)
  })
})

describe('hub-server: unknown routes + lifecycle', () => {
  it('unknown path returns 404 JSON', async () => {
    ctx = await boot()
    const r = await req(`${ctx.baseUrl}/does/not/exist`)
    expect(r.status).toBe(404)
    expect((r.body as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })

  it('stop() shuts server down cleanly', async () => {
    ctx = await boot()
    await ctx.server.stop()
    // Prevent afterEach double-stop.
    ctx.server = createHubServer({
      db: ctx.db,
      registry: ctx.registry
    })
    expect(ctx.server.status().running).toBe(false)
  })
})
