import { describe, test, expect, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { useContextStore } from '../../../src/renderer/src/stores/useContextStore'
import { applySessionContextUsage } from '../../../src/renderer/src/lib/context-usage'
import {
  extractTokens,
  extractCost,
  extractCostEventKey,
  extractModelRef
} from '../../../src/renderer/src/lib/token-utils'
import { getCanonicalModelLabel, resolveRuntimeModelId } from '../../../src/shared/usage/models'

beforeEach(() => {
  vi.clearAllMocks()

  useContextStore.setState({
    tokensBySession: {},
    modelBySession: {},
    contextSnapshotsBySession: {},
    costBySession: {},
    costEventKeysBySession: {},
    modelLimits: {}
  })
})

describe('Session 1: Context Calculation Fix', () => {
  describe('useContextStore', () => {
    test('setSessionTokens replaces (not accumulates) tokens', () => {
      const store = useContextStore.getState()
      act(() => {
        store.setSessionTokens('s1', {
          input: 100,
          output: 50,
          reasoning: 10,
          cacheRead: 30,
          cacheWrite: 20
        })
      })
      act(() => {
        store.setSessionTokens('s1', {
          input: 200,
          output: 80,
          reasoning: 0,
          cacheRead: 50,
          cacheWrite: 10
        })
      })
      const usage = store.getContextUsage('s1', 'model1')
      // Context window = input + cacheRead + cacheWrite = 200+50+10 = 260
      // (output and reasoning excluded — they don't occupy the context window)
      expect(usage.used).toBe(260)
    })

    test('getContextUsage computes correct total with all 5 categories', () => {
      const store = useContextStore.getState()
      act(() => {
        store.setModelLimit('model1', 200000)
        store.setSessionTokens('s1', {
          input: 15000,
          output: 2000,
          reasoning: 500,
          cacheRead: 3000,
          cacheWrite: 1500
        })
      })
      const usage = store.getContextUsage('s1', 'model1')
      // Context window = input + cacheRead + cacheWrite = 15000+3000+1500 = 19500
      expect(usage.used).toBe(19500)
      expect(usage.percent).toBe(10) // Math.round(19500/200000*100)
    })

    test('cost tracks per session', () => {
      const store = useContextStore.getState()
      act(() => {
        store.setSessionCost('s1', 0.01)
        store.addSessionCost('s1', 0.005)
      })
      const usage = store.getContextUsage('s1', 'model1')
      expect(usage.cost).toBeCloseTo(0.015)
    })

    test('resetSessionTokens clears both tokens and cost', () => {
      const store = useContextStore.getState()
      act(() => {
        store.setSessionTokens('s1', {
          input: 100,
          output: 50,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0
        })
        store.setSessionCost('s1', 0.01)
      })

      act(() => {
        store.resetSessionTokens('s1')
      })

      expect(useContextStore.getState().tokensBySession['s1']).toBeUndefined()
      expect(useContextStore.getState().costBySession['s1']).toBeUndefined()
    })

    test('addSessionCost initializes from zero for new session', () => {
      const store = useContextStore.getState()
      act(() => {
        store.addSessionCost('s1', 0.005)
      })
      expect(useContextStore.getState().costBySession['s1']).toBeCloseTo(0.005)
    })

    test('setSessionCost replaces existing cost', () => {
      const store = useContextStore.getState()
      act(() => {
        store.setSessionCost('s1', 0.01)
        store.setSessionCost('s1', 0.02)
      })
      expect(useContextStore.getState().costBySession['s1']).toBeCloseTo(0.02)
    })

    test('addSessionCostOnce de-duplicates repeated cost events', () => {
      const store = useContextStore.getState()
      act(() => {
        store.addSessionCostOnce('s1', 'request:abc', 0.14)
        store.addSessionCostOnce('s1', 'request:abc', 0.14)
        store.addSessionCostOnce('s1', 'request:def', 0.14)
      })

      expect(useContextStore.getState().costBySession['s1']).toBeCloseTo(0.28)
    })

    test('usage percent is 0 when no limit set', () => {
      const store = useContextStore.getState()
      act(() => {
        store.setSessionTokens('s1', {
          input: 1000,
          output: 500,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0
        })
      })
      const usage = store.getContextUsage('s1', 'unknown-model')
      // Context window = input only (no cache) = 1000
      expect(usage.used).toBe(1000)
      expect(usage.percent).toBeNull()
    })

    test('usage percent can exceed 100 when context over limit', () => {
      const store = useContextStore.getState()
      act(() => {
        store.setModelLimit('model1', 100)
        store.setSessionTokens('s1', {
          input: 200,
          output: 100,
          reasoning: 50,
          cacheRead: 0,
          cacheWrite: 0
        })
      })
      const usage = store.getContextUsage('s1', 'model1')
      // Context window = input only = 200 (output/reasoning excluded)
      expect(usage.percent).toBe(200)
    })

    test('context usage uses snapshot model identity over caller model id', () => {
      const store = useContextStore.getState()

      act(() => {
        store.setModelLimit('claude-sonnet-4-20250514', 200000, 'anthropic')
        store.setModelLimit('gpt-4o', 128000, 'openai')
        store.setSessionTokens(
          's1',
          {
            input: 10000,
            output: 2000,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0
          },
          {
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-20250514'
          }
        )
      })

      // Pass a different fallback model id. Store should still use snapshot model limit.
      const usage = store.getContextUsage('s1', 'gpt-4o', 'openai')
      expect(usage.limit).toBe(200000)
      // Context window = input only = 10000 (output excluded)
      expect(usage.percent).toBe(5)
    })

    test('context limits are provider+model scoped for duplicate model ids', () => {
      const store = useContextStore.getState()

      act(() => {
        store.setModelLimit('same-model', 100000, 'provider-a')
        store.setModelLimit('same-model', 300000, 'provider-b')
        store.setSessionTokens(
          's1',
          {
            input: 60000,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0
          },
          {
            providerID: 'provider-b',
            modelID: 'same-model'
          }
        )
      })

      const usage = store.getContextUsage('s1', 'same-model', 'provider-a')
      expect(usage.limit).toBe(300000)
      expect(usage.percent).toBe(20)
    })

    test('context window percentage excludes output and reasoning tokens', () => {
      const store = useContextStore.getState()
      act(() => {
        store.setModelLimit('model1', 200000)
        store.setSessionTokens('s1', {
          input: 50000,
          output: 30000,
          reasoning: 20000,
          cacheRead: 10000,
          cacheWrite: 5000
        })
      })
      const usage = store.getContextUsage('s1', 'model1')
      // Context window = input + cacheRead + cacheWrite = 65000
      // Output (30000) and reasoning (20000) are NOT counted
      expect(usage.used).toBe(65000)
      expect(usage.percent).toBe(33) // Math.round(65000/200000*100)
    })

    test('runtime context snapshot takes precedence over token snapshot totals', () => {
      const store = useContextStore.getState()

      act(() => {
        store.setModelLimit('opus', 200000, 'anthropic')
        store.setSessionTokens(
          's1',
          {
            input: 190000,
            output: 1200,
            reasoning: 0,
            cacheRead: 4000,
            cacheWrite: 2000
          },
          {
            providerID: 'anthropic',
            modelID: 'opus'
          }
        )
      })

      applySessionContextUsage('s1', {
        tokens: { input: 0, output: 0 },
        model: { providerID: 'anthropic', modelID: 'opus' },
        contextWindow: 200000,
        breakdown: {
          usedTokens: 50000,
          maxTokens: 200000,
          percentage: 25,
          categories: [{ name: 'Messages', tokens: 50000, color: '#237a68' }]
        }
      })

      const usage = store.getContextUsage('s1', 'opus', 'anthropic')
      expect(usage.used).toBe(50000)
      expect(usage.percent).toBe(25)
      expect(usage.source).toBe('runtime')
      expect(usage.categories?.[0]).toMatchObject({ name: 'Messages', tokens: 50000 })
      expect(usage.tokens.input).toBe(190000)
    })

    test('compaction refresh keeps previous snapshot until a new authoritative usage arrives', () => {
      const store = useContextStore.getState()

      act(() => {
        store.setSessionContextSnapshot('s1', {
          usedTokens: 120000,
          maxTokens: 200000,
          percent: 60,
          model: { providerID: 'anthropic', modelID: 'opus' }
        })
        store.setSessionContextRefreshing('s1', true)
      })

      let usage = store.getContextUsage('s1', 'opus', 'anthropic')
      expect(usage.used).toBe(120000)
      expect(usage.percent).toBe(60)
      expect(usage.isRefreshing).toBe(true)

      applySessionContextUsage('s1', {
        tokens: { input: 0, output: 0 },
        model: { providerID: 'anthropic', modelID: 'opus' },
        contextWindow: 200000,
        breakdown: {
          usedTokens: 30000,
          maxTokens: 200000,
          rawMaxTokens: 1000000,
          percentage: 15
        }
      })

      usage = store.getContextUsage('s1', 'opus', 'anthropic')
      expect(usage.used).toBe(30000)
      expect(usage.percent).toBe(15)
      expect(usage.rawMaxTokens).toBe(1000000)
      expect(usage.isRefreshing).toBe(false)
    })
  })

  describe('extractTokens', () => {
    test('parses standard token format', () => {
      const result = extractTokens({
        tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 30, write: 20 } }
      })
      expect(result).toEqual({
        input: 100,
        output: 50,
        reasoning: 10,
        cacheRead: 30,
        cacheWrite: 20
      })
    })

    test('returns null when no tokens', () => {
      expect(extractTokens({})).toBeNull()
    })

    test('returns null when all zeros', () => {
      const result = extractTokens({
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      })
      expect(result).toBeNull()
    })

    test('handles missing cache field', () => {
      const result = extractTokens({ tokens: { input: 100, output: 50 } })
      expect(result).toEqual({ input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    })

    test('handles missing reasoning field', () => {
      const result = extractTokens({
        tokens: { input: 100, output: 50, cache: { read: 10, write: 5 } }
      })
      expect(result).toEqual({ input: 100, output: 50, reasoning: 0, cacheRead: 10, cacheWrite: 5 })
    })

    test('handles partial cache field', () => {
      const result = extractTokens({ tokens: { input: 100, output: 50, cache: { read: 10 } } })
      expect(result).toEqual({ input: 100, output: 50, reasoning: 0, cacheRead: 10, cacheWrite: 0 })
    })

    test('handles tokens field as undefined', () => {
      expect(extractTokens({ tokens: undefined })).toBeNull()
    })

    test('parses tokens nested under info (DB/streaming format)', () => {
      const result = extractTokens({
        info: {
          tokens: { input: 500, output: 200, reasoning: 50, cache: { read: 100, write: 30 } }
        }
      })
      expect(result).toEqual({
        input: 500,
        output: 200,
        reasoning: 50,
        cacheRead: 100,
        cacheWrite: 30
      })
    })

    test('prefers top-level tokens over info.tokens', () => {
      const result = extractTokens({
        tokens: { input: 100, output: 50 },
        info: { tokens: { input: 999, output: 999 } }
      })
      expect(result).toEqual({
        input: 100,
        output: 50,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0
      })
    })

    test('parses Claude usage payload with raw *_tokens fields', () => {
      const result = extractTokens({
        info: {
          usage: {
            input_tokens: 42,
            output_tokens: 7,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 500
          }
        }
      })

      expect(result).toEqual({
        input: 42,
        output: 7,
        reasoning: 0,
        cacheRead: 1000,
        cacheWrite: 500
      })
    })

    test('parses Claude statusline context_window.current_usage shape', () => {
      const result = extractTokens({
        context_window: {
          total_input_tokens: 999999,
          total_output_tokens: 888888,
          current_usage: {
            input_tokens: 1200,
            output_tokens: 150,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 200
          }
        }
      })

      expect(result).toEqual({
        input: 1200,
        output: 150,
        reasoning: 0,
        cacheRead: 300,
        cacheWrite: 200
      })
    })
  })

  describe('extractCost', () => {
    test('extracts numeric cost', () => {
      expect(extractCost({ cost: 0.025 })).toBe(0.025)
    })

    test('returns 0 for missing cost', () => {
      expect(extractCost({})).toBe(0)
    })

    test('returns 0 for non-numeric cost', () => {
      expect(extractCost({ cost: 'high' })).toBe(0)
    })

    test('returns 0 for null cost', () => {
      expect(extractCost({ cost: null })).toBe(0)
    })

    test('extracts cost nested under info', () => {
      expect(extractCost({ info: { cost: 0.035 } })).toBe(0.035)
    })

    test('prefers top-level cost over info.cost', () => {
      expect(extractCost({ cost: 0.01, info: { cost: 0.99 } })).toBe(0.01)
    })
  })

  describe('extractCostEventKey', () => {
    test('prefers requestId when present', () => {
      expect(
        extractCostEventKey({
          requestId: 'req-1',
          id: 'msg-1',
          info: { usage: { input: 3, output: 66, cacheCreation: 37719 } }
        })
      ).toBe('request:req-1')
    })

    test('falls back to message id and usage signature', () => {
      expect(extractCostEventKey({ id: 'msg-1' })).toBe('message:msg-1')
      expect(
        extractCostEventKey({
          role: 'assistant',
          info: {
            model: 'claude-sonnet-4-6',
            usage: {
              input: 3,
              output: 66,
              cacheRead: 0,
              cacheCreation: 37719
            }
          }
        })
      ).toBe('usage:claude-sonnet-4-6:3:66:0:37719')
    })
  })

  describe('extractModelRef', () => {
    test('extracts provider/model from top-level fields', () => {
      const result = extractModelRef({ providerID: 'anthropic', modelID: 'claude-sonnet-4' })
      expect(result).toEqual({ providerID: 'anthropic', modelID: 'sonnet' })
    })

    test('extracts provider/model from nested info fields', () => {
      const result = extractModelRef({
        info: {
          providerID: 'openai',
          modelID: 'gpt-4o'
        }
      })
      expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4o' })
    })

    test('returns null when model identity is missing', () => {
      expect(extractModelRef({})).toBeNull()
    })

    test('parses provider/model from info.model string', () => {
      const result = extractModelRef({
        info: {
          model: 'anthropic/claude-sonnet-4-5-20250929'
        }
      })

      expect(result).toEqual({
        providerID: 'anthropic',
        modelID: 'sonnet'
      })
    })

    test('uses fallback provider for provider-less Claude model strings', () => {
      const result = extractModelRef(
        {
          info: {
            model: 'claude-opus-4-7'
          }
        },
        'anthropic'
      )

      expect(result).toEqual({
        providerID: 'anthropic',
        modelID: 'opus'
      })
    })
  })

  describe('model normalization', () => {
    test('normalizes Claude runtime ids and labels consistently', () => {
      expect(resolveRuntimeModelId('opus', 'anthropic')).toBe('opus')
      expect(resolveRuntimeModelId('claude-opus-4-7', 'anthropic')).toBe('opus')
      expect(resolveRuntimeModelId('anthropic/claude-opus-4-7', 'anthropic')).toBe('opus')
      expect(resolveRuntimeModelId('claude-sonnet-4-6', 'anthropic')).toBe('sonnet')

      expect(getCanonicalModelLabel('opus', 'anthropic')).toBe('Opus 4.7')
      expect(getCanonicalModelLabel('claude-opus-4-7', 'anthropic')).toBe('Opus 4.7')
      expect(getCanonicalModelLabel('anthropic/claude-opus-4-7', 'anthropic')).toBe('Opus 4.7')
      expect(getCanonicalModelLabel('claude-sonnet-4-6', 'anthropic')).toBe('Sonnet 4.6')
    })
  })
})
