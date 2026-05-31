import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '0.0.0-test')
  }
}))

const mockLoadXuanpuAgentConfig = vi.fn()

vi.mock('../../src/main/services/xuanpu-agent/config-loader', () => ({
  loadXuanpuAgentConfig: (...args: unknown[]) => mockLoadXuanpuAgentConfig(...args)
}))

describe('xuanpu-agent runtime status', () => {
  const envKeys = [
    'XUANPU_AGENT_RUNTIME',
    'XUANPU_AGENT_MOCK_RESPONSE',
    'ANTHROPIC_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_FOUNDRY_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'XUANPU_AGENT_OPENAI_BASE_URL',
    'OPENAI_BASE_URL'
  ]
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))

  afterEach(() => {
    vi.restoreAllMocks()
    for (const key of envKeys) {
      const value = previousEnv[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('reports disabled when the feature gate is off', async () => {
    delete process.env.XUANPU_AGENT_RUNTIME
    delete process.env.XUANPU_AGENT_MOCK_RESPONSE
    delete process.env.ANTHROPIC_API_KEY

    mockLoadXuanpuAgentConfig.mockReturnValue({
      config: { enabled: false, mainModel: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' } },
      configSource: 'env-only',
      configPath: '/tmp/.xuanpu/xuanpu-agent.json',
      configLoaded: false
    })

    const { getXuanpuAgentRuntimeStatus } = await import('../../src/main/services/system-info')

    const status = getXuanpuAgentRuntimeStatus()
    expect(status).toMatchObject({
      enabled: false,
      status: 'disabled',
      providerReady: false,
      runtimeGateEnv: 'XUANPU_AGENT_RUNTIME',
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5'
    })
    expect(status.configSource).toBe('env-only')
    expect(status.configLoaded).toBe(false)
    expect(status.credential.source).toBe('missing')
  })

  it('reports missing credentials before a real provider call can run', async () => {
    process.env.XUANPU_AGENT_RUNTIME = '1'
    delete process.env.XUANPU_AGENT_MOCK_RESPONSE
    delete process.env.ANTHROPIC_OAUTH_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_FOUNDRY_API_KEY

    mockLoadXuanpuAgentConfig.mockReturnValue({
      config: { enabled: false, mainModel: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' } },
      configSource: 'env-only',
      configPath: '/tmp/.xuanpu/xuanpu-agent.json',
      configLoaded: false
    })

    const { getXuanpuAgentRuntimeStatus } = await import('../../src/main/services/system-info')
    const status = getXuanpuAgentRuntimeStatus()

    expect(status).toMatchObject({
      enabled: true,
      status: 'missing-credentials',
      providerReady: false,
      credential: {
        providerID: 'anthropic',
        required: true,
        present: false,
        envKeys: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY'],
        source: 'missing'
      }
    })
    expect(status.toolSurface).toMatchObject({
      status: 'controlled-write',
      toolsEnabled: true,
      nativeProcessControlEnabled: false
    })
    expect(status.toolSurface.unmetGateIds).not.toContain('permission-policy')
    expect(status.toolSurface.unmetGateIds).not.toContain('checkpoint-policy')
    expect(status.toolSurface.unmetGateIds).toContain('native-packaging')
  })

  it('treats mock mode as provider-ready without real credentials', async () => {
    process.env.XUANPU_AGENT_RUNTIME = '1'
    process.env.XUANPU_AGENT_MOCK_RESPONSE = 'mock'
    delete process.env.ANTHROPIC_API_KEY

    mockLoadXuanpuAgentConfig.mockReturnValue({
      config: { enabled: false, mainModel: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' } },
      configSource: 'env-only',
      configPath: '/tmp/.xuanpu/xuanpu-agent.json',
      configLoaded: false
    })

    const { getXuanpuAgentRuntimeStatus } = await import('../../src/main/services/system-info')

    expect(getXuanpuAgentRuntimeStatus()).toMatchObject({
      enabled: true,
      status: 'mock-ready',
      mockMode: true,
      providerReady: true,
      credential: {
        providerID: 'anthropic',
        required: true,
        present: true
      }
    })
  })

  it('reports ready when the default provider credential is present', async () => {
    process.env.XUANPU_AGENT_RUNTIME = '1'
    delete process.env.XUANPU_AGENT_MOCK_RESPONSE
    process.env.ANTHROPIC_API_KEY = 'present-for-status-test'

    mockLoadXuanpuAgentConfig.mockReturnValue({
      config: { enabled: false, mainModel: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' } },
      configSource: 'env-only',
      configPath: '/tmp/.xuanpu/xuanpu-agent.json',
      configLoaded: false
    })

    const { getXuanpuAgentRuntimeStatus } = await import('../../src/main/services/system-info')

    expect(getXuanpuAgentRuntimeStatus()).toMatchObject({
      enabled: true,
      status: 'ready',
      mockMode: false,
      providerReady: true,
      credential: {
        providerID: 'anthropic',
        required: true,
        present: true,
        source: 'env'
      }
    })
  })

  it('uses an explicit model override when checking provider credentials', async () => {
    process.env.XUANPU_AGENT_RUNTIME = '1'
    delete process.env.XUANPU_AGENT_MOCK_RESPONSE
    delete process.env.ANTHROPIC_API_KEY
    process.env.OPENAI_API_KEY = 'present-for-status-test'

    mockLoadXuanpuAgentConfig.mockReturnValue({
      config: { enabled: false, mainModel: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' } },
      configSource: 'env-only',
      configPath: '/tmp/.xuanpu/xuanpu-agent.json',
      configLoaded: false
    })

    const { getXuanpuAgentRuntimeStatus } = await import('../../src/main/services/system-info')

    expect(getXuanpuAgentRuntimeStatus({ providerID: 'openai', modelID: 'gpt-4.1' })).toMatchObject(
      {
        enabled: true,
        status: 'ready',
        providerID: 'openai',
        modelID: 'gpt-4.1',
        credential: {
          providerID: 'openai',
          required: true,
          present: true,
          envKeys: ['OPENAI_API_KEY'],
          source: 'env'
        }
      }
    )
  })

  it('reports config-error when config file is malformed', async () => {
    process.env.XUANPU_AGENT_RUNTIME = '1'

    mockLoadXuanpuAgentConfig.mockImplementation(() => {
      throw new Error('Failed to parse xuanpu-agent config: invalid JSON.')
    })

    const { getXuanpuAgentRuntimeStatus } = await import('../../src/main/services/system-info')

    const status = getXuanpuAgentRuntimeStatus()
    expect(status.status).toBe('config-error')
    expect(status.configSource).toBe('config-error')
    expect(status.providerReady).toBe(false)
  })

  it('reports config-enabled when config file has enabled=true', async () => {
    delete process.env.XUANPU_AGENT_RUNTIME
    delete process.env.XUANPU_AGENT_MOCK_RESPONSE
    process.env.ANTHROPIC_API_KEY = 'test-key'

    mockLoadXuanpuAgentConfig.mockReturnValue({
      config: {
        enabled: true,
        mainModel: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' }
      },
      configSource: 'xuanpu-agent-json',
      configPath: '/tmp/.xuanpu/xuanpu-agent.json',
      configLoaded: true
    })

    const { getXuanpuAgentRuntimeStatus } = await import('../../src/main/services/system-info')

    const status = getXuanpuAgentRuntimeStatus()
    expect(status.enabled).toBe(true)
    expect(status.status).toBe('ready')
    expect(status.configSource).toBe('xuanpu-agent-json')
    expect(status.configLoaded).toBe(true)
  })

  it('includes baseUrl from config when env vars are not set', async () => {
    process.env.XUANPU_AGENT_RUNTIME = '1'
    delete process.env.XUANPU_AGENT_OPENAI_BASE_URL
    delete process.env.OPENAI_BASE_URL
    process.env.OPENAI_API_KEY = 'test-key'

    mockLoadXuanpuAgentConfig.mockReturnValue({
      config: {
        enabled: true,
        mainModel: { providerID: 'openai', modelID: 'gpt-5.5' },
        providers: {
          openai: { baseUrl: 'https://config.example.com/v1' }
        }
      },
      configSource: 'xuanpu-agent-json',
      configPath: '/tmp/.xuanpu/xuanpu-agent.json',
      configLoaded: true
    })

    const { getXuanpuAgentRuntimeStatus } = await import('../../src/main/services/system-info')

    const status = getXuanpuAgentRuntimeStatus()
    expect(status.baseUrl).toBe('https://config.example.com/v1')
    expect(status.baseUrlSource).toBe('config')
  })

  it('includes masked key in credential info', async () => {
    process.env.XUANPU_AGENT_RUNTIME = '1'
    delete process.env.XUANPU_AGENT_MOCK_RESPONSE
    process.env.ANTHROPIC_API_KEY = 'sk-ant-1234567890abcdef'

    mockLoadXuanpuAgentConfig.mockReturnValue({
      config: { enabled: false, mainModel: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' } },
      configSource: 'env-only',
      configPath: '/tmp/.xuanpu/xuanpu-agent.json',
      configLoaded: false
    })

    const { getXuanpuAgentRuntimeStatus } = await import('../../src/main/services/system-info')

    const status = getXuanpuAgentRuntimeStatus()
    expect(status.credential.maskedKey).toBe('sk-a...cdef')
    expect(status.credential.maskedKey).not.toContain('1234567890')
  })
})
