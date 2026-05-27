import { describe, expect, it } from 'vitest'
import { buildXuanpuAgentHarnessMetrics } from '../../src/main/services/xuanpu-agent/harness/metrics'

describe('xuanpu-agent harness metrics', () => {
  it('derives provider cache hit ratio from Anthropic-style usage', () => {
    const metrics = buildXuanpuAgentHarnessMetrics({
      now: 1760000000000,
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 120,
        cache_read_input_tokens: 700
      },
      toolNames: ['git_status', 'read_file', 'write_file'],
      isParallelSafeTool: (name) => name !== 'write_file',
      budgetState: {
        shrinkCount: 1,
        emergencyShrunk: false,
        totalBeforeBytes: 1000,
        totalAfterBytes: 250
      }
    })

    expect(metrics).toMatchObject({
      capturedAt: 1760000000000,
      cache: {
        inputTokens: 1000,
        totalInputTokens: 1820,
        cacheReadTokens: 700,
        cacheWriteTokens: 120,
        source: 'provider-usage'
      },
      parallelTools: {
        totalToolCalls: 3,
        parallelSafeToolCalls: 2,
        serialToolCalls: 1,
        parallelSafeRatio: 2 / 3
      },
      compaction: {
        shrinkCount: 1,
        emergencyShrunk: false,
        compressionRatio: 0.75
      }
    })
    expect(metrics.cache.hitRatio).toBeCloseTo(700 / 1820)
  })

  it('reads OpenAI-style nested cached token details', () => {
    const metrics = buildXuanpuAgentHarnessMetrics({
      usage: {
        prompt_tokens: 500,
        completion_tokens: 100,
        prompt_tokens_details: { cached_tokens: 125 }
      },
      toolNames: [],
      isParallelSafeTool: () => false,
      budgetState: {
        shrinkCount: 0,
        emergencyShrunk: false,
        totalBeforeBytes: 0,
        totalAfterBytes: 0
      }
    })

    expect(metrics.cache).toMatchObject({
      inputTokens: 500,
      totalInputTokens: 500,
      cacheReadTokens: 125,
      hitRatio: 0.25,
      source: 'provider-usage'
    })
    expect(metrics.parallelTools.parallelSafeRatio).toBeNull()
    expect(metrics.compaction.compressionRatio).toBeNull()
  })

  it('marks cache metrics unavailable when provider usage has no token fields', () => {
    const metrics = buildXuanpuAgentHarnessMetrics({
      usage: { custom: 'ok' },
      toolNames: ['run_test'],
      isParallelSafeTool: () => false,
      budgetState: {
        shrinkCount: 0,
        emergencyShrunk: false,
        totalBeforeBytes: 0,
        totalAfterBytes: 0
      }
    })

    expect(metrics.cache).toEqual({
      inputTokens: null,
      totalInputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      hitRatio: null,
      source: 'unavailable'
    })
    expect(metrics.parallelTools).toMatchObject({
      totalToolCalls: 1,
      parallelSafeToolCalls: 0,
      serialToolCalls: 1,
      parallelSafeRatio: 0
    })
  })
})
