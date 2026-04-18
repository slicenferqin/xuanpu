import type { TimelineMessage } from '@shared/lib/timeline-types'
import { ASK_MODE_PREFIX, PLAN_MODE_PREFIX } from '@/lib/constants'

export function getMessageDisplayContent(content: string): string {
  if (content.startsWith(PLAN_MODE_PREFIX)) {
    return content.slice(PLAN_MODE_PREFIX.length)
  }
  if (content.startsWith(ASK_MODE_PREFIX)) {
    return content.slice(ASK_MODE_PREFIX.length)
  }
  return content
}

export function restoreMessageModePrefix(originalContent: string, displayContent: string): string {
  if (originalContent.startsWith(PLAN_MODE_PREFIX)) {
    return PLAN_MODE_PREFIX + displayContent
  }
  if (originalContent.startsWith(ASK_MODE_PREFIX)) {
    return ASK_MODE_PREFIX + displayContent
  }
  return displayContent
}

export function getUserMessageForkCutoff(
  messages: TimelineMessage[],
  messageId: string
): string | undefined {
  const messageIndex = messages.findIndex((candidate) => candidate.id === messageId)
  if (messageIndex === -1) return undefined

  const cutoffMessage = messages
    .slice(messageIndex + 1)
    .find((candidate) => !candidate.id.startsWith('optimistic-'))

  return cutoffMessage?.id
}
