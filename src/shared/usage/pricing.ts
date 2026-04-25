export interface UsageTokenCounts {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

export interface UsagePricing {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

const DEFAULT_PRICING: UsagePricing = {
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0
}

const MODEL_PRICING: Record<string, UsagePricing> = {
  opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4.7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4.6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4.6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-haiku-4.5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'gpt-5.5': { input: 5, output: 30, cacheWrite: 0, cacheRead: 0.5 },
  'gpt-5.4': { input: 2.5, output: 15, cacheWrite: 0, cacheRead: 0.25 },
  'gpt-5.3-codex': { input: 2, output: 16, cacheWrite: 0, cacheRead: 0.2 },
  'gpt-5.3-codex-spark': { input: 1.5, output: 12, cacheWrite: 0, cacheRead: 0.15 },
  'gpt-5.2-codex': { input: 1.75, output: 14, cacheWrite: 0, cacheRead: 0.175 },
  'gpt-5.2': { input: 1.75, output: 14, cacheWrite: 0, cacheRead: 0.175 },
  'gpt-5.1-codex': { input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0.125 },
  'gpt-5.1-codex-mini': { input: 0.25, output: 2, cacheWrite: 0, cacheRead: 0.025 },
  'gpt-5.1-codex-max': { input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0.125 },
  'codex-mini-latest': { input: 1.5, output: 6, cacheWrite: 0, cacheRead: 0.375 },
  'gpt-5-codex': { input: 1.25, output: 10, cacheWrite: 0, cacheRead: 0.125 }
}

function stripProviderPrefix(value: string): string {
  let normalized = value

  if (normalized.includes('/')) {
    const segments = normalized.split('/')
    normalized = segments[segments.length - 1]
  }

  normalized = normalized.replace(/^anthropic\./, '')
  normalized = normalized.replace(/^openai\./, '')
  normalized = normalized.replace(/^codex\./, '')

  return normalized
}

export function normalizePricingModelKey(model: string): string {
  let normalized = stripProviderPrefix(model.trim().toLowerCase())
  normalized = normalized.replace(/_/g, '-')
  normalized = normalized.replace(/@.*$/, '')
  normalized = normalized.replace(/-v\d+:\d+$/, '')
  normalized = normalized.replace(/-\d{8,}$/, '')

  return normalized
}

export function resolvePricingModelKey(model: string, providerID?: string | null): string {
  const normalized = normalizePricingModelKey(model)

  if (MODEL_PRICING[normalized]) return normalized

  if (normalized.includes('opus')) return 'opus'
  if (normalized.includes('sonnet')) return 'sonnet'
  if (normalized.includes('haiku')) return 'haiku'

  if (providerID === 'claude-code' || providerID === 'anthropic') {
    if (normalized === 'opus' || normalized === 'sonnet' || normalized === 'haiku') {
      return normalized
    }
  }

  const knownCodexModels = [
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.3-codex',
    'gpt-5.3-codex-spark',
    'gpt-5.2-codex',
    'gpt-5.2',
    'gpt-5.1-codex',
    'gpt-5.1-codex-mini',
    'gpt-5.1-codex-max',
    'codex-mini-latest',
    'gpt-5-codex'
  ]

  const codexMatch = knownCodexModels.find((candidate) => normalized.includes(candidate))
  if (codexMatch) return codexMatch

  return normalized
}

export function getUsagePricing(model: string, providerID?: string | null): UsagePricing {
  const key = resolvePricingModelKey(model, providerID)
  return MODEL_PRICING[key] ?? DEFAULT_PRICING
}

export function calculateUsageCost(
  model: string,
  tokens: UsageTokenCounts,
  providerID?: string | null
): number {
  const pricing = getUsagePricing(model, providerID)
  return (
    (tokens.input * pricing.input +
      tokens.output * pricing.output +
      tokens.cacheWrite * pricing.cacheWrite +
      tokens.cacheRead * pricing.cacheRead) /
    1_000_000
  )
}
