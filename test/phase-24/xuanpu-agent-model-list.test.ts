import { afterEach, describe, expect, it, vi } from 'vitest'
import { XuanpuAgentImplementer } from '../../src/main/services/xuanpu-agent-implementer'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp')
  }
}))

const previousMockResponse = process.env.XUANPU_AGENT_MOCK_RESPONSE

describe('xuanpu-agent model listing', () => {
  afterEach(() => {
    if (previousMockResponse === undefined) {
      delete process.env.XUANPU_AGENT_MOCK_RESPONSE
    } else {
      process.env.XUANPU_AGENT_MOCK_RESPONSE = previousMockResponse
    }
  })

  it('returns a ModelSelector-compatible provider list for hidden dogfood sessions', async () => {
    const implementer = new XuanpuAgentImplementer()

    await expect(implementer.getAvailableModels()).resolves.toEqual([
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude-haiku-4-5': {
            id: 'claude-haiku-4-5',
            name: 'claude-haiku-4-5'
          }
        }
      }
    ])
  })

  it('shows the deterministic mock model when mock provider execution is enabled', async () => {
    process.env.XUANPU_AGENT_MOCK_RESPONSE = 'ui mock'
    const implementer = new XuanpuAgentImplementer()

    await expect(implementer.getAvailableModels()).resolves.toEqual([
      {
        id: 'xuanpu-agent',
        name: 'Xuanpu Agent',
        models: {
          'xuanpu-agent-mock': {
            id: 'xuanpu-agent-mock',
            name: 'xuanpu-agent-mock'
          }
        }
      }
    ])
  })
})
