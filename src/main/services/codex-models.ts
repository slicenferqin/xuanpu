import { asObject, asString } from './codex-utils'

export interface CodexModelInfo {
  id: string
  name: string
  description?: string
  limit: { context: number; output: number }
  variants: Record<string, Record<string, never>>
  defaultVariant: string
  isDefault?: boolean
}

export interface CodexRuntimeModelCatalog {
  models: CodexModelInfo[]
  defaultModelId: string | null
  nextCursor: string | null
}

export const CODEX_REASONING_EFFORTS = ['ultra', 'max', 'xhigh', 'high', 'medium', 'low'] as const
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number]

function createEffortVariants(
  efforts: readonly CodexReasoningEffort[]
): Record<string, Record<string, never>> {
  return Object.fromEntries(efforts.map((effort) => [effort, {}]))
}

const CODEX_FULL_EFFORT_VARIANTS = createEffortVariants(CODEX_REASONING_EFFORTS)
const CODEX_LUNA_EFFORT_VARIANTS = createEffortVariants(['max', 'xhigh', 'high', 'medium', 'low'])
const CODEX_LEGACY_EFFORT_VARIANTS = createEffortVariants(['xhigh', 'high', 'medium', 'low'])

export const CODEX_MODELS: CodexModelInfo[] = [
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6-Sol',
    description: '旗舰级 Agent 编码模型，适合复杂、开放式任务。',
    limit: { context: 272000, output: 128000 },
    variants: CODEX_FULL_EFFORT_VARIANTS,
    defaultVariant: 'low',
    isDefault: true
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6-Terra',
    description: '均衡型 Agent 编码模型，适合日常开发工作。',
    limit: { context: 272000, output: 128000 },
    variants: CODEX_FULL_EFFORT_VARIANTS,
    defaultVariant: 'medium'
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6-Luna',
    description: '快速型 Agent 编码模型，适合明确、可重复的任务。',
    limit: { context: 272000, output: 128000 },
    variants: CODEX_LUNA_EFFORT_VARIANTS,
    defaultVariant: 'medium'
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    limit: { context: 1050000, output: 128000 },
    variants: CODEX_LEGACY_EFFORT_VARIANTS,
    defaultVariant: 'high'
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    limit: { context: 258400, output: 32000 },
    variants: CODEX_LEGACY_EFFORT_VARIANTS,
    defaultVariant: 'high'
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    limit: { context: 258400, output: 32000 },
    variants: CODEX_LEGACY_EFFORT_VARIANTS,
    defaultVariant: 'high'
  },
  {
    id: 'gpt-5.3-codex-spark',
    name: 'GPT-5.3 Codex Spark',
    limit: { context: 258400, output: 16000 },
    variants: CODEX_LEGACY_EFFORT_VARIANTS,
    defaultVariant: 'high'
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT-5.2 Codex',
    limit: { context: 258400, output: 16000 },
    variants: CODEX_LEGACY_EFFORT_VARIANTS,
    defaultVariant: 'high'
  }
]

export const CODEX_DEFAULT_MODEL = 'gpt-5.6-sol'

export function getAvailableCodexModels(models: readonly CodexModelInfo[] = CODEX_MODELS) {
  return [
    {
      id: 'codex',
      name: 'Codex',
      models: Object.fromEntries(
        models.map((model) => [
          model.id,
          {
            id: model.id,
            name: model.name,
            ...(model.description ? { description: model.description } : {}),
            limit: model.limit,
            variants: model.variants,
            defaultVariant: model.defaultVariant
          }
        ])
      )
    }
  ]
}

export function getCodexModelInfo(
  modelId: string,
  models: readonly CodexModelInfo[] = CODEX_MODELS
): CodexModelInfo | null {
  const normalized = normalizeCodexModelSlug(modelId) ?? modelId
  return models.find((model) => model.id === normalized) ?? null
}

export const CODEX_MODEL_ALIASES: Record<string, string> = {
  '5.6': 'gpt-5.6-sol',
  '5.6-sol': 'gpt-5.6-sol',
  '5.6-terra': 'gpt-5.6-terra',
  '5.6-luna': 'gpt-5.6-luna',
  '5.5': 'gpt-5.5',
  '5.4': 'gpt-5.4',
  '5.3': 'gpt-5.3-codex',
  'gpt-5.3': 'gpt-5.3-codex',
  '5.3-spark': 'gpt-5.3-codex-spark',
  'gpt-5.3-spark': 'gpt-5.3-codex-spark',
  '5.2': 'gpt-5.2-codex',
  'gpt-5.2': 'gpt-5.2-codex'
}

export function normalizeCodexModelSlug(model: string | null | undefined): string | null {
  if (typeof model !== 'string') return null
  const trimmed = model.trim()
  if (!trimmed) return null
  return CODEX_MODEL_ALIASES[trimmed] ?? trimmed
}

export function resolveCodexModelSlug(
  model: string | null | undefined,
  models: readonly CodexModelInfo[] = CODEX_MODELS
): string {
  const normalized = normalizeCodexModelSlug(model)
  const fallback = models.find((candidate) => candidate.isDefault)?.id ?? models[0]?.id
  if (!normalized) return fallback ?? CODEX_DEFAULT_MODEL
  const valid = models.find((candidate) => candidate.id === normalized)
  return valid ? normalized : (fallback ?? CODEX_DEFAULT_MODEL)
}

function parseReasoningEffort(value: unknown): CodexReasoningEffort | null {
  const effort = asString(value)
  if (!effort) return null
  return CODEX_REASONING_EFFORTS.find((candidate) => candidate === effort) ?? null
}

function parseRuntimeModel(value: unknown): CodexModelInfo | null {
  const record = asObject(value)
  if (!record || record.hidden === true) return null

  const id = asString(record.model) ?? asString(record.id)
  const name = asString(record.displayName) ?? id
  if (!id || !name) return null

  const supportedReasoningEfforts = Array.isArray(record.supportedReasoningEfforts)
    ? record.supportedReasoningEfforts
        .map((option) => parseReasoningEffort(asObject(option)?.reasoningEffort ?? option))
        .filter((effort): effort is CodexReasoningEffort => effort !== null)
    : []
  const fallback = getCodexModelInfo(id)
  const variants =
    supportedReasoningEfforts.length > 0
      ? createEffortVariants([...supportedReasoningEfforts].reverse())
      : (fallback?.variants ?? CODEX_LEGACY_EFFORT_VARIANTS)
  const defaultVariant =
    parseReasoningEffort(record.defaultReasoningEffort) ??
    fallback?.defaultVariant ??
    supportedReasoningEfforts[0] ??
    'medium'
  const description = asString(record.description)

  return {
    id,
    name,
    ...(description ? { description } : {}),
    limit: fallback?.limit ?? { context: 0, output: 0 },
    variants,
    defaultVariant,
    isDefault: record.isDefault === true
  }
}

export function parseCodexRuntimeModelCatalog(response: unknown): CodexRuntimeModelCatalog | null {
  const responseRecord = asObject(response)
  if (!Array.isArray(responseRecord?.data)) return null

  const models = responseRecord.data
    .map(parseRuntimeModel)
    .filter((model): model is CodexModelInfo => model !== null)
  if (models.length === 0) return null

  return {
    models,
    defaultModelId: models.find((model) => model.isDefault)?.id ?? null,
    nextCursor: asString(responseRecord.nextCursor) ?? null
  }
}
