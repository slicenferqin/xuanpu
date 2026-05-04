/**
 * Tests for the Token Saver footer parser (Token Saver stage 3).
 */
import { describe, it, expect } from 'vitest'
import {
  parseTokenSaverFooter,
  formatBytes
} from '../../src/renderer/src/lib/token-saver-footer'

describe('parseTokenSaverFooter', () => {
  it('parses a full footer (with archive path)', () => {
    const raw = [
      'compressed body line 1',
      'compressed body line 2',
      '---',
      '[Token Saver] compressed 8432B → 412B (-95%) · via ansi-strip, progress-dedup · original: /Users/alice/.xuanpu/archive/s1/12345-0001.txt'
    ].join('\n')
    const parsed = parseTokenSaverFooter(raw)
    expect(parsed).not.toBeNull()
    expect(parsed!.body).toBe('compressed body line 1\ncompressed body line 2')
    expect(parsed!.beforeBytes).toBe(8432)
    expect(parsed!.afterBytes).toBe(412)
    expect(parsed!.savedPercent).toBe(95)
    expect(parsed!.rules).toEqual(['ansi-strip', 'progress-dedup'])
    expect(parsed!.archivePath).toBe(
      '/Users/alice/.xuanpu/archive/s1/12345-0001.txt'
    )
  })

  it('parses a footer without archive path', () => {
    const raw =
      'body\n---\n[Token Saver] compressed 1000B → 100B (-90%) · via failure-focus'
    const parsed = parseTokenSaverFooter(raw)
    expect(parsed).not.toBeNull()
    expect(parsed!.archivePath).toBeNull()
    expect(parsed!.rules).toEqual(['failure-focus'])
    expect(parsed!.body).toBe('body')
  })

  it('returns null when no footer is present', () => {
    expect(parseTokenSaverFooter('just plain output')).toBeNull()
    expect(parseTokenSaverFooter('')).toBeNull()
    expect(parseTokenSaverFooter(null)).toBeNull()
    expect(parseTokenSaverFooter(undefined)).toBeNull()
  })

  it('parses a single-rule footer', () => {
    const raw =
      'x\n---\n[Token Saver] compressed 500B → 250B (-50%) · via ansi-strip'
    const parsed = parseTokenSaverFooter(raw)
    expect(parsed).not.toBeNull()
    expect(parsed!.rules).toEqual(['ansi-strip'])
  })

  it('parses three+ rules joined with commas', () => {
    const raw =
      'x\n---\n[Token Saver] compressed 2000B → 300B (-85%) · via ansi-strip, progress-dedup, failure-focus'
    const parsed = parseTokenSaverFooter(raw)
    expect(parsed!.rules).toEqual([
      'ansi-strip',
      'progress-dedup',
      'failure-focus'
    ])
  })

  it('preserves internal content (e.g. stderr separators) in body', () => {
    const raw = [
      'stdout contents',
      '--- stderr ---',
      'stderr contents',
      '---',
      '[Token Saver] compressed 100B → 50B (-50%) · via ansi-strip'
    ].join('\n')
    const parsed = parseTokenSaverFooter(raw)
    expect(parsed!.body).toBe(
      'stdout contents\n--- stderr ---\nstderr contents'
    )
  })

  it('does not mis-match unrelated [Token Saver] in body', () => {
    const raw = 'the [Token Saver] is amazing\n(no real footer here)'
    expect(parseTokenSaverFooter(raw)).toBeNull()
  })
})

describe('formatBytes', () => {
  it('formats bytes correctly', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB')
  })

  it('handles invalid input', () => {
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(NaN)).toBe('0 B')
    expect(formatBytes(Infinity)).toBe('0 B')
  })
})
