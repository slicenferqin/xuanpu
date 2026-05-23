import { afterEach, describe, expect, it, vi } from 'vitest'

const piAiMock = vi.hoisted(() => {
  const bundledModels: Record<string, Record<string, string>> = {
    'anthropic/claude-haiku-4-5': {
      id: 'claude-haiku-4-5',
      provider: 'anthropic'
    },
    'openai/gpt-4.1': {
      id: 'gpt-4.1',
      provider: 'openai'
    },
    'google/gemini-2.5-pro': {
      id: 'gemini-2.5-pro',
      provider: 'google'
    }
  }

  const getBundledModel = vi.fn((provider: string, modelId: string) => {
    return bundledModels[`${provider}/${modelId}`] ?? null
  })

  const getBundledProviders = vi.fn(() => ['openai', 'google', 'anthropic'])

  return {
    getBundledModel,
    getBundledProviders,
    reset: () => {
      getBundledModel.mockClear()
      getBundledProviders.mockClear()
    }
  }
})

vi.mock('../../src/main/services/xuanpu-agent/pi-agent-core-loader', () => ({
  loadPiAiModule: vi.fn(async () => ({
    getBundledModel: piAiMock.getBundledModel,
    getBundledProviders: piAiMock.getBundledProviders
  }))
}))

import {
  assertXuanpuAgentProviderCredential,
  getXuanpuAgentProviderCredentialRequirement,
  resolvePiModel,
  resolveXuanpuAgentModelRef
} from '../../src/main/services/xuanpu-agent/model-config'

describe('xuanpu-agent model config', () => {
  const previousMockResponse = process.env.XUANPU_AGENT_MOCK_RESPONSE
  const credentialEnvKeys = [
    'ANTHROPIC_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_FOUNDRY_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY'
  ]
  const previousCredentialEnv = Object.fromEntries(
    credentialEnvKeys.map((key) => [key, process.env[key]])
  )

  afterEach(() => {
    piAiMock.reset()
    if (previousMockResponse === undefined) {
      delete process.env.XUANPU_AGENT_MOCK_RESPONSE
    } else {
      process.env.XUANPU_AGENT_MOCK_RESPONSE = previousMockResponse
    }
    for (const key of credentialEnvKeys) {
      const value = previousCredentialEnv[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('defaults to the bundled Anthropic Haiku model used for dogfood', async () => {
    const modelRef = resolveXuanpuAgentModelRef()

    expect(modelRef).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5'
    })

    const resolved = await resolvePiModel(modelRef)

    expect(resolved.modelRef).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5'
    })
    expect(resolved.model).toEqual({
      id: 'claude-haiku-4-5',
      provider: 'anthropic'
    })
    expect(piAiMock.getBundledModel).toHaveBeenCalledWith('anthropic', 'claude-haiku-4-5')
  })

  it('prefers explicit overrides before selected model and default model', () => {
    const selected = { providerID: 'anthropic', modelID: 'claude-haiku-4-5' }
    const override = { providerID: 'openai', modelID: 'gpt-4.1' }

    expect(resolveXuanpuAgentModelRef(undefined, selected)).toBe(selected)
    expect(resolveXuanpuAgentModelRef(override, selected)).toBe(override)
  })

  it('maps existing runtime provider ids to pi-ai provider ids', async () => {
    await expect(
      resolvePiModel({ providerID: 'claude-code', modelID: 'claude-haiku-4-5' })
    ).resolves.toMatchObject({
      modelRef: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' }
    })

    await expect(
      resolvePiModel({ providerID: 'codex', modelID: 'gpt-4.1' })
    ).resolves.toMatchObject({
      modelRef: { providerID: 'openai', modelID: 'gpt-4.1' }
    })

    await expect(
      resolvePiModel({ providerID: 'gemini', modelID: 'gemini-2.5-pro' })
    ).resolves.toMatchObject({
      modelRef: { providerID: 'google', modelID: 'gemini-2.5-pro' }
    })

    expect(piAiMock.getBundledModel).toHaveBeenNthCalledWith(1, 'anthropic', 'claude-haiku-4-5')
    expect(piAiMock.getBundledModel).toHaveBeenNthCalledWith(2, 'openai', 'gpt-4.1')
    expect(piAiMock.getBundledModel).toHaveBeenNthCalledWith(3, 'google', 'gemini-2.5-pro')
  })

  it('reports unsupported models with known pi-ai providers', async () => {
    await expect(resolvePiModel({ providerID: 'unknown', modelID: 'missing' })).rejects.toThrow(
      [
        'Unsupported xuanpu-agent model: unknown/missing.',
        'The initial oh-my-pi runtime only supports models present in @oh-my-pi/pi-ai.',
        'Known providers: anthropic, google, openai'
      ].join('\n')
    )
  })

  it('reports credential requirements using canonical pi-ai provider ids', () => {
    for (const key of credentialEnvKeys) delete process.env[key]

    expect(getXuanpuAgentProviderCredentialRequirement('claude-code')).toEqual({
      providerID: 'anthropic',
      envKeys: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY'],
      present: false
    })

    process.env.ANTHROPIC_API_KEY = 'test-key'
    expect(getXuanpuAgentProviderCredentialRequirement('anthropic')).toEqual({
      providerID: 'anthropic',
      envKeys: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY'],
      present: true
    })

    expect(getXuanpuAgentProviderCredentialRequirement('xuanpu-agent')).toBeNull()
  })

  it('fails fast for real provider execution without credentials', () => {
    for (const key of credentialEnvKeys) delete process.env[key]

    expect(() =>
      assertXuanpuAgentProviderCredential({
        providerID: 'anthropic',
        modelID: 'claude-haiku-4-5'
      })
    ).toThrow(
      [
        'Missing credentials for xuanpu-agent provider: anthropic.',
        'Set one of: ANTHROPIC_OAUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_FOUNDRY_API_KEY.',
        'The experimental xuanpu-agent runtime reads provider credentials from environment variables during this spike.'
      ].join('\n')
    )
  })

  it('skips credential preflight for deterministic mock provider execution', () => {
    for (const key of credentialEnvKeys) delete process.env[key]
    process.env.XUANPU_AGENT_MOCK_RESPONSE = 'mock'

    expect(() =>
      assertXuanpuAgentProviderCredential({
        providerID: 'anthropic',
        modelID: 'claude-haiku-4-5'
      })
    ).not.toThrow()
  })
})
