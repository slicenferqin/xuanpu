import { describe, expect, it } from 'vitest'

import {
  buildXuanpuAgentPromptMessages,
  type XuanpuPiPromptMessage
} from '../../src/main/services/xuanpu-agent/context-transform'
import type {
  AppendOnlyLog,
  LogEntry
} from '../../src/main/services/xuanpu-agent/harness/build-messages'
import { fullXfpPacketExample } from '../../src/main/services/xuanpu-agent/xfp/fixtures'

function textAt(
  messages: ReturnType<typeof buildXuanpuAgentPromptMessages>['messages'],
  index: number
) {
  return messages[index]?.content.map((part) => part.text).join('')
}

describe('xuanpu-agent context transform', () => {
  it('uses the XFP harness message builder when harness context is provided', () => {
    const packet = fullXfpPacketExample()
    const log = new MemoryAppendOnlyLog([
      {
        id: 'entry-1',
        packetId: packet.identity.packetId,
        message: createMessage('assistant', 'prior harness answer', 122)
      }
    ])

    const result = buildXuanpuAgentPromptMessages({
      now: 123,
      currentUserText: 'current harness request',
      fieldContextMarkdown: 'legacy field context should not be used',
      priorMessages: [{ role: 'user', content: 'legacy prior should not be used' }],
      harnessContext: { packet, log }
    })

    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(textAt(result.messages, 0)).toContain('<xuanpu-xfp-packet version="1"')
    expect(textAt(result.messages, 0)).toContain(packet.identity.packetId)
    expect(textAt(result.messages, 0)).not.toContain('legacy field context should not be used')
    expect(textAt(result.messages, 1)).toBe('prior harness answer')
    expect(textAt(result.messages, 2)).toBe('current harness request')
    expect(result.decisions).toMatchObject({
      contextTransform: 'xfp-harness-context-packer',
      contextBoundary: 'pi-agent-message-array',
      currentUserMessagePosition: 'last',
      xfpPacketId: packet.identity.packetId,
      promptMessageCount: 3
    })
  })

  it('orders anchor, field context, recent conversation, and current user last', () => {
    const result = buildXuanpuAgentPromptMessages({
      now: 123,
      currentUserText: 'current request',
      fieldContextMarkdown: '## Current Field\n\nstatus',
      retrievedEpisodes: [
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
    expect(textAt(result.messages, 2)).toContain('<xuanpu-retrieved-episodes>')
    expect(textAt(result.messages, 2)).toContain('episode-1')
    expect(textAt(result.messages, 3)).toBe('previous question')
    expect(textAt(result.messages, 4)).toBe('previous answer')
    expect(textAt(result.messages, 5)).toBe('current request')
    expect(result.decisions).toMatchObject({
      contextTransform: 'legacy-minimal-anchor',
      contextBoundary: 'pi-agent-message-array',
      currentUserMessagePosition: 'last',
      fieldContextInjected: true,
      episodeContextKind: 'retrieved_episodes',
      includedRetrievedEpisodeCount: 1,
      droppedRetrievedEpisodeCount: 0,
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

class MemoryAppendOnlyLog implements AppendOnlyLog {
  readonly entries: LogEntry[]

  constructor(entries: LogEntry[]) {
    this.entries = entries
  }

  appendAndPersist(entry: LogEntry): void {
    this.entries.push(entry)
  }

  toMessages(): XuanpuPiPromptMessage[] {
    return this.entries.map((entry) => entry.message)
  }
}

function createMessage(
  role: XuanpuPiPromptMessage['role'],
  text: string,
  timestamp: number
): XuanpuPiPromptMessage {
  return {
    role,
    content: [{ type: 'text', text }],
    timestamp
  }
}
