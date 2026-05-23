import { describe, expect, it } from 'vitest'

import { buildXuanpuAgentPromptMessages } from '../../src/main/services/xuanpu-agent/context-transform'

function textAt(
  messages: ReturnType<typeof buildXuanpuAgentPromptMessages>['messages'],
  index: number
) {
  return messages[index]?.content.map((part) => part.text).join('')
}

describe('xuanpu-agent context transform', () => {
  it('orders anchor, field context, recent conversation, and current user last', () => {
    const result = buildXuanpuAgentPromptMessages({
      now: 123,
      currentUserText: 'current request',
      fieldContextMarkdown: '## Current Field\n\nstatus',
      frozenEpisodes: [
        {
          id: 'episode-1',
          title: 'Frozen Setup',
          summaryMarkdown: 'The repo uses pnpm and xuanpu-agent stays hidden.',
          tokenEstimate: 20
        }
      ],
      priorMessages: [
        { role: 'user', content: 'previous question', createdAt: '2026-05-24T00:00:00.000Z' },
        { role: 'assistant', content: 'previous answer', createdAt: '2026-05-24T00:00:01.000Z' }
      ]
    })

    expect(result.messages.map((message) => message.role)).toEqual([
      'user',
      'user',
      'user',
      'user',
      'assistant',
      'user'
    ])
    expect(textAt(result.messages, 0)).toContain('<xuanpu-context-anchor>')
    expect(textAt(result.messages, 1)).toContain('## Current Field')
    expect(textAt(result.messages, 2)).toContain('<xuanpu-frozen-episodes>')
    expect(textAt(result.messages, 2)).toContain('episode-1')
    expect(textAt(result.messages, 3)).toBe('previous question')
    expect(textAt(result.messages, 4)).toBe('previous answer')
    expect(textAt(result.messages, 5)).toBe('current request')
    expect(result.decisions).toMatchObject({
      contextTransform: 'minimal-anchor-field-recent-current',
      contextBoundary: 'pi-agent-message-array',
      currentUserMessagePosition: 'last',
      fieldContextInjected: true,
      includedFrozenEpisodeCount: 1,
      droppedFrozenEpisodeCount: 0,
      includedPriorMessageCount: 2,
      droppedPriorMessageCount: 0,
      semanticCompression: 'disabled'
    })
  })

  it('drops old prior messages without summarizing or truncating retained messages', () => {
    const result = buildXuanpuAgentPromptMessages({
      now: 123,
      currentUserText: 'current request',
      maxPriorMessages: 4,
      maxPriorChars: 12,
      priorMessages: [
        { role: 'user', content: 'old one' },
        { role: 'assistant', content: 'old two' },
        { role: 'user', content: 'keep-1' },
        { role: 'assistant', content: 'keep-2' },
        { role: 'user', content: 'keep-3' }
      ]
    })

    const visibleContextTexts = result.messages.map((message) =>
      message.content.map((part) => part.text).join('')
    )
    expect(visibleContextTexts).toContain('keep-2')
    expect(visibleContextTexts).toContain('keep-3')
    expect(visibleContextTexts).not.toContain('old one')
    expect(visibleContextTexts).not.toContain('old two')
    expect(visibleContextTexts).not.toContain('keep-1')
    expect(result.decisions).toMatchObject({
      includedPriorMessageCount: 2,
      droppedPriorMessageCount: 3,
      semanticCompression: 'disabled'
    })
  })
})
