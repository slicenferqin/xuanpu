import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '0.0.0-test')
  }
}))

describe('xuanpu-agent runtime status', () => {
  const envKeys = [
    'XUANPU_AGENT_RUNTIME',
    'XUANPU_AGENT_MOCK_RESPONSE',
    'ANTHROPIC_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_FOUNDRY_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY'
  ]
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))

  afterEach(() => {
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

    const { getXuanpuAgentRuntimeStatus } = await import('../../src/main/services/system-info')

    expect(getXuanpuAgentRuntimeStatus()).toMatchObject({
      enabled: false,
      status: 'disabled',
      providerReady: false,
      runtimeGateEnv: 'XUANPU_AGENT_RUNTIME',
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5'
    })
  })

  it('reports missing credentials before a real provider call can run', async () => {
    process.env.XUANPU_AGENT_RUNTIME = '1'
    delete process.env.XUANPU_AGENT_MOCK_RESPONSE
    delete process.env.ANTHROPIC_OAUTH_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_FOUNDRY_API_KEY

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
        envKeys: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY']
      }
    })
    expect(status.toolSurface).toMatchObject({
      status: 'blocked',
      toolsEnabled: false,
      nativeProcessControlEnabled: false
    })
    expect(status.toolSurface.unmetGateIds).toContain('permission-policy')
  })

  it('treats mock mode as provider-ready without real credentials', async () => {
    process.env.XUANPU_AGENT_RUNTIME = '1'
    process.env.XUANPU_AGENT_MOCK_RESPONSE = 'mock'
    delete process.env.ANTHROPIC_API_KEY

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

    const { getXuanpuAgentRuntimeStatus } = await import('../../src/main/services/system-info')

    expect(getXuanpuAgentRuntimeStatus()).toMatchObject({
      enabled: true,
      status: 'ready',
      mockMode: false,
      providerReady: true,
      credential: {
        providerID: 'anthropic',
        required: true,
        present: true
      }
    })
  })

  it('uses an explicit model override when checking provider credentials', async () => {
    process.env.XUANPU_AGENT_RUNTIME = '1'
    delete process.env.XUANPU_AGENT_MOCK_RESPONSE
    delete process.env.ANTHROPIC_API_KEY
    process.env.OPENAI_API_KEY = 'present-for-status-test'

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
          envKeys: ['OPENAI_API_KEY']
        }
      }
    )
  })
})
