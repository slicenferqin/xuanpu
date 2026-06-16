import { describe, expect, it } from 'vitest'

import { ContextFrameCompiler } from '../../src/main/services/xuanpu-agent/context/context-frame-compiler'
import type { FieldEpisodeBlockRecord } from '../../src/main/field/episode-block-repository'

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
      frozenEpisodes: [makeEpisode()],
      retrievedEpisodes: [
        {
          episode: makeEpisode({
            id: 'ep-retrieved',
            rawRefs: [{ type: 'session_message', id: 'msg-retrieved', role: 'assistant' }]
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
