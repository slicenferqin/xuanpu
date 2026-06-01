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
  messages: ReturnType<typeof buildXuanpuAgentPromptMessages>['providerContextMessages'],
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

    const allMessages = [...result.providerContextMessages, result.providerPromptMessage]
    expect(allMessages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(textAt(result.providerContextMessages, 0)).toContain('<xuanpu-xfp-packet version="1"')
    expect(textAt(result.providerContextMessages, 0)).toContain(packet.identity.packetId)
    expect(textAt(result.providerContextMessages, 0)).not.toContain('legacy field context should not be used')
    expect(textAt(result.providerContextMessages, 1)).toBe('prior harness answer')
    expect(result.providerPromptMessage.content[0].text).toBe('current harness request')
    expect(result.decisions).toMatchObject({
      contextTransform: 'xfp-harness-context-packer',
      xfpPacketId: packet.identity.packetId,
      promptMessageCount: 3
    })
  })

  it('orders anchor, prior messages, and current user last in minimal-anchor fallback', () => {
    const result = buildXuanpuAgentPromptMessages({
      now: 123,
      currentUserText: 'current request',
      priorMessages: [
        { role: 'user', content: 'previous question', createdAt: '2026-05-24T00:00:00.000Z' },
        { role: 'assistant', content: 'previous answer', createdAt: '2026-05-24T00:00:01.000Z' }
      ]
    })

    const allMessages = [...result.providerContextMessages, result.providerPromptMessage]
    expect(allMessages.map((message) => message.role)).toEqual([
      'user',
      'user',
      'assistant',
      'user'
    ])
    expect(textAt(result.providerContextMessages, 0)).toContain('<xuanpu-context-anchor>')
    expect(textAt(result.providerContextMessages, 1)).toBe('previous question')
    expect(textAt(result.providerContextMessages, 2)).toBe('previous answer')
    expect(result.providerPromptMessage.content[0].text).toBe('current request')
    expect(result.decisions).toMatchObject({
      contextTransform: 'minimal-anchor'
    })
  })

  it('includes prior messages up to DEFAULT_MAX_PRIOR_MESSAGES in minimal-anchor fallback', () => {
    const result = buildXuanpuAgentPromptMessages({
      now: 123,
      currentUserText: 'current request',
      priorMessages: [
        { role: 'user', content: 'old one' },
        { role: 'assistant', content: 'old two' },
        { role: 'user', content: 'keep-1' },
        { role: 'assistant', content: 'keep-2' },
        { role: 'user', content: 'keep-3' }
      ]
    })

    const allMessages = [...result.providerContextMessages, result.providerPromptMessage]
    const visibleContextTexts = allMessages.map((message) =>
      message.content.map((part) => part.text).join('')
    )
    // Minimal-anchor path includes DEFAULT_MAX_PRIOR_MESSAGES (6) most recent.
    // With 5 prior messages, all are included.
    expect(visibleContextTexts).toContain('old one')
    expect(visibleContextTexts).toContain('keep-3')
    expect(result.decisions).toMatchObject({
      contextTransform: 'minimal-anchor'
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
