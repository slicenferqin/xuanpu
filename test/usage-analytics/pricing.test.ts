import { describe, expect, it } from 'vitest'
import {
  calculateUsageCost,
  getUsagePricing,
  normalizePricingModelKey,
  resolvePricingModelKey
} from '../../src/shared/usage/pricing'

describe('usage pricing resolver', () => {
  it('normalizes provider-prefixed model names', () => {
    expect(normalizePricingModelKey('anthropic/claude-sonnet-4-6-20260219')).toBe(
      'claude-sonnet-4-6'
    )
    expect(normalizePricingModelKey('anthropic.claude-opus-4-6-v1:0')).toBe('claude-opus-4-6')
  })

  it('resolves Claude aliases to the latest catalog entry', () => {
    expect(resolvePricingModelKey('opus', 'claude-code')).toBe('opus')
    expect(resolvePricingModelKey('claude-sonnet-4-6-20260219', 'claude-code')).toBe(
      'claude-sonnet-4-6'
    )
    expect(getUsagePricing('haiku', 'claude-code')).toEqual({
      input: 1,
      output: 5,
      cacheWrite: 1.25,
      cacheRead: 0.1
    })
  })

  it('resolves Codex models and calculates cache-aware cost', () => {
    expect(resolvePricingModelKey('openai/gpt-5.3-codex')).toBe('gpt-5.3-codex')

    const cost = calculateUsageCost(
      'gpt-5.4',
      {
        input: 1_000_000,
        output: 100_000,
        cacheWrite: 10_000,
        cacheRead: 200_000
      },
      'codex'
    )

    expect(cost).toBeCloseTo(4.05, 6)
  })

  it('falls back to zero pricing for unknown models', () => {
    expect(getUsagePricing('mystery-model', 'codex')).toEqual({
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0
    })
    expect(
      calculateUsageCost(
        'mystery-model',
        {
          input: 100,
          output: 100,
          cacheWrite: 100,
          cacheRead: 100
        },
        'codex'
      )
    ).toBe(0)
  })
})
