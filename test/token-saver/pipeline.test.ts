/**
 * Tests for OutputCompressionPipeline (Token Saver stage 1).
 *
 * Covers:
 *   - Constructor validation (rejects malformed strategies)
 *   - Empty / no-op input
 *   - Strategy ordering (run in declaration order)
 *   - Failure isolation (a throwing strategy is skipped, not propagated)
 *   - Malformed strategy result is skipped
 *   - ruleHits records hits in order with hints
 *   - Idempotency: running twice produces the same result
 */
import { describe, it, expect, vi } from 'vitest'
import {
  OutputCompressionPipeline,
  isOutputStrategy,
  type OutputStrategy
} from '../../src/main/services/token-saver/pipeline'

const passthrough: OutputStrategy = {
  name: 'noop',
  apply: (text) => ({ changed: false, text })
}

const upper: OutputStrategy = {
  name: 'upper',
  apply: (text) => ({ changed: true, text: text.toUpperCase(), hint: 'uppercased' })
}

const trim: OutputStrategy = {
  name: 'trim',
  apply: (text) => {
    const t = text.trim()
    return t === text ? { changed: false, text } : { changed: true, text: t }
  }
}

const thrower: OutputStrategy = {
  name: 'boom',
  apply: () => {
    throw new Error('intentional')
  }
}

describe('isOutputStrategy', () => {
  it('accepts a valid strategy', () => {
    expect(isOutputStrategy(passthrough)).toBe(true)
  })
  it('rejects null / non-object / missing fields', () => {
    expect(isOutputStrategy(null)).toBe(false)
    expect(isOutputStrategy(undefined)).toBe(false)
    expect(isOutputStrategy(42)).toBe(false)
    expect(isOutputStrategy({})).toBe(false)
    expect(isOutputStrategy({ name: 'x' })).toBe(false)
    expect(isOutputStrategy({ apply: () => ({ changed: false, text: '' }) })).toBe(false)
  })
})

describe('OutputCompressionPipeline', () => {
  it('constructor throws on malformed strategy', () => {
    // @ts-expect-error intentional bad input
    expect(() => new OutputCompressionPipeline([{}])).toThrow(/invalid strategy/)
  })

  it('handles empty input string', () => {
    const p = new OutputCompressionPipeline([upper])
    const r = p.run('')
    expect(r.text).toBe('')
    expect(r.beforeBytes).toBe(0)
    expect(r.afterBytes).toBe(0)
    expect(r.ruleHits).toEqual([])
  })

  it('handles undefined input safely', () => {
    const p = new OutputCompressionPipeline([upper])
    // @ts-expect-error intentional: some callers may pass null
    const r = p.run(null as string)
    expect(r.text).toBe('')
  })

  it('passes through unchanged when no strategy fires', () => {
    const p = new OutputCompressionPipeline([passthrough, passthrough])
    const r = p.run('hello world')
    expect(r.text).toBe('hello world')
    expect(r.ruleHits).toEqual([])
  })

  it('applies strategies in declaration order', () => {
    // trim then upper: '  hi  ' → 'hi' → 'HI'
    const p = new OutputCompressionPipeline([trim, upper])
    const r = p.run('  hi  ')
    expect(r.text).toBe('HI')
    expect(r.ruleHits.map((h) => h.name)).toEqual(['trim', 'upper'])
  })

  it('records hint in ruleHits', () => {
    const p = new OutputCompressionPipeline([upper])
    const r = p.run('foo')
    expect(r.ruleHits[0]).toEqual({ name: 'upper', hint: 'uppercased' })
  })

  it('isolates a throwing strategy and continues', () => {
    const logger = { warn: vi.fn() }
    const p = new OutputCompressionPipeline([upper, thrower, trim], logger)
    const r = p.run('  hi  ')
    expect(r.text).toBe('HI') // upper fires; thrower skipped; trim sees 'HI' (no leading/trailing space)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('strategy threw'),
      expect.objectContaining({ name: 'boom' })
    )
  })

  it('skips strategy returning malformed result', () => {
    const logger = { warn: vi.fn() }
    const broken: OutputStrategy = {
      name: 'broken',
      // @ts-expect-error intentional bad return
      apply: () => ({ changed: true })
    }
    const p = new OutputCompressionPipeline([broken, upper], logger)
    const r = p.run('hi')
    expect(r.text).toBe('HI')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('malformed result'),
      expect.objectContaining({ name: 'broken' })
    )
  })

  it('is idempotent: running twice yields the same result', () => {
    const p = new OutputCompressionPipeline([trim, upper])
    const a = p.run('  hi  ')
    const b = p.run('  hi  ')
    expect(a).toEqual(b)
  })

  it('reports correct byte counts (UTF-8 multi-byte)', () => {
    const p = new OutputCompressionPipeline([passthrough])
    const r = p.run('字段内存')
    // 4 Chinese chars × 3 bytes each = 12 bytes
    expect(r.beforeBytes).toBe(12)
    expect(r.afterBytes).toBe(12)
  })

  it('exposes strategy names for inspection', () => {
    const p = new OutputCompressionPipeline([upper, trim])
    expect(p.strategyNames).toEqual(['upper', 'trim'])
  })
})
