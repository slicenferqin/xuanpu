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

export interface XuanpuPiPromptMessage {
  role: 'user' | 'assistant'
  content: XuanpuPiPromptTextPart[]
  timestamp: number
}

export interface XuanpuAgentContextTransformInput {
  currentUserText: string
  fieldContextMarkdown?: string | null
  frozenEpisodes?: XuanpuAgentFrozenEpisode[]
  priorMessages?: XuanpuAgentContextTurn[]
  maxFrozenEpisodes?: number
  maxFrozenEpisodeChars?: number
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
const DEFAULT_MAX_FROZEN_EPISODES = 3
const DEFAULT_MAX_FROZEN_EPISODE_CHARS = 6_000

export function buildXuanpuAgentPromptMessages(
  input: XuanpuAgentContextTransformInput
): XuanpuAgentContextTransformResult {
  const now = input.now ?? Date.now()
  const maxPriorMessages = input.maxPriorMessages ?? DEFAULT_MAX_PRIOR_MESSAGES
  const maxPriorChars = input.maxPriorChars ?? DEFAULT_MAX_PRIOR_CHARS
  const maxFrozenEpisodes = input.maxFrozenEpisodes ?? DEFAULT_MAX_FROZEN_EPISODES
  const maxFrozenEpisodeChars = input.maxFrozenEpisodeChars ?? DEFAULT_MAX_FROZEN_EPISODE_CHARS
  const fieldContextMarkdown = input.fieldContextMarkdown?.trim() || null
  const frozenEpisodes = selectFrozenEpisodes(input.frozenEpisodes ?? [], {
    maxFrozenEpisodes,
    maxFrozenEpisodeChars
  })
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

  if (frozenEpisodes.included.length > 0) {
    messages.push(
      createUserMessage(
        [
          '<xuanpu-frozen-episodes>',
          ...frozenEpisodes.included.map(formatFrozenEpisode),
          '</xuanpu-frozen-episodes>'
        ].join('\n\n'),
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
      includedFrozenEpisodeCount: frozenEpisodes.included.length,
      droppedFrozenEpisodeCount: frozenEpisodes.dropped,
      maxFrozenEpisodes,
      maxFrozenEpisodeChars,
      includedPriorMessageCount: priorMessages.included.length,
      droppedPriorMessageCount: priorMessages.dropped,
      maxPriorMessages,
      maxPriorChars,
      promptMessageCount: messages.length
    }
  }
}

function selectFrozenEpisodes(
  episodes: XuanpuAgentFrozenEpisode[],
  options: { maxFrozenEpisodes: number; maxFrozenEpisodeChars: number }
): { included: XuanpuAgentFrozenEpisode[]; dropped: number } {
  const candidates = episodes
    .filter((episode) => episode.summaryMarkdown.trim().length > 0)
    .slice(0, options.maxFrozenEpisodes)

  const included: XuanpuAgentFrozenEpisode[] = []
  let charCount = 0

  for (const episode of candidates) {
    const nextSize = episode.summaryMarkdown.length
    if (included.length > 0 && charCount + nextSize > options.maxFrozenEpisodeChars) break
    if (included.length === 0 || charCount + nextSize <= options.maxFrozenEpisodeChars) {
      included.push(episode)
      charCount += nextSize
    }
  }

  return {
    included,
    dropped: episodes.length - included.length
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

function formatFrozenEpisode(episode: XuanpuAgentFrozenEpisode): string {
  return [
    `<episode id="${episode.id}">`,
    episode.title ? `### ${episode.title}` : null,
    episode.summaryMarkdown.trim(),
    '</episode>'
  ]
    .filter(Boolean)
    .join('\n')
}

function parseTimestamp(value: string | number | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || !value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
