import type { AppendOnlyLog } from './harness/build-messages'
import type { XfpFieldPacket } from './xfp/types'
import type { FieldTurn } from './field/provider'
import type { FieldEpisodeBlockRecord } from '../../field/episode-block-repository'
import { packContext } from './context/context-packer'

export interface XuanpuAgentContextTurn {
  role: 'user' | 'assistant'
  content: string
  createdAt?: string | number | null
}

export interface XuanpuAgentFrozenEpisode {
  id: string
  title?: string | null
  summaryMarkdown: string
  tokenEstimate?: number
  createdAt?: string | number | null
}

export interface XuanpuPiPromptTextPart {
  type: 'text'
  text: string
}

export interface XuanpuPiPromptImagePart {
  type: 'image'
  data: string
  mimeType: string
}

export type XuanpuPiPromptPart = XuanpuPiPromptTextPart | XuanpuPiPromptImagePart

export interface XuanpuPiPromptMessage {
  role: 'user' | 'assistant'
  content: XuanpuPiPromptPart[]
  timestamp: number
}

export interface XuanpuAgentContextTransformInput {
  currentUserText: string
  harnessContext?: {
    packet: XfpFieldPacket
    log: AppendOnlyLog
  }
  fieldContextMarkdown?: string | null
  frozenEpisodes?: XuanpuAgentFrozenEpisode[]
  retrievedEpisodes?: XuanpuAgentFrozenEpisode[]
  priorMessages?: XuanpuAgentContextTurn[]
  /** Full episode records for context packer (M7). */
  episodeRecords?: FieldEpisodeBlockRecord[]
  /** Working set turns with messageId for dedup (M7). */
  workingSet?: FieldTurn[]
  maxFrozenEpisodes?: number
  maxFrozenEpisodeChars?: number
  maxPriorMessages?: number
  maxPriorChars?: number
  now?: number
}

export interface XuanpuAgentContextTransformResult {
  providerContextMessages: XuanpuPiPromptMessage[]
  providerPromptMessage: XuanpuPiPromptMessage
  decisions: Record<string, unknown>
}

const DEFAULT_MAX_PRIOR_MESSAGES = 6

const CONTEXT_ANCHOR_TEXT = [
  '<xuanpu-context-anchor>',
  'The following messages are assembled by Xuanpu for this hidden experimental runtime.',
  'They are context for the model, not visible chat transcript text.',
  'Use the final user message as the active request.',
  'Do not claim shell, file editing, or project tools are available.',
  '</xuanpu-context-anchor>'
].join('\n')

export function buildXuanpuAgentPromptMessages(
  input: XuanpuAgentContextTransformInput
): XuanpuAgentContextTransformResult {
  const now = input.now ?? Date.now()

  // Harness path — XFP packet as anchor, log as working set, via Context Packer
  if (input.harnessContext) {
    const { packet, log } = input.harnessContext
    const packetAnchor = [
      `<xuanpu-xfp-packet version="${packet.version}" packet-id="${packet.identity.packetId}">`,
      'The following JSON is a structured Xuanpu Field Protocol packet.',
      'Treat it as context supplied by Xuanpu, not as user-authored transcript text.',
      JSON.stringify(packet, null, 2),
      '</xuanpu-xfp-packet>'
    ].join('\n')

    // Convert log entries to FieldTurn[] for packer working set
    const workingSet: FieldTurn[] = log.entries.map((entry) => ({
      messageId: entry.id,
      role: entry.message.role as 'user' | 'assistant',
      content: entry.message.content
        .map((p) => (p.type === 'text' ? p.text : `[image: ${p.mimeType}]`))
        .join(''),
      createdAt: entry.message.timestamp
    }))

    const result = packContext({
      anchor: packetAnchor,
      fieldContextMarkdown: null,
      frozenEpisodes: input.episodeRecords ?? [],
      workingSet,
      currentRequest: input.currentUserText,
      now
    })

    return {
      providerContextMessages: result.providerContextMessages,
      providerPromptMessage: result.providerPromptMessage,
      decisions: {
        contextTransform: 'xfp-harness-context-packer',
        xfpPacketId: packet.identity.packetId,
        promptMessageCount: result.providerContextMessages.length + 1,
        ...result.decisions
      }
    }
  }

  // M7 Context Packer path — zone-based assembly with dedup
  if (input.episodeRecords && input.workingSet) {
    const result = packContext({
      anchor: CONTEXT_ANCHOR_TEXT,
      fieldContextMarkdown: input.fieldContextMarkdown ?? null,
      frozenEpisodes: input.episodeRecords,
      workingSet: input.workingSet,
      currentRequest: input.currentUserText,
      now
    })

    return {
      providerContextMessages: result.providerContextMessages,
      providerPromptMessage: result.providerPromptMessage,
      decisions: {
        contextTransform: 'm7-context-packer',
        ...result.decisions
      }
    }
  }

  // No legacy fallback — xuanpu-agent always uses the context packer.
  // If callers pass priorMessages without episodeRecords/workingSet,
  // wrap them minimally.
  const messages: XuanpuPiPromptMessage[] = [createUserMessage(CONTEXT_ANCHOR_TEXT, now)]
  if (input.priorMessages) {
    for (const msg of input.priorMessages.slice(-DEFAULT_MAX_PRIOR_MESSAGES)) {
      messages.push(createConversationMessage(msg, now))
    }
  }
  messages.push(createUserMessage(input.currentUserText, now))

  return {
    providerContextMessages: messages.slice(0, -1),
    providerPromptMessage: messages[messages.length - 1],
    decisions: {
      contextTransform: 'minimal-anchor',
      promptMessageCount: messages.length
    }
  }
}

function createConversationMessage(
  message: XuanpuAgentContextTurn,
  fallbackTimestamp: number
): XuanpuPiPromptMessage {
  return {
    role: message.role,
    content: [{ type: 'text', text: message.content }],
    timestamp: parseTimestamp(message.createdAt) ?? fallbackTimestamp
  }
}

function createUserMessage(text: string, timestamp: number): XuanpuPiPromptMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp
  }
}

function parseTimestamp(value: string | number | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
