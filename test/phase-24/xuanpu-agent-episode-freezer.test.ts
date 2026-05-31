import { describe, expect, it } from 'vitest'

import {
  selectMessagesForEpisodeFreeze,
  type XuanpuAgentFreezeMessage
} from '../../src/main/services/xuanpu-agent/episode-freezer'
import type { FieldEpisodeBlockRecord } from '../../src/main/field/episode-block-repository'

function messages(count: number): XuanpuAgentFreezeMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index + 1}`,
    createdAt: index
  }))
}

function episodeWithRefs(ids: string[]): FieldEpisodeBlockRecord {
  return {
    id: 'episode-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    createdAt: 1,
    kind: 'turns',
    title: 'Episode',
    summaryMarkdown: 'summary',
    keyFacts: [],
    constraints: [],
    files: [],
    commands: [],
    failures: [],
    rawRefs: ids.map((id) => ({ type: 'session_message', id })),
    tokenEstimate: 1,
    confidence: 'medium'
  }
}

describe('xuanpu-agent episode freezer', () => {
  it('freezes old visible messages while keeping the recent working set raw', () => {
    const selected = selectMessagesForEpisodeFreeze(messages(10), [])
    expect(selected.map((message) => message.id)).toEqual(['m-1', 'm-2', 'm-3', 'm-4'])
  })

  it('does not freeze already referenced raw messages again', () => {
    const selected = selectMessagesForEpisodeFreeze(messages(14), [
      episodeWithRefs(['m-1', 'm-2', 'm-3', 'm-4'])
    ])
    expect(selected.map((message) => message.id)).toEqual(['m-5', 'm-6', 'm-7', 'm-8'])
  })

  it('waits until enough unreferenced old messages are available', () => {
    const selected = selectMessagesForEpisodeFreeze(messages(12), [
      episodeWithRefs(['m-1', 'm-2', 'm-3', 'm-4'])
    ])
    expect(selected).toEqual([])
  })

  it('ignores system, empty, and idless messages', () => {
    const selected = selectMessagesForEpisodeFreeze(
      [
        ...messages(4),
        { id: 'sys-1', role: 'system', content: 'system' },
        { id: null, role: 'user', content: 'idless' },
        { id: 'empty', role: 'assistant', content: '   ' },
        ...messages(6).map((message, index) => ({ ...message, id: `tail-${index}` }))
      ],
      []
    )
    expect(selected.map((message) => message.id)).toEqual(['m-1', 'm-2', 'm-3', 'm-4'])
  })
})
