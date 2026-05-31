import type { FieldEpisodeBlockRecord } from '../../field/episode-block-repository'

export interface XuanpuAgentFreezeMessage {
  id: string | null
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt?: string | number | null
}

export interface XuanpuAgentFreezableMessage extends XuanpuAgentFreezeMessage {
  id: string
  role: 'user' | 'assistant'
}

export interface XuanpuAgentEpisodeFreezeOptions {
  keepRecentMessages?: number
  minFreezeMessages?: number
}

export const DEFAULT_KEEP_RECENT_MESSAGES = 6
export const DEFAULT_MIN_FREEZE_MESSAGES = 4

export function selectMessagesForEpisodeFreeze(
  messages: XuanpuAgentFreezeMessage[],
  existingEpisodes: FieldEpisodeBlockRecord[],
  options: XuanpuAgentEpisodeFreezeOptions = {}
): XuanpuAgentFreezableMessage[] {
  const keepRecentMessages = options.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES
  const minFreezeMessages = options.minFreezeMessages ?? DEFAULT_MIN_FREEZE_MESSAGES
  const referencedIds = collectReferencedMessageIds(existingEpisodes)
  const visibleMessages = messages.filter(isFreezableMessage)

  const oldMessageCount = Math.max(0, visibleMessages.length - keepRecentMessages)
  if (oldMessageCount <= 0) return []

  const candidates = visibleMessages
    .slice(0, oldMessageCount)
    .filter((message) => message.id && !referencedIds.has(message.id))

  return candidates.length >= minFreezeMessages ? candidates : []
}

function isFreezableMessage(
  message: XuanpuAgentFreezeMessage
): message is XuanpuAgentFreezableMessage {
  return (
    (message.role === 'user' || message.role === 'assistant') &&
    Boolean(message.id) &&
    message.content.trim().length > 0
  )
}

function collectReferencedMessageIds(episodes: FieldEpisodeBlockRecord[]): Set<string> {
  const ids = new Set<string>()
  for (const episode of episodes) {
    for (const ref of episode.rawRefs) {
      if (ref.type === 'session_message') ids.add(ref.id)
    }
  }
  return ids
}
