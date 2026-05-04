/**
 * Tests for the shared redact module (Token Saver stage 0).
 *
 * Coverage targets:
 *   - inline mode: each pattern fires on its canonical example
 *   - inline mode: keyword-form preserves keyword (`api_key=[REDACTED]`)
 *   - inline mode: bare-form replaces with `[REDACTED]`
 *   - line mode: any keyword in line → whole line replaced
 *   - both modes: clean input round-trips unchanged (no allocation surprises)
 *   - both modes: empty / non-string inputs are handled
 *   - regression: docstring 中文 不受影响
 */
import { describe, it, expect } from 'vitest'
import { redactSecrets } from '../../src/main/field/redact'

describe('redactSecrets — inline mode (default)', () => {
  it('redacts keyword-style assignment, preserving the keyword', () => {
    const out = redactSecrets('API_KEY=sk-1234567890abcdef')
    expect(out).toBe('API_KEY=[REDACTED]')
  })

  it('handles colon separator', () => {
    const out = redactSecrets('password: hunter2hunter2')
    expect(out).toBe('password=[REDACTED]')
  })

  it('redacts an OpenAI sk- key in free text', () => {
    const out = redactSecrets('curl -H "x: sk-abcDEFghiJKLmnoPQRstuVWX" /v1/chat')
    expect(out).not.toContain('sk-abcDEFghiJKLmnoPQRstuVWX')
    expect(out).toContain('[REDACTED]')
  })

  it('redacts an Anthropic sk-ant- key', () => {
    const out = redactSecrets('export ANTHROPIC=sk-ant-abc1234567890defghijklmn')
    expect(out).not.toContain('sk-ant-abc1234567890defghijklmn')
  })

  it('redacts a GitHub token (ghp_)', () => {
    const out = redactSecrets('git clone https://x:ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa12@github.com/x.git')
    expect(out).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa12')
  })

  it('redacts an AWS access key ID', () => {
    const out = redactSecrets('AKIAIOSFODNN7EXAMPLE in env')
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const out = redactSecrets(`Authorization: ${jwt}`)
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
  })

  it('redacts long hex secrets', () => {
    const out = redactSecrets('hash=abcdef0123456789abcdef0123456789')
    expect(out).not.toContain('abcdef0123456789abcdef0123456789')
  })

  it('redacts PEM private key blocks (multiline)', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA1234567890
abcdefg
-----END RSA PRIVATE KEY-----`
    const out = redactSecrets(pem)
    expect(out).not.toContain('MIIEowIBAAKCAQEA1234567890')
    expect(out).toContain('[REDACTED]')
  })

  it('does not modify clean strings', () => {
    const clean = 'just a normal log line about file foo.ts at line 42'
    expect(redactSecrets(clean)).toBe(clean)
  })

  it('preserves Chinese / non-ASCII text', () => {
    const cn = '会话已恢复，但 token 字段需要核验'
    // The word "token" triggers keyword-assignment but only with a value of
    // length ≥6 chars. Bare keyword without assignment should not match.
    expect(redactSecrets(cn)).toBe(cn)
  })

  it('returns input unchanged for empty / non-string', () => {
    expect(redactSecrets('')).toBe('')
    // @ts-expect-error intentional: defensive against bad caller input
    expect(redactSecrets(null)).toBe(null)
    // @ts-expect-error intentional
    expect(redactSecrets(undefined)).toBe(undefined)
  })
})

describe('redactSecrets — line mode (aggressive)', () => {
  it('replaces an entire line containing a credential keyword', () => {
    const input = `line one
api_key: secretvalue
line three`
    const out = redactSecrets(input, { mode: 'line' })
    expect(out).toBe(`line one
[REDACTED LINE]
line three`)
  })

  it('matches multiple credential keywords on multiple lines', () => {
    const input = `password=foo
ok line
Bearer xyz`
    const out = redactSecrets(input, { mode: 'line' })
    expect(out.split('\n').filter((l) => l === '[REDACTED LINE]')).toHaveLength(2)
  })

  it('respects custom replacement', () => {
    const out = redactSecrets('token=abc', { mode: 'line', replacement: '<<gone>>' })
    expect(out).toBe('<<gone>>')
  })

  it('returns input unchanged when no keyword present', () => {
    const input = 'lorem ipsum dolor sit amet\nno hidden values here\nplain text'
    expect(redactSecrets(input, { mode: 'line' })).toBe(input)
  })

  it('respects word boundaries (does not match "secretary" or "tokenize")', () => {
    const input = 'the secretary said hi\nlet us tokenize the input'
    expect(redactSecrets(input, { mode: 'line' })).toBe(input)
  })
})

describe('redactSecrets — multi-pattern interplay', () => {
  it('redacts both keyword-assignment and bare token in same string', () => {
    const out = redactSecrets('export API_KEY=sk-foobar1234567890; ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz12 done')
    expect(out).not.toContain('sk-foobar1234567890')
    expect(out).not.toContain('ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz12')
  })

  it('inline mode does not destroy structure: only matched substrings change', () => {
    const out = redactSecrets('prefix api_key=topsecret123456 suffix')
    expect(out.startsWith('prefix')).toBe(true)
    expect(out.endsWith('suffix')).toBe(true)
    expect(out).toContain('[REDACTED]')
  })
})
