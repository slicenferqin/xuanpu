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
    normalizedToken(tokens.cacheWrite)
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

/**
 * Resolve the token totals a UI surface should display.
 *
 * Optionality ladder:
 *   1. Compare durable `summary` detail with live `fallbackTokens` and use the
 *      larger complete snapshot. This keeps active-session counters monotonic
 *      while `usage_entries` catches up, without adding both sources together.
 *   2. `summary` missing OR summary has zero tokens → use the runtime
 *      `fallbackTokens` snapshot.
 *   3. Neither has tokens → zeroed `'none'`.
 *
 * 历史回归：不要把 summary 和 live fallback 相加。Codex 的 live snapshot
 * 是 thread 累计，summary 是 usage_entries 累计；相加会重复计数。这里做的是
 * 二选一，解决 persisted summary 异步返回 0/旧值时右侧总量回落的问题。
 */
export function resolveUsageTokenTotals(
  summary: UsageAnalyticsSessionSummary | null | undefined,
  fallbackTokens: UsageTokenSnapshot | null | undefined
): ResolvedUsageTokenTotals {
  const summaryTokens = summary ? summaryDetailTotal(summary) : 0
  const liveTotalTokens = fallbackTotal(fallbackTokens)

  if (summary && summaryTokens > 0 && summaryTokens >= liveTotalTokens) {
    return {
      totalTokens: summaryTokens,
      inputTokens: normalizedToken(summary.input_tokens),
      outputTokens: normalizedToken(summary.output_tokens),
      cacheReadTokens: normalizedToken(summary.cache_read_tokens),
      cacheWriteTokens: normalizedToken(summary.cache_write_tokens),
      source: 'summary'
    }
  }

  if (liveTotalTokens > 0) {
    return {
      totalTokens: liveTotalTokens,
      inputTokens: normalizedToken(fallbackTokens?.input),
      outputTokens: normalizedToken(fallbackTokens?.output),
      cacheReadTokens: normalizedToken(fallbackTokens?.cacheRead),
      cacheWriteTokens: normalizedToken(fallbackTokens?.cacheWrite),
      source: 'fallback'
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
