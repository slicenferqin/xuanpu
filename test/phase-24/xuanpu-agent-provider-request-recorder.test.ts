import { describe, expect, it, vi } from 'vitest'

const turnRepoMock = vi.hoisted(() => ({
  createAgentTurnContextSnapshot: vi.fn()
}))

const taskRunRepoMock = vi.hoisted(() => ({
  incrementUserRoundProviderRequestCount: vi.fn()
}))

vi.mock('../../src/main/db/turn-repository', () => turnRepoMock)
vi.mock('../../src/main/db/task-run-repository', () => taskRunRepoMock)

import { recordProviderRequestSnapshot } from '../../src/main/services/xuanpu-agent/turn/provider-request-recorder'
import type { XuanpuProviderRequestSnapshot } from '../../src/main/services/xuanpu-agent/turn/turn-snapshot'

describe('ProviderRequestRecorder', () => {
  it('stores image prompt parts as lightweight metadata only', () => {
    turnRepoMock.createAgentTurnContextSnapshot.mockClear()
    taskRunRepoMock.incrementUserRoundProviderRequestCount.mockClear()

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
    expect(taskRunRepoMock.incrementUserRoundProviderRequestCount).not.toHaveBeenCalled()
  })

  it('stores task-run, user-round, and context-segment relation metadata', () => {
    turnRepoMock.createAgentTurnContextSnapshot.mockClear()
    taskRunRepoMock.incrementUserRoundProviderRequestCount.mockClear()

    const snapshot: XuanpuProviderRequestSnapshot = {
      turnId: 'turn-1',
      sessionId: 'session-1',
      taskRunId: 'task-run-1',
      userRoundId: 'round-1',
      contextSegmentId: 'segment-1',
      contextSegmentOrdinal: 2,
      providerCallSeq: 0,
      providerRequestHash: 'hash-1',
      systemPrompt: ['system'],
      contextMessages: [],
      promptMessage: {
        role: 'user',
        content: [{ type: 'text', text: 'current request' }],
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
      },
      providerNativeReplay: {
        replayableCount: 1,
        refs: [
          {
            source: 'frozen-episode',
            episodeId: 'episode-1',
            provider: 'openai',
            ref: 'provider-native-compaction:sha-a',
            path: '/tmp/archive/a.json',
            sha256: 'sha-a',
            bytes: 512,
            replacementHistoryCount: 2,
            compactionItemType: 'compaction',
            replayable: true,
            historyReplacementId: 'hr-1',
            firstKeptEntryId: 'entry-9'
          }
        ]
      }
    }

    recordProviderRequestSnapshot(snapshot, 'packet-1')

    const stored = turnRepoMock.createAgentTurnContextSnapshot.mock.calls[0][0]
    expect(stored).toMatchObject({
      turnId: 'turn-1',
      sessionId: 'session-1',
      xfpPacketId: 'packet-1',
      taskRunId: 'task-run-1',
      userRoundId: 'round-1',
      contextSegmentId: 'segment-1',
      contextSegmentOrdinal: 2,
      providerCallSeq: 0
    })
    expect(JSON.parse(stored.managedContextJson)).toMatchObject({
      taskRunId: 'task-run-1',
      userRoundId: 'round-1',
      contextSegmentId: 'segment-1',
      contextSegmentOrdinal: 2,
      providerCallSeq: 0,
      providerNativeReplay: {
        replayableCount: 1
      }
    })
    expect(JSON.parse(stored.decisionsJson)).toMatchObject({
      taskRunId: 'task-run-1',
      userRoundId: 'round-1',
      contextSegmentId: 'segment-1',
      contextSegmentOrdinal: 2,
      providerCallSeq: 0,
      providerNativeReplay: {
        replayableCount: 1
      }
    })
    expect(taskRunRepoMock.incrementUserRoundProviderRequestCount).toHaveBeenCalledWith('round-1')
  })

  it('stores gateway budget decisions in managed context and decision audit payloads', () => {
    turnRepoMock.createAgentTurnContextSnapshot.mockClear()
    taskRunRepoMock.incrementUserRoundProviderRequestCount.mockClear()

    const snapshot: XuanpuProviderRequestSnapshot = {
      turnId: 'turn-1',
      sessionId: 'session-1',
      taskRunId: 'task-run-1',
      userRoundId: 'round-1',
      contextSegmentId: 'segment-1',
      contextSegmentOrdinal: 2,
      providerCallSeq: 0,
      providerRequestHash: 'hash-1',
      systemPrompt: ['system'],
      contextMessages: [],
      promptMessage: {
        role: 'user',
        content: [{ type: 'text', text: 'current request' }],
        timestamp: 2
      },
      toolsJson: '[]',
      modelRef: { providerID: 'openai', modelID: 'gpt-test' },
      providerSessionPolicy: {
        mode: 'disabled',
        reason: 'xuanpu owns turn-scoped context'
      },
      budget: {
        profile: 'extended',
        managedApproxTokens: 215000,
        providerEstimatedInputTokens: 221000,
        maxContextTokens: 250000,
        fillRatio: 1.105,
        gateway: {
          action: 'compact',
          reason: 'maintenance',
          requestedProfile: 'balanced',
          effectiveProfile: 'extended',
          profileMaxTokens: 200000,
          maintenanceTokenLimit: 220000,
          hardTokenLimit: 250000,
          providerEstimatedInputTokens: 221000,
          providerContextWindowTokens: 1000000,
          fillRatio: 1.105
        }
      }
    }

    recordProviderRequestSnapshot(snapshot)

    const stored = turnRepoMock.createAgentTurnContextSnapshot.mock.calls[0][0]
    expect(JSON.parse(stored.managedContextJson).gateway).toMatchObject({
      action: 'compact',
      hardTokenLimit: 250000
    })
    expect(JSON.parse(stored.decisionsJson).gateway).toMatchObject({
      action: 'compact',
      providerContextWindowTokens: 1000000
    })
  })
})
