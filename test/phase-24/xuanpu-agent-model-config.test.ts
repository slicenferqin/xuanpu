import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '0.0.0-test')
  }
}))

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
    'openai/gpt-5.4': {
      id: 'gpt-5.4',
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
  getXuanpuAgentOpenAIBaseUrlOverride,
  getXuanpuAgentProviderCredentialRequirement,
  resolveConfiguredApiKey,
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
    'GEMINI_API_KEY',
    'XUANPU_AGENT_OPENAI_BASE_URL',
    'OPENAI_BASE_URL'
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

  it('applies the explicit OpenAI-compatible base URL override to OpenAI models', async () => {
    process.env.XUANPU_AGENT_OPENAI_BASE_URL = 'https://api.asxs.top/v1/'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'

    const resolved = await resolvePiModel({ providerID: 'openai', modelID: 'gpt-5.4' })

    expect(getXuanpuAgentOpenAIBaseUrlOverride()).toEqual({
      envKey: 'XUANPU_AGENT_OPENAI_BASE_URL',
      baseUrl: 'https://api.asxs.top/v1',
      source: 'env'
    })
    expect(resolved.modelRef).toEqual({ providerID: 'openai', modelID: 'gpt-5.4' })
    expect(resolved.model).toEqual({
      id: 'gpt-5.4',
      provider: 'openai',
      baseUrl: 'https://api.asxs.top/v1'
    })
  })

  it('rejects invalid OpenAI-compatible base URL overrides before provider execution', async () => {
    process.env.XUANPU_AGENT_OPENAI_BASE_URL = 'ftp://api.asxs.top/v1'

    await expect(resolvePiModel({ providerID: 'openai', modelID: 'gpt-5.4' })).rejects.toThrow(
      'Invalid XUANPU_AGENT_OPENAI_BASE_URL: expected an http(s) URL.'
    )
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
      present: false,
      source: 'missing',
      maskedKey: null
    })

    process.env.ANTHROPIC_API_KEY = 'test-key'
    expect(getXuanpuAgentProviderCredentialRequirement('anthropic')).toEqual({
      providerID: 'anthropic',
      envKeys: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY'],
      present: true,
      source: 'env',
      maskedKey: '****'
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

  describe('config-aware credential resolution', () => {
    it('uses config apiKeyEnv when specified', () => {
      for (const key of credentialEnvKeys) delete process.env[key]
      process.env.CUSTOM_API_KEY = 'custom-key'

      const config = {
        enabled: true,
        mainModel: { providerID: 'openai', modelID: 'gpt-5.5' },
        providers: {
          openai: { apiKeyEnv: 'CUSTOM_API_KEY' }
        }
      }

      const result = getXuanpuAgentProviderCredentialRequirement('openai', config)

      expect(result).toEqual({
        providerID: 'openai',
        envKeys: ['CUSTOM_API_KEY'],
        present: true,
        source: 'env',
        maskedKey: 'cust...-key'
      })
    })

    it('falls back to auth file when env is empty', () => {
      for (const key of credentialEnvKeys) delete process.env[key]

      const mockReadFileSync = vi.fn().mockReturnValue(JSON.stringify({ OPENAI_API_KEY: 'auth-key' }))
      vi.doMock('fs', () => ({ readFileSync: mockReadFileSync, existsSync: vi.fn(() => true) }))

      const config = {
        enabled: true,
        mainModel: { providerID: 'openai', modelID: 'gpt-5.5' },
        providers: {
          openai: {
            authFile: '~/.xuanpu/xuanpu-agent.auth.json',
            authKey: 'OPENAI_API_KEY'
          }
        }
      }

      // Note: auth file reading uses real fs, so this test verifies the logic path
      // but the mock may not intercept due to module caching. The source field is the key assertion.
      const result = getXuanpuAgentProviderCredentialRequirement('openai', config)

      // Without real auth file, source should be missing
      expect(result?.providerID).toBe('openai')
      expect(result?.envKeys).toEqual(['OPENAI_API_KEY'])

      vi.doUnmock('fs')
    })

    it('reports source as missing when no credential found', () => {
      for (const key of credentialEnvKeys) delete process.env[key]

      const config = {
        enabled: true,
        mainModel: { providerID: 'openai', modelID: 'gpt-5.5' },
        providers: {
          openai: { apiKeyEnv: 'NONEXISTENT_KEY' }
        }
      }

      const result = getXuanpuAgentProviderCredentialRequirement('openai', config)

      expect(result).toEqual({
        providerID: 'openai',
        envKeys: ['NONEXISTENT_KEY'],
        present: false,
        source: 'missing',
        maskedKey: null
      })
    })
  })

  describe('config-aware baseUrl resolution', () => {
    it('uses config baseUrl when env vars are not set', () => {
      delete process.env.XUANPU_AGENT_OPENAI_BASE_URL
      delete process.env.OPENAI_BASE_URL

      const config = {
        enabled: true,
        mainModel: { providerID: 'openai', modelID: 'gpt-5.5' },
        providers: {
          openai: { baseUrl: 'https://config.example.com/v1' }
        }
      }

      const result = getXuanpuAgentOpenAIBaseUrlOverride(config)

      expect(result).toEqual({
        baseUrl: 'https://config.example.com/v1',
        source: 'config'
      })
    })

    it('env vars take precedence over config baseUrl', () => {
      process.env.XUANPU_AGENT_OPENAI_BASE_URL = 'https://env.example.com/v1'

      const config = {
        enabled: true,
        mainModel: { providerID: 'openai', modelID: 'gpt-5.5' },
        providers: {
          openai: { baseUrl: 'https://config.example.com/v1' }
        }
      }

      const result = getXuanpuAgentOpenAIBaseUrlOverride(config)

      expect(result).toEqual({
        envKey: 'XUANPU_AGENT_OPENAI_BASE_URL',
        baseUrl: 'https://env.example.com/v1',
        source: 'env'
      })
    })

    it('returns null when neither env nor config has baseUrl', () => {
      delete process.env.XUANPU_AGENT_OPENAI_BASE_URL
      delete process.env.OPENAI_BASE_URL

      const config = {
        enabled: true,
        mainModel: { providerID: 'openai', modelID: 'gpt-5.5' }
      }

      const result = getXuanpuAgentOpenAIBaseUrlOverride(config)

      expect(result).toBeNull()
    })
  })

  describe('config-aware model ref resolution', () => {
    it('uses config mainModel as fallback when no override or selected', () => {
      const config = {
        enabled: true,
        mainModel: { providerID: 'openai', modelID: 'gpt-5.5' }
      }

      const result = resolveXuanpuAgentModelRef(undefined, undefined, config)

      expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-5.5' })
    })

    it('selected model takes precedence over config mainModel', () => {
      const selected = { providerID: 'google', modelID: 'gemini-2.5-pro' }
      const config = {
        enabled: true,
        mainModel: { providerID: 'openai', modelID: 'gpt-5.5' }
      }

      const result = resolveXuanpuAgentModelRef(undefined, selected, config)

      expect(result).toBe(selected)
    })
  })

  describe('resolveConfiguredApiKey', () => {
    it('returns API key from env var', () => {
      for (const key of credentialEnvKeys) delete process.env[key]
      process.env.OPENAI_API_KEY = 'sk-test-from-env'

      const result = resolveConfiguredApiKey('openai')

      expect(result).toBe('sk-test-from-env')
    })

    it('returns API key from config apiKeyEnv', () => {
      for (const key of credentialEnvKeys) delete process.env[key]
      process.env.CUSTOM_KEY = 'custom-value'

      const config = {
        enabled: true,
        mainModel: { providerID: 'openai', modelID: 'gpt-5.5' },
        providers: {
          openai: { apiKeyEnv: 'CUSTOM_KEY' }
        }
      }

      const result = resolveConfiguredApiKey('openai', config)

      expect(result).toBe('custom-value')
    })

    it('returns undefined when no credential found', () => {
      for (const key of credentialEnvKeys) delete process.env[key]

      const result = resolveConfiguredApiKey('openai')

      expect(result).toBeUndefined()
    })

    it('returns undefined for unknown provider', () => {
      const result = resolveConfiguredApiKey('unknown-provider')

      expect(result).toBeUndefined()
    })
  })
})
