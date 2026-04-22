/**
 * Auth primitives for Xuanpu Hub mode (M1).
 *
 * - Admin passwords: scrypt (N=2^15, slow, low-entropy input)
 * - Agent tokens: high-entropy random; sha256 lookup is sufficient
 * - UI cookie sessions: 256-bit opaque ids stored server-side in hub_cookie_sessions
 * - Setup key: one-shot, generated on process start when hub_users is empty.
 *   Printed to stdout (process.stdout.write) — never written through createLogger
 *   so it does not land on disk in ~/.xuanpu/logs.
 *
 * Ported from /Users/slicenfer/Development/projects/self/session-hub/hub/auth.py.
 * The Python reference uses bcrypt; we use Node crypto.scrypt to avoid a native
 * dep — same security posture (slow KDF) with deterministic Node availability.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'crypto'
import { promisify } from 'util'

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number }
) => Promise<Buffer>

export const TOKEN_PREFIX = 'xp_'
export const TOKEN_PREFIX_LEN = 8

const SCRYPT_N = 1 << 15 // 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 32
const SCRYPT_SALT_LEN = 16
// Node's default scrypt maxmem (~32 MB) is too small for N=32768; bump it.
const SCRYPT_MAXMEM = 64 * 1024 * 1024

// ─── password (scrypt) ──────────────────────────────────────────────────────

/**
 * Returns a self-describing string `scrypt$N$r$p$salt_b64$hash_b64` so we can
 * change parameters later without breaking existing rows.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_LEN)
  const hash = await scrypt(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM
  })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    const N = parseInt(parts[1], 10)
    const r = parseInt(parts[2], 10)
    const p = parseInt(parts[3], 10)
    const salt = Buffer.from(parts[4], 'base64')
    const expected = Buffer.from(parts[5], 'base64')
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false
    const actual = await scrypt(plain, salt, expected.length, {
      N,
      r,
      p,
      maxmem: Math.max(SCRYPT_MAXMEM, 128 * N * r * 2)
    })
    if (actual.length !== expected.length) return false
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

// ─── tokens (sha256, agent / M2 use) ────────────────────────────────────────

/** Returns `xp_<base64url>` — ~192 bits of entropy. */
export function genToken(): string {
  return TOKEN_PREFIX + randomBytes(24).toString('base64url')
}

export function hashToken(plain: string): string {
  return createHash('sha256').update(plain, 'utf8').digest('hex')
}

export function tokenPrefix(plain: string): string {
  return plain.slice(0, TOKEN_PREFIX_LEN)
}

// ─── cookie sessions ────────────────────────────────────────────────────────

export function genCookieSessionId(): string {
  return randomBytes(32).toString('base64url')
}

export function genSetupKey(): string {
  // 8-char user-readable key (~48 bits; only valid until first admin is created).
  return randomBytes(6).toString('base64url')
}

// ─── login rate limiter ─────────────────────────────────────────────────────

export interface RateLimiterOptions {
  /** Window length in milliseconds. Default 15 min. */
  windowMs?: number
  /** Maximum attempts per window per key. Default 5. */
  max?: number
  /** Override clock for tests. */
  now?: () => number
}

/**
 * Sliding-window in-memory rate limiter keyed by IP (or any string).
 * Designed for the /api/login endpoint: 5 attempts / 15 minutes by default.
 */
export class LoginRateLimiter {
  private readonly windowMs: number
  private readonly max: number
  private readonly now: () => number
  private readonly hits = new Map<string, number[]>()

  constructor(opts: RateLimiterOptions = {}) {
    this.windowMs = opts.windowMs ?? 15 * 60 * 1000
    this.max = opts.max ?? 5
    this.now = opts.now ?? Date.now
  }

  /** Returns true if `key` is allowed; false when over the limit. */
  check(key: string): boolean {
    return this.remaining(key) > 0
  }

  /** Record a failed attempt. Caller should only call on failure. */
  record(key: string): void {
    const t = this.now()
    const list = this.hits.get(key) ?? []
    list.push(t)
    const cutoff = t - this.windowMs
    while (list.length > 0 && list[0] < cutoff) list.shift()
    this.hits.set(key, list)
  }

  remaining(key: string): number {
    const list = this.hits.get(key)
    if (!list || list.length === 0) return this.max
    const cutoff = this.now() - this.windowMs
    while (list.length > 0 && list[0] < cutoff) list.shift()
    return Math.max(0, this.max - list.length)
  }

  /** Clear successful keys (e.g. after a valid login). */
  reset(key: string): void {
    this.hits.delete(key)
  }
}

// ─── Cloudflare Access header ───────────────────────────────────────────────

export const CF_ACCESS_EMAIL_HEADER = 'cf-access-authenticated-user-email'

/**
 * Extract the email from a Cloudflare Access-protected request, or null if
 * the header is missing/empty. Header names are matched case-insensitively;
 * Node's IncomingMessage.headers already lowercases keys.
 */
export function readCfAccessEmail(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers[CF_ACCESS_EMAIL_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

/** Returns true when `email` matches an entry in `allowlist` (case-insensitive). */
export function isCfAccessEmailAllowed(email: string | null, allowlist: readonly string[]): boolean {
  if (!email) return false
  const target = email.trim().toLowerCase()
  if (!target) return false
  return allowlist.some((e) => e.trim().toLowerCase() === target)
}

// ─── Origin / Referer (CSRF) ────────────────────────────────────────────────

/**
 * Same-origin check for state-changing requests. `allowedOrigins` should
 * include the loopback origin (`http://127.0.0.1:<port>`) plus the active
 * tunnel URL (if any). Empty allowlist means "any origin permitted" — only
 * useful for the very first /api/setup call before settings exist.
 */
export function isOriginAllowed(
  headers: Record<string, string | string[] | undefined>,
  allowedOrigins: readonly string[]
): boolean {
  if (allowedOrigins.length === 0) return true
  const pickHeader = (name: string): string | null => {
    const raw = headers[name]
    const v = Array.isArray(raw) ? raw[0] : raw
    return typeof v === 'string' && v.length > 0 ? v : null
  }
  const origin = pickHeader('origin')
  const referer = pickHeader('referer')
  const candidate = origin ?? (referer ? safeOrigin(referer) : null)
  if (!candidate) return false
  return allowedOrigins.includes(candidate)
}

function safeOrigin(url: string): string | null {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}
