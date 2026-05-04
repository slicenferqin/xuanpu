/**
 * Tests for the 5 built-in compression strategies.
 *
 * Each strategy gets:
 *   - happy path (canonical input → expected transformation)
 *   - no-trigger case (returns changed:false without altering text)
 *   - edge case (empty / very short / pathological input)
 *
 * Strategy order in the default pipeline is also asserted at the end.
 */
import { describe, it, expect } from 'vitest'
import {
  ansiStripStrategy,
  progressDedupStrategy,
  ndjsonSummaryStrategy,
  failureFocusStrategy,
  statsExtractionStrategy,
  DEFAULT_STRATEGIES
} from '../../src/main/services/token-saver/strategies'
import { defaultPipeline, __resetDefaultPipelineForTest } from '../../src/main/services/token-saver'

const ctx = {}

describe('ansiStripStrategy', () => {
  it('strips SGR colour codes', () => {
    const r = ansiStripStrategy.apply('\x1b[31mERROR\x1b[0m: boom', ctx)
    expect(r.changed).toBe(true)
    expect(r.text).toBe('ERROR: boom')
  })

  it('strips OSC sequences', () => {
    const r = ansiStripStrategy.apply('hi\x1b]0;title\x07world', ctx)
    expect(r.changed).toBe(true)
    expect(r.text).toBe('hiworld')
  })

  it('no-op on plain text', () => {
    const r = ansiStripStrategy.apply('plain text', ctx)
    expect(r.changed).toBe(false)
    expect(r.text).toBe('plain text')
  })

  it('handles empty input', () => {
    expect(ansiStripStrategy.apply('', ctx)).toEqual({ changed: false, text: '' })
  })
})

describe('progressDedupStrategy', () => {
  it('collapses repeated identical lines', () => {
    const input = Array(10).fill('downloading foo@1.0.0').join('\n')
    const r = progressDedupStrategy.apply(input, ctx)
    expect(r.changed).toBe(true)
    expect(r.text).toContain('×10')
    expect(r.text).not.toContain(Array(5).fill('downloading foo@1.0.0').join('\n'))
  })

  it('does not collapse runs of <4 identical lines', () => {
    const input = 'foo\nfoo\nfoo'
    const r = progressDedupStrategy.apply(input, ctx)
    expect(r.changed).toBe(false)
  })

  it('collapses bare-CR progress redraws', () => {
    const input = 'a\rb\rc\nfinal'
    const r = progressDedupStrategy.apply(input, ctx)
    expect(r.changed).toBe(true)
    // Greedy match eats 'a\rb\r' (everything up to last \r in the line),
    // leaving 'c' as the final visible state of the redrawn line.
    expect(r.text).toBe('c\nfinal')
  })

  it('skips short input', () => {
    const r = progressDedupStrategy.apply('x', ctx)
    expect(r.changed).toBe(false)
  })

  it('preserves blank-line runs (does not dedup empties as content)', () => {
    const input = 'a\n\n\n\n\nb'
    const r = progressDedupStrategy.apply(input, ctx)
    // Empty lines are skipped from the dedup count by the trim() check
    expect(r.text).toBe(input)
  })
})

describe('ndjsonSummaryStrategy', () => {
  it('summarises a long ndjson stream by level', () => {
    const lines: string[] = []
    for (let i = 0; i < 50; i++) {
      lines.push(JSON.stringify({ level: i % 5 === 0 ? 'error' : 'info', msg: `m${i}` }))
    }
    const input = lines.join('\n')
    const r = ndjsonSummaryStrategy.apply(input, ctx)
    expect(r.changed).toBe(true)
    expect(r.text).toContain('ndjson summary')
    expect(r.text).toContain('error=10')
    expect(r.text).toContain('info=40')
    expect(r.text.length).toBeLessThan(input.length)
  })

  it('does not fire when fewer than 10 lines', () => {
    const input = Array(8).fill('{"a":1}').join('\n')
    const r = ndjsonSummaryStrategy.apply(input, ctx)
    expect(r.changed).toBe(false)
  })

  it('does not fire when input is small (under MIN_COMPRESS_BYTES)', () => {
    const input = '{"a":1}\n{"a":2}'
    const r = ndjsonSummaryStrategy.apply(input, ctx)
    expect(r.changed).toBe(false)
  })

  it('does not fire when most lines are not JSON', () => {
    const lines: string[] = []
    for (let i = 0; i < 30; i++) lines.push('not json line ' + 'x'.repeat(50))
    const r = ndjsonSummaryStrategy.apply(lines.join('\n'), ctx)
    expect(r.changed).toBe(false)
  })
})

