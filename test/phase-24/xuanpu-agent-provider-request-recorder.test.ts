import { describe, expect, it, vi } from 'vitest'

const turnRepoMock = vi.hoisted(() => ({
  createAgentTurnContextSnapshot: vi.fn()
}))

vi.mock('../../src/main/db/turn-repository', () => turnRepoMock)

import { recordProviderRequestSnapshot } from '../../src/main/services/xuanpu-agent/turn/provider-request-recorder'
import type { XuanpuProviderRequestSnapshot } from '../../src/main/services/xuanpu-agent/turn/turn-snapshot'

describe('ProviderRequestRecorder', () => {
  it('stores image prompt parts as lightweight metadata only', () => {
    turnRepoMock.createAgentTurnContextSnapshot.mockClear()

    const snapshot: XuanpuProviderRequestSnapshot = {
      turnId: 'turn-1',
      sessionId: 'session-1',
      providerRequestHash: 'hash-1',
      systemPrompt: ['system'],
      contextMessages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'context' }],
          timestamp: 1
        }
      ],
      promptMessage: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<attached_files content="metadata-only">screen.png</attached_files>'
          },
          { type: 'image', data: 'abc', mimeType: 'image/png' }
        ],
        timestamp: 2
      },
      toolsJson: '[]',
      modelRef: { providerID: 'openai', modelID: 'gpt-test' },
      providerSessionPolicy: {
        mode: 'disabled',
        reason: 'xuanpu owns turn-scoped context'
      },
      budget: {
        profile: 'balanced',
        managedApproxTokens: 10,
        providerEstimatedInputTokens: 12,
        maxContextTokens: 150000,
        fillRatio: 0.01
      }
    }

    recordProviderRequestSnapshot(snapshot)

    const stored = turnRepoMock.createAgentTurnContextSnapshot.mock.calls[0][0]
    const providerMessages = JSON.parse(stored.providerMessagesJson)
    expect(JSON.stringify(providerMessages)).not.toContain('abc')
    expect(providerMessages.promptMessage.content[1]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      byteLength: 2,
      contentOmitted: true
    })
    expect(providerMessages.promptMessage.content[1].dataSha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
