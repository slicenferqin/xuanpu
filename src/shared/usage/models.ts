import { normalizePricingModelKey } from './pricing'

const KNOWN_CODEX_MODELS = [
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
] as const

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  opus: 'Opus 4.7',
  sonnet: 'Sonnet 4.6',
  haiku: 'Haiku 4.5',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4.7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4.6': 'Opus 4.6',
  'claude-opus-4-5': 'Opus 4.5',
  'claude-opus-4.5': 'Opus 4.5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4.6': 'Sonnet 4.6',
  'claude-sonnet-4-5': 'Sonnet 4.5',
  'claude-sonnet-4.5': 'Sonnet 4.5',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-haiku-4.5': 'Haiku 4.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
  'gpt-5.2-codex': 'GPT-5.2 Codex',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.1-codex': 'GPT-5.1 Codex',
  'gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini',
  'gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
  'codex-mini-latest': 'Codex Mini',
  'gpt-5-codex': 'GPT-5 Codex'
}

function pushUnique(target: string[], value: string | null | undefined): void {
  if (!value) return
  if (!target.includes(value)) target.push(value)
}

export function getModelAliases(model: string | null | undefined): string[] {
  const trimmed = model?.trim()
  if (!trimmed) return []

  const aliases: string[] = []
  pushUnique(aliases, trimmed)

  const normalized = normalizePricingModelKey(trimmed)
  pushUnique(aliases, normalized)

  if (normalized.includes('opus')) pushUnique(aliases, 'opus')
  if (normalized.includes('sonnet')) pushUnique(aliases, 'sonnet')
  if (normalized.includes('haiku')) pushUnique(aliases, 'haiku')

  for (const candidate of KNOWN_CODEX_MODELS) {
    if (normalized.includes(candidate)) {
      pushUnique(aliases, candidate)
      break
    }
  }

  return aliases
}

export function resolveRuntimeModelId(
  model: string | null | undefined,
  providerID?: string | null
): string | null {
  const trimmed = model?.trim()
  if (!trimmed) return null

  const normalized = normalizePricingModelKey(trimmed)
  const claudeProvider = providerID === 'anthropic' || providerID === 'claude-code'

  if (normalized.includes('opus') && (claudeProvider || normalized.includes('claude-opus'))) {
    return 'opus'
  }
  if (normalized.includes('sonnet') && (claudeProvider || normalized.includes('claude-sonnet'))) {
    return 'sonnet'
  }
  if (normalized.includes('haiku') && (claudeProvider || normalized.includes('claude-haiku'))) {
    return 'haiku'
  }

  const codexMatch = KNOWN_CODEX_MODELS.find((candidate) => normalized.includes(candidate))
  if (codexMatch) return codexMatch

  return normalized || trimmed
}

export function getCanonicalModelLabel(
  model: string | null | undefined,
  providerID?: string | null
): string | null {
  const trimmed = model?.trim()
  if (!trimmed) return null

  const aliases = getModelAliases(trimmed)
  for (const alias of aliases) {
    const label = MODEL_DISPLAY_NAMES[alias]
    if (label) return label
  }

  const runtimeModelId = resolveRuntimeModelId(trimmed, providerID)
  if (runtimeModelId && MODEL_DISPLAY_NAMES[runtimeModelId]) {
    return MODEL_DISPLAY_NAMES[runtimeModelId]
  }

  return trimmed
}