describe('failureFocusStrategy', () => {
  it('keeps lines around failure markers when exit code != 0', () => {
    const lines: string[] = []
    for (let i = 0; i < 100; i++) lines.push(`pass test ${i}: ${'x'.repeat(20)}`)
    lines[50] = 'FAIL: division by zero'
    const input = lines.join('\n')
    const r = failureFocusStrategy.apply(input, { exitCode: 1 })
    expect(r.changed).toBe(true)
    expect(r.text).toContain('FAIL: division by zero')
    expect(r.text).toContain('lines omitted')
    expect(r.text.length).toBeLessThan(input.length)
  })

  it('does not fire on small output', () => {
    const r = failureFocusStrategy.apply('error: tiny', { exitCode: 1 })
    expect(r.changed).toBe(false)
  })

  it('does not fire when exit==0 and no failure markers', () => {
    const lines = Array(50).fill('all good ' + 'x'.repeat(40))
    const r = failureFocusStrategy.apply(lines.join('\n'), { exitCode: 0 })
    expect(r.changed).toBe(false)
  })

  it('fires without exitCode if failure markers present', () => {
    const lines = Array(50).fill('all good ' + 'x'.repeat(40))
    lines[25] = 'Exception: something exploded'
    const r = failureFocusStrategy.apply(lines.join('\n'), {})
    expect(r.changed).toBe(true)
  })
})

describe('statsExtractionStrategy', () => {
  it('extracts vitest summary and trims body', () => {
    const lines: string[] = []
    for (let i = 0; i < 80; i++) lines.push(`test case ${i}: ok ` + 'y'.repeat(30))
    lines.push('')
    lines.push(' Test Files  4 passed (4)')
    lines.push(' Tests  71 passed (71)')
    const input = lines.join('\n')
    const r = statsExtractionStrategy.apply(input, { exitCode: 0 })
    expect(r.changed).toBe(true)
    expect(r.text).toMatch(/summary:.*passed/)
    expect(r.text.length).toBeLessThan(input.length)
  })

  it('does not fire on failed runs (FailureFocus owns that)', () => {
    const lines: string[] = []
    for (let i = 0; i < 80; i++) lines.push(`line ${i}: ` + 'x'.repeat(30))
    lines.push('Tests:  3 passed, 1 failed')
    const r = statsExtractionStrategy.apply(lines.join('\n'), { exitCode: 1 })
    expect(r.changed).toBe(false)
  })

  it('does not fire when no summary line is present', () => {
    const lines = Array(60).fill('plain log line ' + 'x'.repeat(30))
    const r = statsExtractionStrategy.apply(lines.join('\n'), { exitCode: 0 })
    expect(r.changed).toBe(false)
  })
})

describe('default pipeline composition', () => {
  it('exposes the 5 strategies in expected order', () => {
    expect(DEFAULT_STRATEGIES.map((s) => s.name)).toEqual([
      'ansi-strip',
      'progress-dedup',
      'ndjson-summary',
      'failure-focus',
      'stats-extraction'
    ])
  })

  it('memoises the default pipeline', () => {
    __resetDefaultPipelineForTest()
    const a = defaultPipeline()
    const b = defaultPipeline()
    expect(a).toBe(b)
  })

  it('end-to-end: ANSI noise + repeated lines compresses', () => {
    __resetDefaultPipelineForTest()
    const lines: string[] = []
    for (let i = 0; i < 20; i++) lines.push('\x1b[32m  spam line\x1b[0m')
    lines.push('done')
    const input = lines.join('\n')
    const r = defaultPipeline().run(input)
    expect(r.afterBytes).toBeLessThan(r.beforeBytes)
    expect(r.ruleHits.map((h) => h.name)).toContain('ansi-strip')
    expect(r.ruleHits.map((h) => h.name)).toContain('progress-dedup')
  })
})
