import { describe, it, expect } from 'vitest'
import {
  hashPassword,
  verifyPassword,
  genToken,
  hashToken,
  tokenPrefix,
  TOKEN_PREFIX,
  TOKEN_PREFIX_LEN,
  genSetupKey,
  genCookieSessionId,
  LoginRateLimiter,
  readCfAccessEmail,
  isCfAccessEmailAllowed,
  isOriginAllowed
} from '../../src/main/services/hub/hub-auth'

describe('hub-auth: password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('hunter2')
    expect(stored.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('hunter2', stored)).toBe(true)
    expect(await verifyPassword('hunter3', stored)).toBe(false)
  })

  it('produces a different hash for the same password (random salt)', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a).not.toBe(b)
    expect(await verifyPassword('same', a)).toBe(true)
    expect(await verifyPassword('same', b)).toBe(true)
  })

  it('returns false for malformed stored hash', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$bad')).toBe(false)
  })
})

describe('hub-auth: tokens', () => {
  it('generates tokens with the right prefix and stable hash', () => {
    const t = genToken()
    expect(t.startsWith(TOKEN_PREFIX)).toBe(true)
    expect(t.length).toBeGreaterThan(TOKEN_PREFIX_LEN + 16)
    expect(tokenPrefix(t)).toBe(t.slice(0, TOKEN_PREFIX_LEN))
    expect(hashToken(t)).toBe(hashToken(t))
    expect(hashToken(t)).not.toBe(hashToken(genToken()))
  })

  it('genCookieSessionId / genSetupKey return non-empty random strings', () => {
    expect(genCookieSessionId().length).toBeGreaterThan(20)
    expect(genCookieSessionId()).not.toBe(genCookieSessionId())
    expect(genSetupKey().length).toBeGreaterThan(0)
  })
})

describe('hub-auth: LoginRateLimiter', () => {
  it('blocks after exceeding the limit and slides the window', () => {
    let now = 1_000_000
    const limiter = new LoginRateLimiter({ windowMs: 1000, max: 3, now: () => now })
    expect(limiter.check('1.2.3.4')).toBe(true)
    limiter.record('1.2.3.4')
    limiter.record('1.2.3.4')
    limiter.record('1.2.3.4')
    expect(limiter.check('1.2.3.4')).toBe(false)
    expect(limiter.remaining('1.2.3.4')).toBe(0)
    // unrelated key isn't affected
    expect(limiter.check('9.9.9.9')).toBe(true)

    // advance past the window
    now += 1500
    expect(limiter.check('1.2.3.4')).toBe(true)
    expect(limiter.remaining('1.2.3.4')).toBe(3)
  })

  it('reset clears the counter', () => {
    const limiter = new LoginRateLimiter({ windowMs: 60_000, max: 2 })
    limiter.record('k')
    limiter.record('k')
    expect(limiter.check('k')).toBe(false)
    limiter.reset('k')
    expect(limiter.check('k')).toBe(true)
  })
})

describe('hub-auth: CF Access', () => {
  it('reads the email header lower-cased and trimmed', () => {
    expect(
      readCfAccessEmail({ 'cf-access-authenticated-user-email': '  Alice@Example.COM ' })
    ).toBe('alice@example.com')
    expect(readCfAccessEmail({})).toBeNull()
    expect(readCfAccessEmail({ 'cf-access-authenticated-user-email': '' })).toBeNull()
    expect(
      readCfAccessEmail({ 'cf-access-authenticated-user-email': ['bob@x.io', 'eve@x.io'] })
    ).toBe('bob@x.io')
  })

  it('matches the allowlist case-insensitively', () => {
    expect(isCfAccessEmailAllowed('alice@x.io', ['ALICE@X.IO'])).toBe(true)
    expect(isCfAccessEmailAllowed('alice@x.io', ['bob@x.io'])).toBe(false)
    expect(isCfAccessEmailAllowed(null, ['alice@x.io'])).toBe(false)
    expect(isCfAccessEmailAllowed('alice@x.io', [])).toBe(false)
  })
})

describe('hub-auth: Origin/Referer CSRF', () => {
  it('allows when origin matches', () => {
    expect(
      isOriginAllowed({ origin: 'http://127.0.0.1:8317' }, ['http://127.0.0.1:8317'])
    ).toBe(true)
  })

  it('falls back to referer when origin missing', () => {
    expect(
      isOriginAllowed(
        { referer: 'http://127.0.0.1:8317/login' },
        ['http://127.0.0.1:8317']
      )
    ).toBe(true)
  })

  it('rejects mismatched origin', () => {
    expect(
      isOriginAllowed({ origin: 'http://evil.com' }, ['http://127.0.0.1:8317'])
    ).toBe(false)
  })

  it('rejects missing origin/referer', () => {
    expect(isOriginAllowed({}, ['http://127.0.0.1:8317'])).toBe(false)
  })

  it('empty allowlist permits anything (setup bootstrap)', () => {
    expect(isOriginAllowed({}, [])).toBe(true)
  })
})
