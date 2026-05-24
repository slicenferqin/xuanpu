import type { UsageAnalyticsSessionSummary } from '@shared/types/usage-analytics'

export interface UsageTokenSnapshot {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
}

export interface ResolvedUsageTokenTotals {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  source: 'summary' | 'fallback' | 'none'
}

function normalizedToken(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined ? Math.max(0, value) : 0
}

function fallbackTotal(tokens: UsageTokenSnapshot | null | undefined): number {
  if (!tokens) return 0
  return (
    normalizedToken(tokens.input) +
    normalizedToken(tokens.output) +
    normalizedToken(tokens.cacheRead) +
    normalizedToken(tokens.cacheWrite) +
    normalizedToken(tokens.reasoning)
  )
}

function summaryDetailTotal(summary: UsageAnalyticsSessionSummary): number {
  return (
    normalizedToken(summary.input_tokens) +
    normalizedToken(summary.output_tokens) +
    normalizedToken(summary.cache_read_tokens) +
    normalizedToken(summary.cache_write_tokens)
  )
}

export function resolveUsageTokenTotals(
  summary: UsageAnalyticsSessionSummary | null | undefined,
  fallbackTokens: UsageTokenSnapshot | null | undefined,
  fallbackCost = 0
): ResolvedUsageTokenTotals {
  const summaryTokens = summary
    ? Math.max(normalizedToken(summary.total_tokens), summaryDetailTotal(summary))
    : 0
  const liveTotalTokens = fallbackTotal(fallbackTokens)

  if (summary && summaryTokens > 0) {
    return {
      totalTokens: summaryTokens,
      inputTokens: normalizedToken(summary.input_tokens),
      outputTokens: normalizedToken(summary.output_tokens),
      cacheReadTokens: normalizedToken(summary.cache_read_tokens),
      cacheWriteTokens: normalizedToken(summary.cache_write_tokens),
      source: 'summary'
    }
  }

  if (
    !summary ||
    (liveTotalTokens > 0 &&
      (summary.total_cost > 0 ||
        (summary.engine === 'codex' && Number.isFinite(fallbackCost) && fallbackCost > 0)))
  ) {
    return {
      totalTokens: liveTotalTokens,
      inputTokens: normalizedToken(fallbackTokens?.input),
      outputTokens: normalizedToken(fallbackTokens?.output),
      cacheReadTokens: normalizedToken(fallbackTokens?.cacheRead),
      cacheWriteTokens: normalizedToken(fallbackTokens?.cacheWrite),
      source: liveTotalTokens > 0 ? 'fallback' : 'none'
    }
  }

  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    source: 'none'
  }
}
