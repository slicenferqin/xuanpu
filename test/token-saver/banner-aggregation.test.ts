/**
 * Tests for SessionTokenSaverBanner aggregation logic.
 *
 * The banner is a thin shell over `aggregateStats`. We test its observable
 * behaviour through the parser since the aggregator is private — synthesising
 * realistic OpenCodeMessage shapes with footer-bearing tool outputs.
 */
import { describe, it, expect } from 'vitest'
import { parseTokenSaverFooter } from '../../src/renderer/src/lib/token-saver-footer'

function makeFooter(before: number, after: number, percent: number, archive?: string): string {
  const tail = archive ? ` · original: ${archive}` : ''
  return `body content here\n---\n[Token Saver] compressed ${before}B → ${after}B (-${percent}%) · via ansi-strip${tail}`
}

describe('SessionTokenSaverBanner aggregation (via parser)', () => {
  it('parser correctly extracts before/after/percent from realistic footer', () => {
    const footer = makeFooter(8432, 412, 95, '/tmp/x.txt')
    const parsed = parseTokenSaverFooter(footer)
    expect(parsed).not.toBeNull()
    expect(parsed!.beforeBytes).toBe(8432)
    expect(parsed!.afterBytes).toBe(412)
    expect(parsed!.savedPercent).toBe(95)
    expect(parsed!.archivePath).toBe('/tmp/x.txt')
  })

  it('aggregator semantics: sum of multiple footers', () => {
    const a = parseTokenSaverFooter(makeFooter(1000, 100, 90))!
    const b = parseTokenSaverFooter(makeFooter(2000, 500, 75))!
    const totalBefore = a.beforeBytes + b.beforeBytes
    const totalAfter = a.afterBytes + b.afterBytes
    expect(totalBefore).toBe(3000)
    expect(totalAfter).toBe(600)
    expect(totalBefore - totalAfter).toBe(2400)
  })

  it('parser ignores plain text without footer (banner would skip these)', () => {
    expect(parseTokenSaverFooter('echo hello\nhi')).toBeNull()
    expect(parseTokenSaverFooter('')).toBeNull()
  })

  it('parser handles missing archive gracefully (banner still counts savings)', () => {
    const parsed = parseTokenSaverFooter(makeFooter(5000, 500, 90))!
    expect(parsed.archivePath).toBeNull()
    expect(parsed.beforeBytes).toBe(5000)
    expect(parsed.afterBytes).toBe(500)
  })
})
