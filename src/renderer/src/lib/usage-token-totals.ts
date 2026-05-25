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

/**
 * Resolve the token totals a UI surface should display.
 *
 * Optionality ladder (do NOT add a "smart" override branch back here):
 *   1. `summary` exists AND has token detail (>0) → use summary. This is the
 *      durable, cross-process truth coming from `usage_entries`.
 *   2. `summary` missing OR summary has zero tokens → use the runtime
 *      `fallbackTokens` snapshot (per-session live cumulative).
 *   3. Neither has tokens → zeroed `'none'`.
 *
 * 历史回归：之前这里有 "liveTotalTokens > 0 && summary.total_cost > 0 → 用 live"
 * 的分支，对 codex 还额外放宽到 fallbackCost > 0。这会在 codex 会话每次新一轮
 * 对话时把 thread 累计值当作纯增量加到本就已经入库的 summary 上，造成开发版
 * 和打包版统计相差一个数量级。修法就是不要再做这种"两边都有就拿大头"的合并，
 * summary 一旦有 token 明细就以它为准。
 */
export function resolveUsageTokenTotals(
  summary: UsageAnalyticsSessionSummary | null | undefined,
  fallbackTokens: UsageTokenSnapshot | null | undefined
): ResolvedUsageTokenTotals {
  const summaryTokens = summary
    ? Math.max(normalizedToken(summary.total_tokens), summaryDetailTotal(summary))
    : 0

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

  const liveTotalTokens = fallbackTotal(fallbackTokens)
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
