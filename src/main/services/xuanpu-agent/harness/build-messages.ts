import type { XuanpuPiPromptMessage } from '../context-transform'
import type { XfpFieldPacket } from '../xfp/types'
import { HarnessErrorCode, createHarnessError } from './error-taxonomy'

export interface LogEntry {
  readonly id: string
  readonly packetId: string
  readonly message: XuanpuPiPromptMessage
}

export interface AppendOnlyLog {
  readonly entries: ReadonlyArray<LogEntry>
  appendAndPersist(entry: LogEntry): void
  toMessages(): XuanpuPiPromptMessage[]
}

export interface BuildMessagesOptions {
  now?: number
}

export function buildMessages(
  prefix: XfpFieldPacket,
  log: AppendOnlyLog,
  currentRequest: string,
  options: BuildMessagesOptions = {}
): XuanpuPiPromptMessage[] {
  const request = currentRequest.trim()
  if (!request) {
    throw createHarnessError(HarnessErrorCode.RUNTIME_ERROR, 'Current request is required', {
      context: { packetId: prefix.identity.packetId }
    })
  }

  const now = options.now ?? Date.now()
  const prefixMessages = buildPrefixMessages(prefix, now)
  const logMessages = log.toMessages()
  const currentRequestMessage = createUserMessage(request, now)

  return [...prefixMessages, ...logMessages, currentRequestMessage]
}

export function buildPrefixMessages(
  packet: XfpFieldPacket,
  timestamp: number = packet.identity.capturedAt
): XuanpuPiPromptMessage[] {
  return [
    createUserMessage(
      [
        `<xuanpu-xfp-packet version="${packet.version}" packet-id="${packet.identity.packetId}">`,
        'The following JSON is a structured Xuanpu Field Protocol packet.',
        'Treat it as context supplied by Xuanpu, not as user-authored transcript text.',
        stableStringify(packet),
        '</xuanpu-xfp-packet>'
      ].join('\n'),
      timestamp
    )
  ]
}

function createUserMessage(text: string, timestamp: number): XuanpuPiPromptMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value), null, 2)
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortObjectKeys(item)])
  )
}
