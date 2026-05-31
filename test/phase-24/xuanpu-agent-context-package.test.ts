import { describe, expect, it } from 'vitest'

import { buildXuanpuAgentPromptMessages } from '../../src/main/services/xuanpu-agent/context-transform'
import type { FieldEpisodeBlockRecord } from '../../src/main/field/episode-block-repository'

interface MockPacket {
  version: string
  identity: { packetId: string; capturedAt: number; worktreeId: string }
  worktree: { id: string; name: string; path: string; branch: string; context: null }
  git: { branch: string; ahead: number; behind: number; dirty: boolean; stashes: number }
  session: { id: string; turnCount: number }
  field: { currentFile: null; recentCommands: never[]; recentEvents: never[] }
  budget: { profile: string; fillRatio: number }
  checkpoints: never[]
  memory: null
}

interface MockDecisions {
  contextTransform: string
  zones?: Record<string, unknown>
  totalTokens?: number
  fillRatio?: number
}

function makeEpisode(overrides: Partial<FieldEpisodeBlockRecord> = {}): FieldEpisodeBlockRecord {
  return {
    id: 'ep-1',
    worktreeId: 'w-1',
    sessionId: 's-1',
    createdAt: Date.now(),
    kind: 'turns',
    title: 'Episode',
    summaryMarkdown: '## Summary\nDiscussed auth bug fix.',
    keyFacts: ['Bug in auth.ts'],
    constraints: [],
    files: ['auth.ts'],
    commands: [],
    failures: [],
    rawRefs: [{ type: 'session_message', id: 'msg-1', role: 'user' }],
    tokenEstimate: 50,
    confidence: 'medium',
    metadata: {},
    ...overrides
  }
}

describe('buildXuanpuAgentPromptMessages — M7 Context Packer path', () => {
  it('uses context packer when episodeRecords and workingSet are provided', () => {
    const result = buildXuanpuAgentPromptMessages({
      currentUserText: 'Fix the bug',
      fieldContextMarkdown: 'Current file: src/auth.ts',
      episodeRecords: [makeEpisode()],
      workingSet: [
        { messageId: 'msg-10', role: 'user', content: 'Previous question', createdAt: 1000 },
        { messageId: 'msg-11', role: 'assistant', content: 'Previous answer', createdAt: 2000 }
      ]
    })

    expect(result.decisions.contextTransform).toBe('m7-context-packer')
    expect(result.messages.length).toBeGreaterThan(3)
    // Should include field context
    const allText = result.messages.map((m) => m.content[0].text).join('\n')
    expect(allText).toContain('src/auth.ts')
    // Should include episode
    expect(allText).toContain('auth bug fix')
    // Should include working set
    expect(allText).toContain('Previous question')
    // Should include current request
    expect(result.messages[result.messages.length - 1].content[0].text).toBe('Fix the bug')
  })

  it('deduplicates working set against episode rawRefs', () => {
    const result = buildXuanpuAgentPromptMessages({
      currentUserText: 'What now?',
      episodeRecords: [
        makeEpisode({
          rawRefs: [{ type: 'session_message', id: 'shared-msg', role: 'user' }]
        })
      ],
      workingSet: [
        { messageId: 'shared-msg', role: 'user', content: 'Already in episode', createdAt: 1000 },
        { messageId: 'unique-msg', role: 'user', content: 'Not in episode', createdAt: 2000 }
      ]
    })

    expect(result.decisions.contextTransform).toBe('m7-context-packer')
    const allText = result.messages.map((m) => m.content[0].text).join('\n')
    expect(allText).not.toContain('Already in episode')
    expect(allText).toContain('Not in episode')
  })

  it('falls back to legacy path when episodeRecords is not provided', () => {
    const result = buildXuanpuAgentPromptMessages({
      currentUserText: 'Hello',
      priorMessages: [
        { role: 'user', content: 'Previous', createdAt: 1000 }
      ]
    })

    expect(result.decisions.contextTransform).toBe('legacy-minimal-anchor')
  })

  it('falls back to legacy path when workingSet is not provided', () => {
    const result = buildXuanpuAgentPromptMessages({
      currentUserText: 'Hello',
      episodeRecords: [makeEpisode()]
    })

    expect(result.decisions.contextTransform).toBe('legacy-minimal-anchor')
  })

  it('harness path takes priority over context packer', () => {
    const result = buildXuanpuAgentPromptMessages({
      currentUserText: 'Hello',
      harnessContext: {
        packet: {
          version: '1.0',
          identity: {
            packetId: 'test-packet',
            capturedAt: Date.now(),
            worktreeId: 'w-1'
          },
          worktree: { id: 'w-1', name: 'test', path: '/repo', branch: 'main', context: null },
          git: { branch: 'main', ahead: 0, behind: 0, dirty: false, stashes: 0 },
          session: { id: 's-1', turnCount: 0 },
          field: { currentFile: null, recentCommands: [], recentEvents: [] },
          budget: { profile: 'balanced', fillRatio: 0 },
          checkpoints: [],
          memory: null
        } as MockPacket,
        log: {
          entries: [],
          appendAndPersist: () => {},
          toMessages: () => []
        }
      },
      episodeRecords: [makeEpisode()],
      workingSet: []
    })

    expect(result.decisions.contextTransform).toBe('xfp-harness-context-packer')
  })

  it('context packer decisions include zone breakdown', () => {
    const result = buildXuanpuAgentPromptMessages({
      currentUserText: 'Test request',
      fieldContextMarkdown: 'field context',
      episodeRecords: [makeEpisode()],
      workingSet: [
        { messageId: 'msg-1', role: 'user', content: 'Turn 1', createdAt: 1000 }
      ]
    })

    expect(result.decisions.contextTransform).toBe('m7-context-packer')
    const decisions = result.decisions as MockDecisions
    expect(decisions.zones).toBeDefined()
    expect(decisions.zones.anchor).toBeDefined()
    expect(decisions.zones.currentField).toBeDefined()
    expect(decisions.zones.frozenEpisodes).toBeDefined()
    expect(decisions.zones.workingSet).toBeDefined()
    expect(decisions.zones.currentRequest).toBeDefined()
    expect(decisions.totalTokens).toBeGreaterThan(0)
    expect(decisions.fillRatio).toBeGreaterThan(0)
  })
})
