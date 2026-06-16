import { describe, expect, it } from 'vitest'

import { SegmentCompactor } from '../../src/main/services/xuanpu-agent/context/segment-compactor'
import type { FieldEpisodeBlockRecord } from '../../src/main/field/episode-block-repository'
import type { XuanpuAgentFreezeMessage } from '../../src/main/services/xuanpu-agent/episode-freezer'

function makeMessage(id: string, index: number): XuanpuAgentFreezeMessage {
  return {
    id,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index} content`,
    createdAt: index
  }
}

function makeEpisode(refId: string): FieldEpisodeBlockRecord {
  return {
    id: `ep-${refId}`,
    worktreeId: 'w-1',
    sessionId: 's-1',
    createdAt: 1,
    kind: 'turns',
    title: 'Existing',
    summaryMarkdown: 'already frozen',
    keyFacts: [],
    constraints: [],
    files: [],
    commands: [],
    failures: [],
    rawRefs: [{ type: 'session_message', id: refId }],
    tokenEstimate: 10,
    confidence: 'medium',
    metadata: {}
  }
}

describe('SegmentCompactor', () => {
  it('compacts old messages and records firstKeptEntryId for segment audit', () => {
    const messages = Array.from({ length: 10 }, (_, index) => makeMessage(`msg-${index}`, index))
    const result = new SegmentCompactor().compact({
      worktreeId: 'w-1',
      sessionId: 's-1',
      taskRunId: 'task-run-1',
      contextSegmentId: 'segment-1',
      reason: 'context-full',
      messages,
      existingEpisodes: []
    })

    expect(result.status).toBe('compacted')
    if (result.status !== 'compacted') return
    expect(result.selectedMessageIds).toEqual(['msg-0', 'msg-1', 'msg-2', 'msg-3'])
    expect(result.keptRecentMessageIds).toEqual([
      'msg-4',
      'msg-5',
      'msg-6',
      'msg-7',
      'msg-8',
      'msg-9'
    ])
    expect(result.firstKeptEntryId).toBe('msg-4')
    expect(result.episode.metadata?.segmentCompaction).toMatchObject({
      version: 1,
      reason: 'context-full',
      taskRunId: 'task-run-1',
      contextSegmentId: 'segment-1',
      firstKeptEntryId: 'msg-4'
    })
  })

  it('does not freeze messages already covered by existing episodes', () => {
    const messages = Array.from({ length: 10 }, (_, index) => makeMessage(`msg-${index}`, index))
    const result = new SegmentCompactor().compact({
      worktreeId: 'w-1',
      sessionId: 's-1',
      reason: 'context-full',
      messages,
      existingEpisodes: [makeEpisode('msg-0'), makeEpisode('msg-1')],
      options: { minFreezeMessages: 2 }
    })

    expect(result.status).toBe('compacted')
    if (result.status !== 'compacted') return
    expect(result.selectedMessageIds).toEqual(['msg-2', 'msg-3'])
    expect(result.episode.rawRefs.map((ref) => ref.id)).toEqual(['msg-2', 'msg-3'])
  })

  it('hashes provider-native preserveData instead of storing the raw payload', () => {
    const messages = Array.from({ length: 10 }, (_, index) => makeMessage(`msg-${index}`, index))
    const result = new SegmentCompactor().compact({
      worktreeId: 'w-1',
      sessionId: 's-1',
      reason: 'provider-native',
      messages,
      existingEpisodes: [],
      providerNative: {
        provider: 'openai-responses',
        firstKeptEntryId: 'remote-entry-7',
        historyReplacementId: 'hr-1',
        preserveData: { encrypted: 'secret-provider-state' }
      }
    })

    expect(result.status).toBe('compacted')
    if (result.status !== 'compacted') return
    expect(result.firstKeptEntryId).toBe('remote-entry-7')
    expect(JSON.stringify(result.episode.metadata)).not.toContain('secret-provider-state')
    expect(result.audit.providerNative).toMatchObject({
      provider: 'openai-responses',
      firstKeptEntryId: 'remote-entry-7',
      historyReplacementId: 'hr-1',
      preserveDataBytes: expect.any(Number)
    })
    expect(result.audit.providerNative.preserveDataSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('skips when there are not enough old messages to freeze', () => {
    const result = new SegmentCompactor().compact({
      worktreeId: 'w-1',
      sessionId: 's-1',
      reason: 'context-full',
      messages: [makeMessage('msg-1', 1), makeMessage('msg-2', 2)],
      existingEpisodes: []
    })

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'insufficient-messages',
      selectedMessageIds: []
    })
  })
})
