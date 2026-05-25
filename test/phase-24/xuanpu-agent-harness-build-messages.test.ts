import type { XuanpuPiPromptMessage } from '../../src/main/services/xuanpu-agent/context-transform'
import {
  buildMessages,
  buildPrefixMessages,
  type AppendOnlyLog,
  type LogEntry
} from '../../src/main/services/xuanpu-agent/harness/build-messages'
import {
  HarnessErrorCode,
  isHarnessError
} from '../../src/main/services/xuanpu-agent/harness/error-taxonomy'
import { fullXfpPacketExample } from '../../src/main/services/xuanpu-agent/xfp/fixtures'

describe('xuanpu-agent harness buildMessages', () => {
  it('returns prefix, append-only log, and current request in cache-safe order', () => {
    const packet = fullXfpPacketExample()
    const log = new MemoryAppendOnlyLog([
      createLogEntry('entry-1', packet.identity.packetId, createMessage('user', 'prior user', 100)),
      createLogEntry(
        'entry-2',
        packet.identity.packetId,
        createMessage('assistant', 'prior assistant', 101)
      )
    ])

    const messages = buildMessages(packet, log, ' current request ', { now: 200 })

    expect(messages.map((message) => message.role)).toEqual(['user', 'user', 'assistant', 'user'])
    expect(textAt(messages, 0)).toContain('<xuanpu-xfp-packet version="1"')
    expect(textAt(messages, 0)).toContain(packet.identity.packetId)
    expect(textAt(messages, 0)).toContain('"currentGoal"')
    expect(textAt(messages, 1)).toBe('prior user')
    expect(textAt(messages, 2)).toBe('prior assistant')
    expect(textAt(messages, 3)).toBe('current request')
    expect(messages[0].timestamp).toBe(200)
    expect(messages[3].timestamp).toBe(200)
  })

  it('builds a single structured XFP prefix message from a packet', () => {
    const packet = fullXfpPacketExample()
    const [prefix] = buildPrefixMessages(packet)

    expect(prefix.role).toBe('user')
    expect(prefix.timestamp).toBe(packet.identity.capturedAt)
    expect(textAt([prefix], 0)).toContain('structured Xuanpu Field Protocol packet')
    expect(textAt([prefix], 0)).toContain('"packetId": "550e8400-e29b-41d4-a716-446655440000"')
    expect(textAt([prefix], 0)).toContain('</xuanpu-xfp-packet>')
  })

  it('does not mutate or persist append-only log entries while building messages', () => {
    const packet = fullXfpPacketExample()
    const entry = createLogEntry(
      'entry-1',
      packet.identity.packetId,
      createMessage('assistant', 'stable log message', 100)
    )
    const log = new MemoryAppendOnlyLog([entry])

    const messages = buildMessages(packet, log, 'current request', { now: 200 })

    expect(log.entries).toEqual([entry])
    expect(log.appendedEntries).toEqual([])
    expect(messages[1]).toBe(entry.message)
  })

  it('rejects an empty current request with HarnessError metadata', () => {
    const packet = fullXfpPacketExample()
    const log = new MemoryAppendOnlyLog()

    try {
      buildMessages(packet, log, '   ')
    } catch (error) {
      expect(isHarnessError(error)).toBe(true)
      if (isHarnessError(error)) {
        expect(error.code).toBe(HarnessErrorCode.RUNTIME_ERROR)
        expect(error.context).toEqual({ packetId: packet.identity.packetId })
      }
      return
    }

    throw new Error('Expected buildMessages to reject empty current request')
  })
})

class MemoryAppendOnlyLog implements AppendOnlyLog {
  readonly entries: LogEntry[]
  readonly appendedEntries: LogEntry[] = []

  constructor(entries: LogEntry[] = []) {
    this.entries = entries
  }

  appendAndPersist(entry: LogEntry): void {
    this.entries.push(entry)
    this.appendedEntries.push(entry)
  }

  toMessages(): XuanpuPiPromptMessage[] {
    return this.entries.map((entry) => entry.message)
  }
}

function createLogEntry(id: string, packetId: string, message: XuanpuPiPromptMessage): LogEntry {
  return { id, packetId, message }
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

function textAt(messages: XuanpuPiPromptMessage[], index: number): string {
  return messages[index]?.content.map((part) => part.text).join('') ?? ''
}
