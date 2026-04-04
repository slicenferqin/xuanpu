import type { UsageTokenCounts } from './pricing'

export interface UsageModelRef {
  providerID?: string
  modelID: string
  displayName: string
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

export function extractUsageTokens(messageData: Record<string, unknown>): UsageTokenCounts | null {
  const info = asRecord(messageData.info)
  const contextWindow = asRecord(messageData.context_window ?? info?.context_window)
  const currentUsage = asRecord(contextWindow?.current_usage)
  const usage = asRecord(
    messageData.tokens ?? messageData.usage ?? info?.tokens ?? info?.usage ?? currentUsage
  )

  if (!usage) return null

  const cache = asRecord(usage.cache)
  const tokens: UsageTokenCounts = {
    input: firstFiniteNumber(usage.input, usage.input_tokens, usage.inputTokens),
    output: firstFiniteNumber(usage.output, usage.output_tokens, usage.outputTokens),
    cacheWrite: firstFiniteNumber(
      usage.cacheWrite,
      usage.cache_write,
      usage.cacheWriteInputTokens,
      usage.cache_write_input_tokens,
      usage.cacheCreation,
      usage.cache_creation,
      usage.cacheCreationInputTokens,
      usage.cache_creation_input_tokens,
      cache?.write
    ),
    cacheRead: firstFiniteNumber(
      usage.cacheRead,
      usage.cache_read,
      usage.cacheReadInputTokens,
      usage.cache_read_input_tokens,
      cache?.read
    )
  }

  return tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead > 0 ? tokens : null
}

export function extractUsageCost(messageData: Record<string, unknown>): number {
  const info = asRecord(messageData.info)
  return toNumber(
    messageData.cost ??
      messageData.total_cost_usd ??
      messageData.costUSD ??
      info?.cost ??
      info?.total_cost_usd ??
      info?.costUSD
  )
}

export function extractUsageMessageID(messageData: Record<string, unknown>): string | null {
  const message = asRecord(messageData.message)
  const id = message?.id ?? messageData.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

export function extractUsageModelRef(messageData: Record<string, unknown>): UsageModelRef | null {
  const info = asRecord(messageData.info)
  const message = asRecord(messageData.message)
  const modelRecord =
    asRecord(messageData.model) ?? asRecord(info?.model) ?? asRecord(message?.model)

  const providerFromModel = modelRecord?.providerID
  const modelFromModel = modelRecord?.modelID ?? modelRecord?.id

  let providerID =
    typeof providerFromModel === 'string'
      ? providerFromModel
      : typeof messageData.providerID === 'string'
        ? messageData.providerID
        : typeof info?.providerID === 'string'
          ? info.providerID
          : undefined

  let modelID =
    typeof modelFromModel === 'string'
      ? modelFromModel
      : typeof messageData.modelID === 'string'
        ? messageData.modelID
        : typeof info?.modelID === 'string'
          ? info.modelID
          : undefined

  const modelString =
    typeof messageData.model === 'string'
      ? messageData.model
      : typeof message?.model === 'string'
        ? message.model
        : typeof info?.model === 'string'
          ? info.model
          : undefined

  if ((!providerID || !modelID) && modelString) {
    const [providerPart, modelPart] = modelString.split('/')
    if (providerPart && modelPart) {
      providerID = providerID ?? providerPart
      modelID = modelID ?? modelPart
    } else {
      modelID = modelID ?? modelString
    }
  }

  if (!modelID) return null

  const variant =
    typeof modelRecord?.variant === 'string'
      ? modelRecord.variant
      : typeof messageData.variant === 'string'
        ? messageData.variant
        : typeof info?.variant === 'string'
          ? info.variant
          : undefined

  return {
    providerID,
    modelID,
    displayName: modelString ?? modelID,
    ...(variant ? { variant } : {})
  }
}
