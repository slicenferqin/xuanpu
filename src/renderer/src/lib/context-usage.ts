import type { AgentSessionContextUsageData } from '@shared/types/agent-protocol'
import type { ContextUsageCategory, TokenInfo } from '@/stores/useContextStore'
import { useContextStore } from '@/stores/useContextStore'

function normalizeTokens(tokens: AgentSessionContextUsageData['tokens']): TokenInfo {
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

function applyContextUsageCost(sessionId: string, data: AgentSessionContextUsageData): void {
  const store = useContextStore.getState()
  if (typeof data.totalCost === 'number' && Number.isFinite(data.totalCost) && data.totalCost > 0) {
    if ((store.costBySession[sessionId] ?? 0) < data.totalCost) {
      store.setSessionCost(sessionId, data.totalCost)
    }
    return
  }

  if (typeof data.cost !== 'number' || !Number.isFinite(data.cost) || data.cost <= 0) return

  const requestId = typeof data.requestId === 'string' ? data.requestId.trim() : ''
  if (requestId) {
    store.addSessionCostOnce(sessionId, `context:${requestId}`, data.cost)
    return
  }

  store.addSessionCost(sessionId, data.cost)
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
  applyContextUsageCost(sessionId, data)

  // Prefer three-layer format (INV-TURN-4) over legacy tokens field.
  const actual = data.providerActual
  const managed = data.managedContext
  const tokens: TokenInfo = actual
    ? {
        input: actual.inputTokens ?? 0,
        output: actual.outputTokens,
        reasoning: 0,
        cacheRead: actual.cacheReadTokens ?? 0,
        cacheWrite: actual.cacheWriteTokens
      }
    : normalizeTokens(data.tokens)
  const model = data.model
    ? {
        providerID: data.model.providerID,
        modelID: data.model.modelID
      }
    : undefined

  if (hasTokenPayload(tokens)) {
    store.setSessionTokens(sessionId, tokens, model)
  }

  // Model limit from managed context or legacy contextWindow.
  const contextWindow = managed?.maxContextTokens ?? data.contextWindow
  if (typeof contextWindow === 'number' && contextWindow > 0 && model) {
    store.setModelLimit(model.modelID, contextWindow, model.providerID)
    store.setModelLimit(model.modelID, contextWindow)
  }

  // Context snapshot from three-layer managed + actual, or legacy breakdown.
  if (managed) {
    const usedTokens = actual?.inputTokens ?? managed.approxTokens
    store.setSessionContextSnapshot(sessionId, {
      usedTokens,
      maxTokens: managed.maxContextTokens,
      percent: managed.maxContextTokens > 0
        ? Math.round((usedTokens / managed.maxContextTokens) * 100) : 0,
      ...(model ? { model } : {})
    })
    return
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

  if (
    model &&
    typeof data.contextWindow === 'number' &&
    data.contextWindow > 0 &&
    hasTokenPayload(tokens)
  ) {
    const usedTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite
    store.setSessionContextSnapshot(sessionId, {
      usedTokens,
      maxTokens: data.contextWindow,
      percent: Math.round((usedTokens / data.contextWindow) * 100),
      model
    })
  }
}
