import { describe, expect, it } from 'vitest'

import { packContext } from '../../src/main/services/xuanpu-agent/context/context-packer'
import type { FieldEpisodeBlockRecord } from '../../src/main/field/episode-block-repository'
import type { FieldTurn } from '../../src/main/services/xuanpu-agent/field/provider'

function makeEpisode(summaryMarkdown: string, id = 'ep-1'): FieldEpisodeBlockRecord {
  return {
    id,
    worktreeId: 'w-1',
    sessionId: 's-1',
    createdAt: Date.now(),
    kind: 'turns',
    title: 'Episode',
    summaryMarkdown,
    keyFacts: [],
    constraints: [],
    files: [],
    commands: [],
    failures: [],
    rawRefs: [{ type: 'session_message', id: `ref-${id}`, role: 'user' }],
    tokenEstimate: Math.ceil(summaryMarkdown.length / 3),
    confidence: 'medium',
    metadata: {}
  }
}

function makeTurn(content: string, id: string): FieldTurn {
  return { messageId: id, role: 'user', content, createdAt: Date.now() }
}

describe('Context Packer — soft shrink and budget allocation', () => {
  it('drops episodes when they exceed the frozenEpisodes budget', () => {
    // Create many large episodes
    const episodes = Array.from({ length: 10 }, (_, i) =>
      makeEpisode(`Episode ${i}: ${'x'.repeat(5000)}`, `ep-${i}`)
    )

    const result = packContext({
      anchor: 'anchor',
      fieldContextMarkdown: null,
      frozenEpisodes: episodes,
      workingSet: [],
      currentRequest: 'Hello',
      budgetOverrides: { frozenEpisodes: 3_000 } // Very small budget
    })

    expect(result.decisions.zones.frozenEpisodes.count).toBeLessThan(10)
    expect(result.decisions.zones.frozenEpisodes.dropped).toBeGreaterThan(0)
  })

  it('drops working set turns when they exceed the workingSet budget', () => {
    const turns = Array.from({ length: 20 }, (_, i) =>
      makeTurn(`Turn ${i}: ${'y'.repeat(2000)}`, `msg-${i}`)
    )

    const result = packContext({
      anchor: 'anchor',
      fieldContextMarkdown: null,
      frozenEpisodes: [],
      workingSet: turns,
      currentRequest: 'Hello',
      budgetOverrides: { workingSet: 5_000 } // Very small budget
    })

    expect(result.decisions.zones.workingSet.count).toBeLessThan(20)
  })

  it('keeps most recent working set turns when budget is limited', () => {
    const turns = Array.from({ length: 10 }, (_, i) =>
      makeTurn(`Turn ${i}`, `msg-${i}`)
    )

    const result = packContext({
      anchor: 'anchor',
      fieldContextMarkdown: null,
      frozenEpisodes: [],
      workingSet: turns,
      currentRequest: 'Hello',
      budgetOverrides: { workingSet: 1_000 } // Small budget
    })

    // The last turn should be included (most recent)
    const allMsgs = [...result.providerContextMessages, result.providerPromptMessage]
    const workingSetMsgs = allMsgs.filter(
      (m) => m.role === 'user' && m.content[0].text.startsWith('Turn ')
    )
    if (workingSetMsgs.length > 0) {
      expect(workingSetMsgs[workingSetMsgs.length - 1].content[0].text).toBe('Turn 9')
    }
  })

  it('never compresses current request', () => {
    const longRequest = 'A'.repeat(50_000)

    const result = packContext({
      anchor: 'anchor',
      fieldContextMarkdown: null,
      frozenEpisodes: [],
      workingSet: [],
      currentRequest: longRequest
    })

    const lastMsg = result.providerPromptMessage
    expect(lastMsg.content[0].text).toBe(longRequest)
    expect(lastMsg.content[0].text.length).toBe(50_000)
  })

  it('fill ratio reflects actual budget usage', () => {
    const result = packContext({
      anchor: 'short',
      fieldContextMarkdown: null,
      frozenEpisodes: [],
      workingSet: [],
      currentRequest: 'Hello',
      totalBudgetTokens: 100_000
    })

    expect(result.decisions.fillRatio).toBeGreaterThan(0)
    expect(result.decisions.fillRatio).toBeLessThan(0.1) // Very small content vs large budget
  })

  it('dedup reduces working set count', () => {
    const episode = makeEpisode('Summary of earlier conversation', 'ep-1')
    const turns: FieldTurn[] = [
      { messageId: 'ref-ep-1', role: 'user', content: 'Duplicated turn', createdAt: 1000 },
      { messageId: 'unique-msg', role: 'user', content: 'Unique turn', createdAt: 2000 }
    ]

    const result = packContext({
      anchor: 'anchor',
      fieldContextMarkdown: null,
      frozenEpisodes: [episode],
      workingSet: turns,
      currentRequest: 'Hello'
    })

    expect(result.decisions.zones.workingSet.dedupedCount).toBe(1)
    const allMsgs = [...result.providerContextMessages, result.providerPromptMessage]
    const allText = allMsgs.map((m) => m.content[0].text).join('\n')
    expect(allText).toContain('Unique turn')
    expect(allText).not.toContain('Duplicated turn')
  })

  it('working set turns without messageId are not deduped', () => {
    const episode = makeEpisode('Summary', 'ep-1')
    const turns: FieldTurn[] = [
      { messageId: '', role: 'user', content: 'No-ID turn', createdAt: 1000 },
      { messageId: 'unique', role: 'user', content: 'Has ID', createdAt: 2000 }
    ]

    const result = packContext({
      anchor: 'anchor',
      fieldContextMarkdown: null,
      frozenEpisodes: [episode],
      workingSet: turns,
      currentRequest: 'Hello'
    })

    // Both should be included (empty messageId means no dedup)
    expect(result.decisions.zones.workingSet.dedupedCount).toBe(0)
  })

  it('reduced budgets produce lower fillRatio (soft shrink effect)', () => {
    // Use large content to actually hit budget limits
    const episodes = Array.from({ length: 5 }, (_, i) =>
      makeEpisode(`Episode ${i}: ${'z'.repeat(8000)}`, `ep-${i}`)
    )
    const turns = Array.from({ length: 20 }, (_, i) =>
      makeTurn(`Turn ${i}: ${'w'.repeat(4000)}`, `msg-${i}`)
    )

    const baseResult = packContext({
      anchor: 'anchor',
      fieldContextMarkdown: 'field context',
      frozenEpisodes: episodes,
      workingSet: turns,
      currentRequest: 'Hello'
    })

    const shrunkResult = packContext({
      anchor: 'anchor',
      fieldContextMarkdown: 'field context',
      frozenEpisodes: episodes,
      workingSet: turns,
      currentRequest: 'Hello',
      budgetOverrides: {
        workingSet: 15_000,
        frozenEpisodes: 6_000
      }
    })

    // Reduced budgets should force content drops → lower total tokens
    expect(shrunkResult.decisions.totalTokens).toBeLessThan(baseResult.decisions.totalTokens)
    expect(shrunkResult.decisions.zones.workingSet.count).toBeLessThan(
      baseResult.decisions.zones.workingSet.count
    )
  })
})
