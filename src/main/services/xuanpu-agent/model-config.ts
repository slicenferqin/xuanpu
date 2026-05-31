import { readFileSync } from 'fs'
import { loadPiAiModule } from './pi-agent-core-loader'
import { expandTilde, type XuanpuAgentConfig } from './config-loader'

export interface XuanpuAgentModelRef {
  providerID: string
  modelID: string
  variant?: string
}

export interface ResolvedPiModel {
  modelRef: XuanpuAgentModelRef
  model: unknown
  streamFn?: unknown
}

export type CredentialSource = 'env' | 'auth-file' | 'missing'

export interface XuanpuAgentProviderCredentialRequirement {
  providerID: string
  envKeys: string[]
  present: boolean
  source: CredentialSource
  maskedKey: string | null
}

const DEFAULT_MODEL_REF: XuanpuAgentModelRef = {
  providerID: 'anthropic',
  modelID: 'claude-haiku-4-5'
}

const PROVIDER_ALIASES: Record<string, string> = {
  'claude-code': 'anthropic',
  codex: 'openai',
  gemini: 'google'
}

const PROVIDER_CREDENTIAL_ENV_KEYS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY']
}
const OPENAI_BASE_URL_ENV_KEYS = ['XUANPU_AGENT_OPENAI_BASE_URL', 'OPENAI_BASE_URL'] as const

export interface XuanpuAgentBaseUrlOverride {
  envKey?: (typeof OPENAI_BASE_URL_ENV_KEYS)[number]
  baseUrl: string
  source: 'env' | 'config'
}

