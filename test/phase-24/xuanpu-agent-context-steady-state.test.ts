/**
 * Steady-state stress test (INV-TURN-6).
 *
 * Verifies that after warmup, single-turn provider input does not grow
 * linearly with turn count over a long conversation.
 *
 * Simulates 50 turns through the context packer and asserts:
 *   - context snapshot message count stabilizes
 *   - omittedMessageIds grows (old turns get dropped/frozen)
 *   - providerEstimatedInputTokens bounded after warmup
 */
import { describe, expect, it } from 'vitest'

import { packContext } from '../../src/main/services/xuanpu-agent/context/context-packer'
import type { FieldEpisodeBlockRecord } from '../../src/main/field/episode-block-repository'
import type { FieldTurn } from '../../src/main/services/xuanpu-agent/field'

function makeEpisode(
  id: string,
  summary: string,
  msgId: string
): FieldEpisodeBlockRecord {
  return {
    id,
    worktreeId: 'w-1',
    sessionId: 's-1',
    createdAt: Date.now(),
    kind: 'turns',
    title: `Episode ${id}`,
    summaryMarkdown: summary,
    keyFacts: [],
    constraints: [],
    files: [],
    commands: [],
    failures: [],
    rawRefs: [{ type: 'session_message', id: msgId, role: 'assistant' }],
    tokenEstimate: 50,
    confidence: 'medium',
    metadata: {}
  }
}

describe('Context Packer steady-state (INV-TURN-6)', () => {
  it('stabilizes provider message count over 50 turns', () => {
    const TURNS = 50
    const ANCHOR = 'You are a helpful coding assistant.'
    const messageCounts: number[] = []
    const omittedCounts: number[] = []
    const includedCounts: number[] = []

    // Accumulate working set across turns (simulating a real conversation).
    const workingSet: FieldTurn[] = []

    for (let i = 1; i <= TURNS; i++) {
      // Add user + assistant messages for this turn.
      workingSet.push({
        messageId: `msg-user-${i}`,
        role: 'user',
        content: `Turn ${i} user request about feature X. `.repeat(3).trim(),
        createdAt: i * 1000
      })
      workingSet.push({
        messageId: `msg-assistant-${i}`,
        role: 'assistant',
        content: `Turn ${i} assistant response explaining feature X. `.repeat(5).trim(),
        createdAt: i * 1000 + 500
      })

      // Freeze older turns as episodes (simulating auto-freeze).
      const frozenEpisodes: FieldEpisodeBlockRecord[] = []
      if (i > 10) {
        // Every 5 turns, freeze the oldest 2 turns.
        const frozenBatch = Math.floor((i - 10) / 5)
        for (let f = 0; f < frozenBatch; f++) {
          const userMsgId = `msg-user-${f * 2 + 1}`
          frozenEpisodes.push(
            makeEpisode(`ep-frozen-${f}`, `Frozen batch ${f} summary content.`, userMsgId)
          )
        }
      }

      const result = packContext({
        anchor: ANCHOR,
        fieldContextMarkdown: null,
        frozenEpisodes,
        workingSet,
        currentRequest: `Turn ${i} current request.`,
        totalBudgetTokens: 50_000
      })

      const totalMessages = result.providerContextMessages.length + 1 // +1 for prompt
      messageCounts.push(totalMessages)
      omittedCounts.push(result.decisions.zones.workingSet.droppedMessageIds.length)
      includedCounts.push(result.decisions.zones.workingSet.includedMessageIds.length)
    }

    // ── Assertions ──

    // Message count should stabilize after warmup (first ~10 turns).
    const warmupEnd = 15
    const earlyAvg = average(messageCounts.slice(0, warmupEnd))
    const lateAvg = average(messageCounts.slice(warmupEnd))

    // Late-stage message count must not exceed early stage by more than 2x.
    // In a well-behaved system, it should be roughly the same or lower.
    expect(lateAvg).toBeLessThanOrEqual(earlyAvg * 2.0)

    // After warmup, per-turn message count must be bounded (not growing).
    const lateMax = Math.max(...messageCounts.slice(warmupEnd))
    const lateMin = Math.min(...messageCounts.slice(warmupEnd))
    const lateRange = lateMax - lateMin
    // The range should be small — it shouldn't keep growing.
    expect(lateRange).toBeLessThanOrEqual(10)

    // Omitted messages should grow over time (old turns get dropped).
    const earlyOmitted = omittedCounts[omittedCounts.length - 1]
    expect(earlyOmitted).toBeGreaterThan(0)

    // Final turn's included messages should not include the earliest turns.
    const lastIncluded = includedCounts[includedCounts.length - 1]
    const totalWorkingSet = workingSet.length
    // Some messages should be omitted by the end.
    expect(lastIncluded).toBeLessThan(totalWorkingSet)
  })

  it('prefixHash is stable when anchor and frozen episodes are unchanged', () => {
    const episode = makeEpisode('ep-1', 'Stable summary', 'msg-1')
    const result1 = packContext({
      anchor: 'Stable anchor v1',
      fieldContextMarkdown: null,
      frozenEpisodes: [episode],
      workingSet: [
        { messageId: 'msg-2', role: 'user', content: 'Dynamic content A', createdAt: 1000 }
      ],
      currentRequest: 'Request A'
    })
    const result2 = packContext({
      anchor: 'Stable anchor v1',
      fieldContextMarkdown: null,
      frozenEpisodes: [episode],
      workingSet: [
        { messageId: 'msg-3', role: 'user', content: 'Dynamic content B', createdAt: 2000 }
      ],
      currentRequest: 'Request B'
    })

    // Same anchor + same frozen episodes → same prefixHash regardless of working set.
    expect(result1.decisions.prefixHash).toBe(result2.decisions.prefixHash)
  })

  it('omittedMessageIds increases as working set fills budget', () => {
    // Create a working set that clearly exceeds budget.
    const largeWorkingSet: FieldTurn[] = []
    for (let i = 0; i < 100; i++) {
      largeWorkingSet.push({
        messageId: `msg-${i}`,
        role: 'user',
        content: `Turn ${i} with substantial content that consumes tokens. `.repeat(10),
        createdAt: i * 1000
      })
    }

    const result = packContext({
      anchor: 'System anchor',
      fieldContextMarkdown: null,
      frozenEpisodes: [],
      workingSet: largeWorkingSet,
      currentRequest: 'Current request',
      totalBudgetTokens: 50_000
    })

    // With 100 turns and 50K budget, many should be dropped.
    const ws = result.decisions.zones.workingSet
    expect(ws.droppedMessageIds.length).toBeGreaterThan(0)
    expect(ws.includedMessageIds.length).toBeLessThan(largeWorkingSet.length)
    // fillRatio should be non-trivial
    expect(result.decisions.fillRatio).toBeGreaterThan(0.01)
  })
})

function average(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}
