export interface XuanpuAgentContextTurn {
  role: 'user' | 'assistant'
  content: string
  createdAt?: string | number | null
}

export interface XuanpuPiPromptTextPart {
  type: 'text'
  text: string
}

export interface XuanpuPiPromptMessage {
  role: 'user' | 'assistant'
  content: XuanpuPiPromptTextPart[]
  timestamp: number
}

export interface XuanpuAgentContextTransformInput {
  currentUserText: string
  fieldContextMarkdown?: string | null
  priorMessages?: XuanpuAgentContextTurn[]
  maxPriorMessages?: number
  maxPriorChars?: number
  now?: number
}

export interface XuanpuAgentContextTransformResult {
  messages: XuanpuPiPromptMessage[]
  decisions: Record<string, unknown>
}

const DEFAULT_MAX_PRIOR_MESSAGES = 6
const DEFAULT_MAX_PRIOR_CHARS = 12_000

export function buildXuanpuAgentPromptMessages(
  input: XuanpuAgentContextTransformInput
): XuanpuAgentContextTransformResult {
  const now = input.now ?? Date.now()
  const maxPriorMessages = input.maxPriorMessages ?? DEFAULT_MAX_PRIOR_MESSAGES
  const maxPriorChars = input.maxPriorChars ?? DEFAULT_MAX_PRIOR_CHARS
  const fieldContextMarkdown = input.fieldContextMarkdown?.trim() || null
  const priorMessages = selectPriorMessages(input.priorMessages ?? [], {
    maxPriorMessages,
    maxPriorChars
  })

  const messages: XuanpuPiPromptMessage[] = [
    createUserMessage(
      [
        '<xuanpu-context-anchor>',
        'The following messages are assembled by Xuanpu for this hidden experimental runtime.',
        'They are context for the model, not visible chat transcript text.',
        'Use the final user message as the active request.',
        'Do not claim shell, file editing, or project tools are available.',
        '</xuanpu-context-anchor>'
      ].join('\n'),
      now
    )
  ]

  if (fieldContextMarkdown) {
    messages.push(
      createUserMessage(
        [
          '<xuanpu-current-field-context>',
          fieldContextMarkdown,
          '</xuanpu-current-field-context>'
        ].join('\n'),
        now
      )
    )
  }

  messages.push(...priorMessages.included.map((message) => createConversationMessage(message, now)))
  messages.push(createUserMessage(input.currentUserText, now))

  return {
    messages,
    decisions: {
      contextTransform: 'minimal-anchor-field-recent-current',
      contextBoundary: 'pi-agent-message-array',
      visibleTranscriptPolicy: 'persist-user-authored-message-only',
      semanticCompression: 'disabled',
      currentUserMessagePosition: 'last',
      fieldContextInjected: Boolean(fieldContextMarkdown),
      includedPriorMessageCount: priorMessages.included.length,
      droppedPriorMessageCount: priorMessages.dropped,
      maxPriorMessages,
      maxPriorChars,
      promptMessageCount: messages.length
    }
  }
}

function selectPriorMessages(
  messages: XuanpuAgentContextTurn[],
  options: { maxPriorMessages: number; maxPriorChars: number }
): { included: XuanpuAgentContextTurn[]; dropped: number } {
  const candidates = messages
    .filter((message) => {
      const content = message.content.trim()
      return content.length > 0 && (message.role === 'user' || message.role === 'assistant')
    })
    .slice(-options.maxPriorMessages)

  const includedReversed: XuanpuAgentContextTurn[] = []
  let charCount = 0

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index]
    const nextSize = message.content.length
    if (includedReversed.length > 0 && charCount + nextSize > options.maxPriorChars) {
      break
    }
    if (includedReversed.length === 0 || charCount + nextSize <= options.maxPriorChars) {
      includedReversed.push(message)
      charCount += nextSize
    }
  }

  const included = includedReversed.reverse()
  return {
    included,
    dropped: messages.length - included.length
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
