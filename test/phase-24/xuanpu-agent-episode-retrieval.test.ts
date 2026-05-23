import { describe, expect, it } from 'vitest'

import {
  selectRetrievedEpisodesForContext,
  type XuanpuAgentEpisodeRetrievalInput
} from '../../src/main/services/xuanpu-agent/episode-retrieval'
import type { FieldEpisodeBlockRecord } from '../../src/main/field/episode-block-repository'

function episode(
  id: string,
  overrides: Partial<FieldEpisodeBlockRecord> = {}
): FieldEpisodeBlockRecord {
  return {
    id,
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    createdAt: 1000,
    kind: 'turns',
    title: `Episode ${id}`,
    summaryMarkdown: `summary for ${id}`,
    keyFacts: [],
    constraints: [],
    files: [],
    commands: [],
    failures: [],
    rawRefs: [{ type: 'session_message', id: `${id}-message` }],
    tokenEstimate: 100,
    confidence: 'medium',
    ...overrides
  }
}

function select(overrides: Partial<XuanpuAgentEpisodeRetrievalInput>) {
  return selectRetrievedEpisodesForContext({
    userText: 'plain current request',
    episodes: [],
    currentSessionId: 'session-1',
    ...overrides
  })
}

describe('xuanpu-agent gated episode retrieval', () => {
  it('does not retrieve episodes for unrelated prompts', () => {
    const result = select({
      episodes: [
        episode('episode-1', {
          files: ['src/main/services/xuanpu-agent/runtime.ts'],
          commands: ['pnpm test']
        })
      ]
    })

    expect(result.included).toEqual([])
    expect(result.decisions).toMatchObject({
      policy: 'deterministic-gated-episode-retrieval',
      triggered: false,
      includedIds: []
    })
  })

  it('retrieves the matching file episode without retrieving unrelated episodes', () => {
    const result = select({
      userText: '请检查 src/main/services/xuanpu-agent/runtime.ts 的实现细节',
      episodes: [
        episode('match', {
          files: ['src/main/services/xuanpu-agent/runtime.ts'],
          createdAt: 1000
        }),
        episode('other', {
          files: ['src/main/services/codex-implementer.ts'],
          createdAt: 2000
        })
      ]
    })

    expect(result.included.map((item) => item.id)).toEqual(['match'])
    expect(result.decisions.triggers).toContain('file_path')
    expect(result.decisions.scores[0]).toMatchObject({
      id: 'match'
    })
    expect(result.decisions.scores[0]?.reasons.join(',')).toContain('file:')
  })

  it('uses historical references to retrieve recent same-session episodes', () => {
    const result = select({
      userText: '上次那个方案继续',
      episodes: [
        episode('older-other-session', {
          sessionId: 'session-2',
          createdAt: 1000
        }),
        episode('newer-same-session', {
          sessionId: 'session-1',
          createdAt: 2000
        })
      ]
    })

    expect(result.included.map((item) => item.id)).toEqual([
      'newer-same-session',
      'older-other-session'
    ])
    expect(result.decisions.triggers).toContain('historical_reference')
    expect(result.decisions.triggers).toContain('short_referential_input')
  })

  it('honors episode and token limits after scoring', () => {
    const result = select({
      userText: '之前 src/a.ts src/b.ts src/c.ts',
      maxEpisodes: 2,
      maxTokens: 150,
      episodes: [
        episode('a', { files: ['src/a.ts'], tokenEstimate: 100, createdAt: 3000 }),
        episode('b', { files: ['src/b.ts'], tokenEstimate: 100, createdAt: 2000 }),
        episode('c', { files: ['src/c.ts'], tokenEstimate: 100, createdAt: 1000 })
      ]
    })

    expect(result.included.map((item) => item.id)).toEqual(['a'])
    expect(result.decisions.droppedCount).toBe(2)
  })
})
