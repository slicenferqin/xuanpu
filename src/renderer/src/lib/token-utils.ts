import type { SessionModelRef, TokenInfo } from '@/stores/useContextStore'
import {
  extractUsageCost,
  extractUsageModelRef,
  extractUsageTokens
} from '@shared/usage/message'
import { resolveRuntimeModelId } from '@shared/usage/models'

export interface SelectedModelRef {
  providerID: string
  modelID: string
  variant?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function firstFiniteNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return 0
}

export function extractTokens(messageData: Record<string, unknown>): TokenInfo | null {
  const tokens = extractUsageTokens(messageData)
  if (!tokens) return null

  const info = asRecord(messageData.info)
  const rawTokens =
    asRecord(messageData.tokens) ??
    asRecord(info?.tokens) ??
    asRecord(messageData.usage) ??
    asRecord(info?.usage)
  const reasoning = rawTokens
    ? firstFiniteNumber(rawTokens.reasoning, rawTokens.reasoning_tokens, rawTokens.reasoningTokens)
    : 0

  return {
    input: tokens.input,
    output: tokens.output,
    reasoning,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite
  }
}

export function extractCost(messageData: Record<string, unknown>): number {
  return extractUsageCost(messageData)
}

export function extractModelRef(
  messageData: Record<string, unknown>,
  fallbackProviderID?: string
): SessionModelRef | null {
  const modelRef = extractUsageModelRef(messageData)
  if (!modelRef) return null

  const providerID = modelRef.providerID ?? fallbackProviderID
  const modelID = resolveRuntimeModelId(modelRef.modelID, providerID)

  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

export interface ModelUsageEntry {
  modelName: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUSD: number
  contextWindow: number
}

/**
 * Extract per-model usage from result message's modelUsage field.
 * The SDK result message includes a `modelUsage` map keyed by model name,
 * each with token counts and `contextWindow` (the model's context limit).
 * Returns null if no modelUsage is present.
 */
export function extractModelUsage(messageData: Record<string, unknown>): ModelUsageEntry[] | null {
  const info = asRecord(messageData.info)
  const modelUsage = asRecord(messageData.modelUsage ?? info?.modelUsage)
  if (!modelUsage) return null

  const entries: ModelUsageEntry[] = []
  for (const [modelName, value] of Object.entries(modelUsage)) {
    const usage = asRecord(value)
    if (!usage) continue
    entries.push({
      modelName,
      inputTokens: toNumber(usage.inputTokens),
      outputTokens: toNumber(usage.outputTokens),
      cacheReadInputTokens: toNumber(usage.cacheReadInputTokens),
      cacheCreationInputTokens: toNumber(usage.cacheCreationInputTokens),
      costUSD: toNumber(usage.costUSD),
      contextWindow: toNumber(usage.contextWindow)
    })
  }
  return entries.length > 0 ? entries : null
}

/**
 * Extract full model selection (provider/model + optional variant) from a
 * parsed OpenCode message JSON object.
 */
export function extractSelectedModel(
  messageData: Record<string, unknown>
): SelectedModelRef | null {
  const info = asRecord(messageData.info)
  const modelRecord = asRecord(messageData.model) ?? asRecord(info?.model)

  const providerFromModel = modelRecord?.providerID
  const modelIdFromModel = modelRecord?.modelID ?? modelRecord?.id

  let providerID =
    typeof providerFromModel === 'string'
      ? providerFromModel
      : typeof messageData.providerID === 'string'
        ? messageData.providerID
        : typeof info?.providerID === 'string'
          ? info.providerID
          : undefined

  let modelID =
    typeof modelIdFromModel === 'string'
      ? modelIdFromModel
      : typeof messageData.modelID === 'string'
        ? messageData.modelID
        : typeof info?.modelID === 'string'
          ? info.modelID
          : undefined

  const modelString =
    typeof messageData.model === 'string'
      ? messageData.model
      : typeof info?.model === 'string'
        ? info.model
        : undefined

  if ((!providerID || !modelID) && modelString) {
    const [providerPart, modelPart] = modelString.split('/')
    if (providerPart && modelPart) {
      providerID = providerID ?? providerPart
      modelID = modelID ?? modelPart
    }
  }

  if (!providerID || !modelID) {
    return null
  }

  const runtimeModelID = resolveRuntimeModelId(modelID, providerID)
  if (!runtimeModelID) {
    return null
  }

  const variantCandidate =
    typeof modelRecord?.variant === 'string'
      ? modelRecord.variant
      : typeof messageData.variant === 'string'
        ? messageData.variant
        : typeof info?.variant === 'string'
          ? info.variant
          : undefined

  return {
    providerID,
    modelID: runtimeModelID,
    ...(variantCandidate ? { variant: variantCandidate } : {})
  }
}
