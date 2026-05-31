import type { TimelineRound } from './view-model'
import { getMessageDisplayContent } from '@/lib/message-actions'

export interface RoundNavigatorItem {
  id: string
  index: number
  /** Raw normalized user prompt text. Component handles display truncation. */
  preview: string
}

export function buildRoundNavigatorItems(rounds: TimelineRound[]): RoundNavigatorItem[] {
  return rounds.map((round, index) => {
    const displayText = getMessageDisplayContent(round.userNode.textContent ?? '')
    const normalized = displayText.replace(/\s+/g, ' ').trim()
    return {
      id: round.id,
      index,
      preview: normalized.length > 0 ? normalized : '未命名'
    }
  })
}
