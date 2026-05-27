import type { BudgetState } from '../context/budget-manager'

export interface XuanpuAgentHarnessMetrics {
  capturedAt: number
  cache: {
    inputTokens: number | null
    totalInputTokens: number | null
    cacheReadTokens: number | null
    cacheWriteTokens: number | null
    hitRatio: number | null
    source: 'provider-usage' | 'unavailable'
  }
  parallelTools: {
    totalToolCalls: number
    parallelSafeToolCalls: number
    serialToolCalls: number
    parallelSafeRatio: number | null
  }
  compaction: {
    shrinkCount: number
    emergencyShrunk: boolean
    compressionRatio: number | null
    totalBeforeBytes: number
    totalAfterBytes: number
  }
}

export interface HarnessMetricsInput {
  usage?: Record<string, unknown>
  toolNames: readonly string[]
  isParallelSafeTool: (toolName: string) => boolean
  budgetState: Pick<
    BudgetState,
    'shrinkCount' | 'emergencyShrunk' | 'totalBeforeBytes' | 'totalAfterBytes'
  >
  now?: number
}

export function buildXuanpuAgentHarnessMetrics(
  input: HarnessMetricsInput
): XuanpuAgentHarnessMetrics {
  const tokenUsage = extractCacheTokenUsage(input.usage)
  const totalToolCalls = input.toolNames.length
  const parallelSafeToolCalls = input.toolNames.filter(input.isParallelSafeTool).length
  const serialToolCalls = Math.max(0, totalToolCalls - parallelSafeToolCalls)
  const compressionRatio =
    input.budgetState.totalBeforeBytes > 0
      ? clampRatio(1 - input.budgetState.totalAfterBytes / input.budgetState.totalBeforeBytes)
      : null

  return {
    capturedAt: input.now ?? Date.now(),
    cache: tokenUsage,
    parallelTools: {
      totalToolCalls,
      parallelSafeToolCalls,
      serialToolCalls,
      parallelSafeRatio:
        totalToolCalls > 0 ? clampRatio(parallelSafeToolCalls / totalToolCalls) : null
    },
    compaction: {
      shrinkCount: input.budgetState.shrinkCount,
      emergencyShrunk: input.budgetState.emergencyShrunk,
      compressionRatio,
      totalBeforeBytes: input.budgetState.totalBeforeBytes,
      totalAfterBytes: input.budgetState.totalAfterBytes
    }
  }
}

function extractCacheTokenUsage(
  usage: Record<string, unknown> | undefined
): XuanpuAgentHarnessMetrics['cache'] {
  if (!usage) {
    return {
      inputTokens: null,
      totalInputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      hitRatio: null,
      source: 'unavailable'
    }
  }

  const inputTokens = firstFiniteNumber(usage, [
    'input_tokens',
    'inputTokens',
    'prompt_tokens',
    'promptTokens',
    'input'
  ])
  const cacheReadTokens =
    firstFiniteNumber(usage, [
      'cache_read_input_tokens',
      'cacheReadInputTokens',
      'cache_read_tokens',
      'cacheReadTokens',
      'cached_tokens',
      'cachedTokens'
    ]) ?? firstFiniteNumber(nestedRecord(usage, 'prompt_tokens_details'), ['cached_tokens'])
  const cacheWriteTokens = firstFiniteNumber(usage, [
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
    'cache_write_tokens',
    'cacheWriteTokens'
  ])
  const separateCacheCounters =
    hasOwnNumber(usage, 'cache_read_input_tokens') ||
    hasOwnNumber(usage, 'cacheReadInputTokens') ||
    hasOwnNumber(usage, 'cache_creation_input_tokens') ||
    hasOwnNumber(usage, 'cacheCreationInputTokens')
  const totalInputTokens =
    inputTokens === null
      ? null
      : inputTokens + (separateCacheCounters ? (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) : 0)
  const hitRatio =
    totalInputTokens && totalInputTokens > 0 && cacheReadTokens !== null
      ? clampRatio(cacheReadTokens / totalInputTokens)
      : null

  return {
    inputTokens,
    totalInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    hitRatio,
    source:
      inputTokens !== null || cacheReadTokens !== null || cacheWriteTokens !== null
        ? 'provider-usage'
        : 'unavailable'
  }
}

function firstFiniteNumber(
  record: Record<string, unknown> | null,
  keys: readonly string[]
): number | null {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value
    }
  }
  return null
}

function hasOwnNumber(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function nestedRecord(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | null {
  const value = record[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