function maskKey(key: string | undefined): string | null {
  if (!key) return null
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

function readAuthFileKey(
  authFile: string,
  authKey: string
): string | null {
  try {
    const expanded = expandTilde(authFile)
    const content = readFileSync(expanded, 'utf-8')
    const parsed = JSON.parse(content) as Record<string, unknown>
    const value = parsed[authKey]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
    return null
  } catch {
    return null
  }
}

export function resolveXuanpuAgentModelRef(
  modelOverride?: XuanpuAgentModelRef,
  selectedModel?: XuanpuAgentModelRef | null,
  config?: XuanpuAgentConfig
): XuanpuAgentModelRef {
  return modelOverride ?? selectedModel ?? config?.mainModel ?? DEFAULT_MODEL_REF
}

interface ResolvedCredential {
  key: string | undefined
  envKeys: string[]
  source: CredentialSource
}

/**
 * Internal credential resolver shared by getXuanpuAgentProviderCredentialRequirement
 * and resolveConfiguredApiKey. Returns the actual key value + metadata.
 *
 * Decision chain:
 * 1. Canonicalize providerID
 * 2. Find provider config
 * 3. Read env (config apiKeyEnv or provider defaults)
 * 4. Read auth file (config authFile + authKey)
 * 5. Return undefined/missing
 */
function resolveCredential(
  providerID: string,
  config?: XuanpuAgentConfig
): ResolvedCredential | null {
  const canonicalProviderID = PROVIDER_ALIASES[providerID] ?? providerID
  const defaultEnvKeys = PROVIDER_CREDENTIAL_ENV_KEYS[canonicalProviderID]
  if (!defaultEnvKeys) return null

  const providerConfig = config?.providers?.[canonicalProviderID]
  const envKeys = providerConfig?.apiKeyEnv
    ? [providerConfig.apiKeyEnv]
    : defaultEnvKeys

  // Step 3: env var
  for (const key of envKeys) {
    const value = process.env[key]?.trim()
    if (value) return { key: value, envKeys, source: 'env' }
  }

  // Step 4: auth file
  if (providerConfig?.authFile && providerConfig?.authKey) {
    const keyValue = readAuthFileKey(providerConfig.authFile, providerConfig.authKey)
    if (keyValue) return { key: keyValue, envKeys, source: 'auth-file' }
  }

  // Step 5: missing
  return { key: undefined, envKeys, source: 'missing' }
}

/**
 * Resolve the actual API key value for a provider from config (env or auth file).
 * Returns the key string, or undefined if not found.
 */
export function resolveConfiguredApiKey(
  providerID: string,
  config?: XuanpuAgentConfig
): string | undefined {
  return resolveCredential(providerID, config)?.key
}

/**
 * Credential decision chain (per plan):
 *
 * 1. Canonicalize providerID
 * 2. Find provider config from config.providers[canonicalProviderID]
 * 3. Read env: use config apiKeyEnv if present, else provider default env keys.
 *    Non-empty value → credential present, source=env.
 * 4. Read auth file: if env has no value and config specifies authFile,
 *    expand ~, read JSON, use authKey. Non-empty → present, source=auth-file.
 * 5. Neither → missing, source=missing.
 */
export function getXuanpuAgentProviderCredentialRequirement(
  providerID: string,
  config?: XuanpuAgentConfig
): XuanpuAgentProviderCredentialRequirement | null {
  const canonicalProviderID = PROVIDER_ALIASES[providerID] ?? providerID
  const resolved = resolveCredential(providerID, config)
  if (!resolved) return null

  return {
    providerID: canonicalProviderID,
    envKeys: resolved.envKeys,
    present: resolved.source !== 'missing',
    source: resolved.source,
    maskedKey: maskKey(resolved.key)
  }
}

export function assertXuanpuAgentProviderCredential(
  modelRef: XuanpuAgentModelRef,
  config?: XuanpuAgentConfig
): void {
  if (process.env.XUANPU_AGENT_MOCK_RESPONSE !== undefined) return

  const requirement = getXuanpuAgentProviderCredentialRequirement(modelRef.providerID, config)
  if (!requirement || requirement.present) return

  throw new Error(
    [
      `Missing credentials for xuanpu-agent provider: ${requirement.providerID}.`,
      `Set one of: ${requirement.envKeys.join(', ')}.`,
      'The experimental xuanpu-agent runtime reads provider credentials from environment variables during this spike.'
    ].join('\n')
  )
}

export async function resolvePiModel(
  modelRef: XuanpuAgentModelRef,
  config?: XuanpuAgentConfig
): Promise<ResolvedPiModel> {
  const mockResponse = process.env.XUANPU_AGENT_MOCK_RESPONSE
  const piAi = await loadPiAiModule()

  if (mockResponse !== undefined) {
    const createMockModel = piAi.createMockModel as
      | ((options: { id: string; provider: string; handler: { content: string[] } }) => {
          model: unknown
          stream: unknown
        })
      | undefined

    if (!createMockModel) {
      throw new Error('@oh-my-pi/pi-ai mock provider is not available')
    }

    const mock = createMockModel({
      id: 'xuanpu-agent-mock',
      provider: 'xuanpu-agent',
      handler: { content: [mockResponse || 'xuanpu-agent mock response'] }
    })

    return {
      modelRef: { providerID: 'xuanpu-agent', modelID: 'xuanpu-agent-mock' },
      model: mock.model,
      streamFn: mock.stream
    }
  }

  const getBundledModel = piAi.getBundledModel as
    | ((provider: string, modelId: string) => unknown)
    | undefined
  const getBundledProviders = piAi.getBundledProviders as (() => string[]) | undefined

  if (!getBundledModel) {
    throw new Error('@oh-my-pi/pi-ai getBundledModel is not available')
  }

  const providerID = PROVIDER_ALIASES[modelRef.providerID] ?? modelRef.providerID
  const model = getBundledModel(providerID, modelRef.modelID)
  if (model) {
    return {
      modelRef: { ...modelRef, providerID },
      model: applyProviderBaseUrlOverride(providerID, model, config)
    }
  }

  const providers = getBundledProviders?.() ?? []
  throw new Error(
    [
      `Unsupported xuanpu-agent model: ${modelRef.providerID}/${modelRef.modelID}.`,
      'The initial oh-my-pi runtime only supports models present in @oh-my-pi/pi-ai.',
      providers.length ? `Known providers: ${providers.sort().join(', ')}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  )
}

/**
 * OpenAI base URL priority:
 * 1. env XUANPU_AGENT_OPENAI_BASE_URL
 * 2. env OPENAI_BASE_URL
 * 3. config.providers.openai.baseUrl
 */
export function getXuanpuAgentOpenAIBaseUrlOverride(
  config?: XuanpuAgentConfig
): XuanpuAgentBaseUrlOverride | null {
  // Priority 1-2: env vars
  for (const envKey of OPENAI_BASE_URL_ENV_KEYS) {
    const raw = process.env[envKey]?.trim()
    if (!raw) continue

    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new Error(`Invalid ${envKey}: expected an absolute http(s) URL.`)
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Invalid ${envKey}: expected an http(s) URL.`)
    }

    return {
      envKey,
      baseUrl: raw.replace(/\/+$/, ''),
      source: 'env'
    }
  }

  // Priority 3: config file
  const configBaseUrl = config?.providers?.openai?.baseUrl
  if (configBaseUrl) {
    return {
      baseUrl: configBaseUrl,
      source: 'config'
    }
  }

  return null
}

export function applyProviderBaseUrlOverride(
  providerID: string,
  model: unknown,
  config?: XuanpuAgentConfig
): unknown {
  if (providerID !== 'openai') return model

  const override = getXuanpuAgentOpenAIBaseUrlOverride(config)
  if (!override) return model
  if (!model || typeof model !== 'object') return model

  return {
    ...(model as Record<string, unknown>),
    baseUrl: override.baseUrl
  }
}
