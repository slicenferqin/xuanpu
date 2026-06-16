import { describe, expect, it } from 'vitest'

import { ContextFrameCompiler } from '../../src/main/services/xuanpu-agent/context/context-frame-compiler'
import type { FieldEpisodeBlockRecord } from '../../src/main/field/episode-block-repository'

function makeProviderNativeMetadata(refId: string) {
  return {
    segmentCompaction: {
      providerNative: {
        provider: 'openai',
        preserveDataRef: `provider-native-compaction:${refId}`,
        preserveDataPath: `/tmp/xuanpu/${refId}.json`,
        preserveDataSha256: refId,
        preserveDataBytes: 256,
        replacementHistoryCount: 2,
        compactionItemType: 'compaction',
        replayable: true,
        historyReplacementId: `hr-${refId}`,
        firstKeptEntryId: `entry-${refId}`
      }
    }
  }
}

function makeEpisode(overrides: Partial<FieldEpisodeBlockRecord> = {}): FieldEpisodeBlockRecord {
  return {
    id: 'ep-1',
    worktreeId: 'w-1',
    sessionId: 's-1',
    createdAt: 1000,
    kind: 'turns',
    title: 'Episode',
    summaryMarkdown: 'Episode summary',
    keyFacts: [],
    constraints: [],
    files: [],
    commands: [],
    failures: [],
    rawRefs: [{ type: 'session_message', id: 'msg-frozen', role: 'user' }],
    tokenEstimate: 20,
    confidence: 'medium',
    metadata: {},
    ...overrides
  }
}

describe('ContextFrameCompiler', () => {
  it('wraps packContext output with frame metadata and raw-ref ledger', () => {
    const compiler = new ContextFrameCompiler()
    const frame = compiler.compile({
      anchor: 'stable anchor',
      fieldContextMarkdown: 'field state',
      frozenEpisodes: [
        makeEpisode({
          metadata: makeProviderNativeMetadata('frozen-sha')
        })
      ],
      retrievedEpisodes: [
        {
          episode: makeEpisode({
            id: 'ep-retrieved',
            rawRefs: [{ type: 'session_message', id: 'msg-retrieved', role: 'assistant' }],
            metadata: makeProviderNativeMetadata('retrieved-sha')
          }),
          retrievalReason: 'keyword:previous'
        }
      ],
      workingSet: [
        { messageId: 'msg-frozen', role: 'user', content: 'deduped', createdAt: 1 },
        { messageId: 'msg-live', role: 'assistant', content: 'live turn', createdAt: 2 }
      ],
      currentRequest: 'continue',
      buildReason: 'user-round-start',
      scope: {
        taskRunId: 'task-run-1',
        userRoundId: 'round-1',
        contextSegmentId: 'segment-1',
        contextSegmentOrdinal: 0
      },
      now: 1234
    })

    expect(frame.schemaVersion).toBe(1)
    expect(frame.frameId).toMatch(/^[0-9a-f]{64}$/)
    expect(frame.decisions.contextTransform).toBe('context-frame-compiler')
    expect(frame.decisions.providerMessageCount).toBe(frame.providerContextMessages.length + 1)
    expect(frame.scope).toMatchObject({
      taskRunId: 'task-run-1',
      userRoundId: 'round-1',
      contextSegmentId: 'segment-1',
      contextSegmentOrdinal: 0
    })
    expect(frame.ledger.zones.frozenEpisodeIds).toEqual(['ep-1'])
    expect(frame.ledger.zones.retrievedEpisodeIds).toEqual(['ep-retrieved'])
    expect(frame.ledger.zones.workingSetIncludedMessageIds).toContain('msg-live')
    expect(frame.ledger.zones.workingSetDroppedMessageIds).toContain('msg-frozen')
    expect(frame.ledger.rawRefs.frozenEpisodeRawRefs).toContainEqual(
      expect.objectContaining({ id: 'msg-frozen' })
    )
    expect(frame.ledger.rawRefs.retrievedEpisodeRawRefs).toContainEqual(
      expect.objectContaining({ id: 'msg-retrieved' })
    )
    expect(frame.ledger.rawRefs.workingSetRawRefs).toContainEqual(
      expect.objectContaining({ id: 'msg-live' })
    )
    expect(frame.ledger.providerNativeReplay.replayableCount).toBe(2)
    expect(frame.ledger.providerNativeReplay.refs).toEqual([
      expect.objectContaining({
        source: 'frozen-episode',
        episodeId: 'ep-1',
        ref: 'provider-native-compaction:frozen-sha',
        sha256: 'frozen-sha',
        replayable: true
      }),
      expect.objectContaining({
        source: 'retrieved-episode',
        episodeId: 'ep-retrieved',
        ref: 'provider-native-compaction:retrieved-sha',
        sha256: 'retrieved-sha',
        replayable: true
      })
    ])
    expect(frame.decisions.providerNativeReplay.replayableCount).toBe(2)
  })

  it('keeps frameId stable for identical inputs and scope', () => {
    const compiler = new ContextFrameCompiler()
    const input = {
      anchor: 'stable anchor',
      fieldContextMarkdown: null,
      frozenEpisodes: [makeEpisode()],
      workingSet: [],
      currentRequest: 'same request',
      now: 1234
    }

    expect(compiler.compile(input).frameId).toBe(compiler.compile(input).frameId)
  })
})
