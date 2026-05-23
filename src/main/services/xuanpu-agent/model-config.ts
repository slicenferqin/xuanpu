import { loadPiAiModule } from './pi-agent-core-loader'

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

export interface XuanpuAgentProviderCredentialRequirement {
  providerID: string
  envKeys: string[]
  present: boolean
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

export function resolveXuanpuAgentModelRef(
  modelOverride?: XuanpuAgentModelRef,
  selectedModel?: XuanpuAgentModelRef | null
): XuanpuAgentModelRef {
  return modelOverride ?? selectedModel ?? DEFAULT_MODEL_REF
}

export function getXuanpuAgentProviderCredentialRequirement(
  providerID: string
): XuanpuAgentProviderCredentialRequirement | null {
  const canonicalProviderID = PROVIDER_ALIASES[providerID] ?? providerID
  const envKeys = PROVIDER_CREDENTIAL_ENV_KEYS[canonicalProviderID]
  if (!envKeys) return null

  return {
    providerID: canonicalProviderID,
    envKeys,
    present: envKeys.some((key) => Boolean(process.env[key]?.trim()))
  }
}

export function assertXuanpuAgentProviderCredential(modelRef: XuanpuAgentModelRef): void {
  if (process.env.XUANPU_AGENT_MOCK_RESPONSE !== undefined) return

  const requirement = getXuanpuAgentProviderCredentialRequirement(modelRef.providerID)
  if (!requirement || requirement.present) return

  throw new Error(
    [
      `Missing credentials for xuanpu-agent provider: ${requirement.providerID}.`,
      `Set one of: ${requirement.envKeys.join(', ')}.`,
      'The experimental xuanpu-agent runtime reads provider credentials from environment variables during this spike.'
    ].join('\n')
  )
}

export async function resolvePiModel(modelRef: XuanpuAgentModelRef): Promise<ResolvedPiModel> {
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
      model
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
