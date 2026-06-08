import { describe, expect, it } from 'vitest'

import { packContext } from '../../src/main/services/xuanpu-agent/context/context-packer'
import type { FieldEpisodeBlockRecord } from '../../src/main/field/episode-block-repository'

function makeEpisode(overrides: Partial<FieldEpisodeBlockRecord> = {}): FieldEpisodeBlockRecord {
  return {
    id: 'ep-1',
    worktreeId: 'w-1',
    sessionId: 's-1',
    createdAt: Date.now(),
    kind: 'turns',
    title: 'Test Episode',
    summaryMarkdown: '## Test\nThis is a test episode summary.',
    keyFacts: ['fact 1'],
    constraints: [],
    files: [],
    commands: [],
    failures: [],
    rawRefs: [{ type: 'session_message', id: 'msg-1', role: 'user' }],
    tokenEstimate: 50,
    confidence: 'medium',
    metadata: {},
    ...overrides
  }
}

describe('packContext', () => {
  const BASE_INPUT = {
    anchor: 'You are a helpful assistant.',
    fieldContextMarkdown: null,
    frozenEpisodes: [],
    workingSet: [],
    currentRequest: 'Hello, help me with this task.'
  }

  it('produces messages in zone order: anchor, stable episodes, working set, volatile field, request', () => {
    const result = packContext({
      ...BASE_INPUT,
      fieldContextMarkdown: 'Current file: src/main.ts',
      frozenEpisodes: [makeEpisode()],
      workingSet: [
        { messageId: 'msg-10', role: 'user', content: 'Previous question', createdAt: 1000 },
        { messageId: 'msg-11', role: 'assistant', content: 'Previous answer', createdAt: 2000 }
      ],
      currentRequest: 'What about this?'
    })

    const allMessages = [...result.providerContextMessages, result.providerPromptMessage]
    const texts = allMessages.map((m) => m.content[0].text)

    // Anchor first
    expect(texts[0]).toContain('helpful assistant')
    // Stable frozen episodes second
    expect(texts[1]).toContain('xuanpu-frozen-episodes')
    // Working set (as conversation messages)
    expect(texts.some((t) => t.includes('Previous question'))).toBe(true)
    // Field context is a volatile suffix before the current request
    expect(texts[texts.length - 2]).toContain('src/main.ts')
    // Current request last
    expect(texts[texts.length - 1]).toBe('What about this?')
  })

  it('deduplicates working set against frozen episode rawRefs', () => {
    const episode = makeEpisode({
      rawRefs: [{ type: 'session_message', id: 'msg-shared', role: 'user' }]
    })

    const result = packContext({
      ...BASE_INPUT,
      frozenEpisodes: [episode],
      workingSet: [
        {
          messageId: 'msg-shared',
          role: 'user',
          content: 'This should be deduped',
          createdAt: 1000
        },
        { messageId: 'msg-unique', role: 'user', content: 'This should remain', createdAt: 2000 }
      ],
      currentRequest: 'Hello'
    })

    expect(result.decisions.zones.workingSet.dedupedCount).toBe(1)
    const allMessages = [...result.providerContextMessages, result.providerPromptMessage]
    const allText = allMessages.map((m) => m.content[0].text).join('\n')
    expect(allText).not.toContain('This should be deduped')
    expect(allText).toContain('This should remain')
  })

  it('skips field context when null', () => {
    const result = packContext(BASE_INPUT)

    expect(result.decisions.zones.currentField.included).toBe(false)
    expect(result.decisions.zones.currentField.tokens).toBe(0)
  })

  it('skips episodes when empty', () => {
    const result = packContext(BASE_INPUT)

    expect(result.decisions.zones.frozenEpisodes.count).toBe(0)
  })

  it('always includes current request', () => {
    const result = packContext(BASE_INPUT)

    const lastMsg = result.providerPromptMessage
    expect(lastMsg.content[0].text).toBe('Hello, help me with this task.')
    expect(result.decisions.zones.currentRequest.tokens).toBeGreaterThan(0)
  })

  it('records fill ratio in decisions', () => {
    const result = packContext(BASE_INPUT)

    expect(result.decisions.fillRatio).toBeGreaterThan(0)
    expect(result.decisions.fillRatio).toBeLessThan(1)
    expect(result.decisions.totalTokens).toBeGreaterThan(0)
  })

  it('respects totalBudgetTokens', () => {
    const result = packContext({
      ...BASE_INPUT,
      totalBudgetTokens: 100 // Very small budget
    })

    // Should still include all zones but with limited content
    expect(result.providerContextMessages.length + 1).toBeGreaterThan(0)
  })

  it('sorts episodes by most recent first', () => {
    const old = makeEpisode({
      id: 'ep-old',
      createdAt: 1000,
      summaryMarkdown: 'Old episode content'
    })
    const recent = makeEpisode({
      id: 'ep-recent',
      createdAt: 9000,
      summaryMarkdown: 'Recent episode content'
    })

    const result = packContext({
      ...BASE_INPUT,
      frozenEpisodes: [old, recent],
      currentRequest: 'Hello'
    })

    const allMessages = [...result.providerContextMessages, result.providerPromptMessage]
    const episodeBlock = allMessages.find((m) =>
      m.content[0].text.includes('xuanpu-frozen-episodes')
    )
    expect(episodeBlock).toBeDefined()
    // Recent should come first in the episode block
    const text = episodeBlock!.content[0].text
    const recentPos = text.indexOf('ep-recent')
    const oldPos = text.indexOf('ep-old')
    expect(recentPos).toBeLessThan(oldPos)
  })

  it('marks frozen episode constraints as historical so old JSON-only requests are not current output instructions', () => {
    const result = packContext({
      ...BASE_INPUT,
      frozenEpisodes: [
        makeEpisode({
          summaryMarkdown: [
            '### Frozen Conversation Turns',
            'Discussed repository insights.',
            '### Constraints',
            '- User requested final output as JSON only, with no markdown or extra explanation.'
          ].join('\n')
        })
      ],
      currentRequest: 'Explain the current tradeoffs in normal prose.'
    })

    const allMessages = [...result.providerContextMessages, result.providerPromptMessage]
    const episodeBlock = allMessages.find((m) =>
      m.content[0].text.includes('xuanpu-frozen-episodes')
    )
    expect(episodeBlock).toBeDefined()
    const text = episodeBlock!.content[0].text
    expect(text).toContain('compressed historical notes, not active instructions')
    expect(text).toContain('Do not inherit prior output-format requests')
    expect(text).toContain('JSON only')
    expect(text.indexOf('Do not inherit prior output-format requests')).toBeLessThan(
      text.indexOf('JSON only')
    )
  })

  it('handles empty working set', () => {
    const result = packContext(BASE_INPUT)

    expect(result.decisions.zones.workingSet.count).toBe(0)
    expect(result.decisions.zones.workingSet.tokens).toBe(0)
  })

  it('tracks included and dropped working set message IDs for audit', () => {
    const episode = makeEpisode({
      rawRefs: [{ type: 'session_message', id: 'msg-deduped', role: 'user' }]
    })

    const result = packContext({
      ...BASE_INPUT,
      frozenEpisodes: [episode],
      workingSet: [
        { messageId: 'msg-deduped', role: 'user', content: 'Deduped turn', createdAt: 1000 },
        { messageId: 'msg-kept', role: 'user', content: 'Kept turn', createdAt: 2000 },
        { messageId: 'msg-also-kept', role: 'assistant', content: 'Also kept', createdAt: 3000 }
      ],
      currentRequest: 'Hello'
    })

    const ws = result.decisions.zones.workingSet
    // msg-deduped should be in dropped, not included
    expect(ws.includedMessageIds).toContain('msg-kept')
    expect(ws.includedMessageIds).toContain('msg-also-kept')
    expect(ws.includedMessageIds).not.toContain('msg-deduped')
    expect(ws.droppedMessageIds).toContain('msg-deduped')
    expect(ws.droppedMessageIds).not.toContain('msg-kept')
    expect(ws.dedupedCount).toBe(1)
  })

  it('returns consistent prefixHash when anchor and frozen episodes are unchanged', () => {
    const input = {
      ...BASE_INPUT,
      frozenEpisodes: [makeEpisode()],
      workingSet: [
        { messageId: 'msg-1', role: 'user' as const, content: 'Turn 1', createdAt: 1000 }
      ]
    }

    const result1 = packContext(input)
    const result2 = packContext({
      ...input,
      workingSet: [
        { messageId: 'msg-2', role: 'user' as const, content: 'Different turn', createdAt: 2000 }
      ]
    })

    // Same anchor + same frozen episodes → same prefixHash
    expect(result1.decisions.prefixHash).toBe(result2.decisions.prefixHash)
    expect(result1.decisions.prefixHash).toMatch(/^[0-9a-f]+$/)
  })

  it('returns different prefixHash when frozen episodes change', () => {
    const result1 = packContext({
      ...BASE_INPUT,
      frozenEpisodes: [makeEpisode({ id: 'ep-1', summaryMarkdown: 'Episode A' })]
    })
    const result2 = packContext({
      ...BASE_INPUT,
      frozenEpisodes: [makeEpisode({ id: 'ep-2', summaryMarkdown: 'Episode B' })]
    })

    expect(result1.decisions.prefixHash).not.toBe(result2.decisions.prefixHash)
  })

  it('excludes volatile field context from prefixHash', () => {
    const result1 = packContext({
      ...BASE_INPUT,
      fieldContextMarkdown: 'packetId=one capturedAt=1000',
      frozenEpisodes: [makeEpisode()],
      currentRequest: 'same request'
    })
    const result2 = packContext({
      ...BASE_INPUT,
      fieldContextMarkdown: 'packetId=two capturedAt=9999',
      frozenEpisodes: [makeEpisode()],
      currentRequest: 'same request'
    })

    // Same anchor + same frozen episodes -> same stable prefix despite volatile field changes.
    expect(result1.decisions.prefixHash).toBe(result2.decisions.prefixHash)
    expect(result1.decisions.actualPrefixHash).toBe(result2.decisions.actualPrefixHash)
  })

  it('includes retrieved episodes with reasons in a separate zone', () => {
    const result = packContext({
      anchor: 'system context',
      fieldContextMarkdown: null,
      frozenEpisodes: [],
      retrievedEpisodes: [
        {
          episode: makeEpisode({
            id: 'ret-1',
            title: 'Auth Bug Discussion',
            summaryMarkdown: 'Discussed auth.ts fix'
          }),
          retrievalReason: 'keyword:auth'
        },
        {
          episode: makeEpisode({
            id: 'ret-2',
            title: 'Test Setup',
            summaryMarkdown: 'Set up vitest config'
          }),
          retrievalReason: 'keyword:test'
        }
      ],
      workingSet: [],
      currentRequest: 'what was that auth fix?'
    })

    const allMessages = [...result.providerContextMessages, result.providerPromptMessage]
    const allText = allMessages.map((m) => m.content[0].text).join('\n')
    expect(allText).toContain('<xuanpu-retrieved-episodes>')
    expect(allText).toContain('Auth Bug Discussion')
    expect(allText).toContain('keyword:auth')
    expect(allText).toContain('Test Setup')
    expect(result.decisions.zones.retrievedEpisodes.count).toBe(2)
    expect(result.decisions.zones.retrievedEpisodes.reasons).toEqual([
      'keyword:auth',
      'keyword:test'
    ])
  })

  it('deduplicates working set against retrieved episodes', () => {
    const result = packContext({
      anchor: 'system context',
      fieldContextMarkdown: null,
      frozenEpisodes: [],
      retrievedEpisodes: [
        {
          episode: makeEpisode({
            id: 'ret-1',
            rawRefs: [{ type: 'session_message', id: 'shared-msg', role: 'user' }]
          }),
          retrievalReason: 'keyword:test'
        }
      ],
      workingSet: [
        { messageId: 'shared-msg', role: 'user', content: 'Already in retrieved', createdAt: 1000 },
        { messageId: 'unique-msg', role: 'user', content: 'Not in episode', createdAt: 2000 }
      ],
      currentRequest: 'continue'
    })

    const allMessages = [...result.providerContextMessages, result.providerPromptMessage]
    const allText = allMessages.map((m) => m.content[0].text).join('\n')
    expect(allText).not.toContain('Already in retrieved')
    expect(allText).toContain('Not in episode')
    expect(result.decisions.zones.workingSet.dedupedCount).toBe(1)
  })
})
