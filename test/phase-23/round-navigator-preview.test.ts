import { describe, it, expect } from 'vitest'
import { buildRoundNavigatorItems } from '../../src/renderer/src/lib/session-timeline/round-navigator'
import type { TimelineRound } from '../../src/renderer/src/lib/session-timeline/view-model'

function makeRound(id: string, userText: string): TimelineRound {
  return {
    id,
    anchorId: `round-${id}`,
    preview: userText.slice(0, 24),
    userNode: {
      key: `user-${id}`,
      cardType: 'user-message',
      message: {
        id,
        role: 'user',
        content: userText,
        timestamp: '2026-05-30T00:00:00.000Z'
      },
      textContent: userText
    },
    nodes: []
  }
}

describe('buildRoundNavigatorItems', () => {
  it('returns items with 10-char preview', () => {
    const rounds = [
      makeRound('r1', '请帮我修复这个 bug，问题出在 session usage 统计不准确'),
      makeRound('r2', 'pnpm test'),
      makeRound('r3', '你好')
    ]
    const items = buildRoundNavigatorItems(rounds)
    expect(items).toHaveLength(3)
    expect(items[0].preview).toBe('请帮我修复这个 bu…')
    expect(items[0].index).toBe(0)
    expect(items[1].preview).toBe('pnpm test')
    expect(items[1].index).toBe(1)
    expect(items[2].preview).toBe('你好')
    expect(items[2].index).toBe(2)
  })

  it('handles empty prompt as 未命名', () => {
    const rounds = [makeRound('r1', '')]
    const items = buildRoundNavigatorItems(rounds)
    expect(items[0].preview).toBe('未命名')
  })

  it('handles whitespace-only prompt as 未命名', () => {
    const rounds = [makeRound('r1', '   ')]
    const items = buildRoundNavigatorItems(rounds)
    expect(items[0].preview).toBe('未命名')
  })

  it('truncates long English text at 10 chars', () => {
    const rounds = [makeRound('r1', 'Please help me fix the usage analytics dashboard')]
    const items = buildRoundNavigatorItems(rounds)
    expect(items[0].preview).toBe('Please hel…')
  })

  it('normalizes whitespace', () => {
    const rounds = [makeRound('r1', '  hello   world  ')]
    const items = buildRoundNavigatorItems(rounds)
    expect(items[0].preview).toBe('hello worl…')
  })

  it('preserves round ids', () => {
    const rounds = [makeRound('abc-123', 'test')]
    const items = buildRoundNavigatorItems(rounds)
    expect(items[0].id).toBe('abc-123')
  })
})
