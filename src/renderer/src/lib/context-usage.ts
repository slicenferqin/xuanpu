import type { AgentSessionContextUsageData } from '@shared/types/agent-protocol'
import type { ContextUsageCategory, SessionModelRef, TokenInfo } from '@/stores/useContextStore'
import { useContextStore } from '@/stores/useContextStore'

function normalizeTokens(
  tokens: AgentSessionContextUsageData['tokens'] | undefined
): TokenInfo {
  return {
    input: tokens?.input ?? 0,
    output: tokens?.output ?? 0,
    reasoning: tokens?.reasoning ?? 0,
    cacheRead: tokens?.cacheRead ?? 0,
    cacheWrite: tokens?.cacheWrite ?? 0
  }
}

function hasTokenPayload(tokens: TokenInfo): boolean {
  return (
    tokens.input > 0 ||
    tokens.output > 0 ||
    tokens.reasoning > 0 ||
    tokens.cacheRead > 0 ||
    tokens.cacheWrite > 0
  )
}

function normalizeCategories(
  categories: AgentSessionContextUsageData['breakdown'] extends { categories?: infer T } ? T : never
): ContextUsageCategory[] | undefined {
  if (!Array.isArray(categories) || categories.length === 0) return undefined

  return categories
    .filter(
      (category): category is NonNullable<typeof categories>[number] =>
        !!category && typeof category.name === 'string' && typeof category.tokens === 'number'
    )
    .map((category) => ({
      name: category.name,
      tokens: category.tokens,
      ...(typeof category.color === 'string' ? { color: category.color } : {}),
      ...(category.isDeferred === true ? { isDeferred: true } : {})
    }))
}

export function applySessionContextUsage(
  sessionId: string,
  data: AgentSessionContextUsageData
): void {
  const store = useContextStore.getState()
  const tokens = normalizeTokens(data.tokens)
  const model = data.model
    ? {
        providerID: data.model.providerID,
        modelID: data.model.modelID
      }
    : undefined

  if (hasTokenPayload(tokens)) {
    store.setSessionTokens(sessionId, tokens, model)
  }

  if (typeof data.contextWindow === 'number' && data.contextWindow > 0 && model) {
    store.setModelLimit(model.modelID, data.contextWindow, model.providerID)
    store.setModelLimit(model.modelID, data.contextWindow)
  }

  if (data.breakdown) {
    store.setSessionContextSnapshot(sessionId, {
      usedTokens: data.breakdown.usedTokens,
      maxTokens: data.breakdown.maxTokens,
      ...(typeof data.breakdown.rawMaxTokens === 'number'
        ? { rawMaxTokens: data.breakdown.rawMaxTokens }
        : {}),
      percent: Math.round(data.breakdown.percentage),
      ...(normalizeCategories(data.breakdown.categories)
        ? { categories: normalizeCategories(data.breakdown.categories) }
        : {}),
      ...(model ? { model } : {})
    })
    return
  }

  if (model && typeof data.contextWindow === 'number' && data.contextWindow > 0 && hasTokenPayload(tokens)) {
    const usedTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite
    store.setSessionContextSnapshot(sessionId, {
      usedTokens,
      maxTokens: data.contextWindow,
      percent: Math.round((usedTokens / data.contextWindow) * 100),
      model
    })
  }
}
