import type { TimelineRound } from './view-model'
import { getMessageDisplayContent } from '@/lib/message-actions'

export interface RoundNavigatorItem {
  id: string
  index: number
  preview: string
}

const PREVIEW_MAX_CHARS = 10

function truncateToVisible(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length === 0) return '未命名'
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max) + '…'
}

export function buildRoundNavigatorItems(rounds: TimelineRound[]): RoundNavigatorItem[] {
  return rounds.map((round, index) => {
    const displayText = getMessageDisplayContent(round.userNode.textContent ?? '')
    return {
      id: round.id,
      index,
      preview: truncateToVisible(displayText, PREVIEW_MAX_CHARS)
    }
  })
}
