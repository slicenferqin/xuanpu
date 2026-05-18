import type { VoiceTranscriptEvent } from '../types/voice'

function hasWordLikeContent(text: string): boolean {
  return /[A-Za-z0-9\u3400-\u9fff]/.test(text)
}

export function appendFunAsrPartialText(buffered: string, incoming: string): string {
  const text = incoming.trim()
  if (!text) return buffered
  if (!buffered) return text
  if (text.startsWith(buffered)) return text
  if (buffered.endsWith(text)) return buffered
  return `${buffered}${text}`
}

export function finalizeFunAsrText(buffered: string, incoming: string): string {
  const text = incoming.trim()
  if (!buffered) return text
  if (!text) return buffered
  if (!hasWordLikeContent(text)) return `${buffered}${text}`
  if (text.includes(buffered) || text.length >= buffered.length) return text
  if (buffered.includes(text)) return buffered
  return text
}

export function parseFunAsrMessage(sessionId: string, raw: unknown): VoiceTranscriptEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const msg = raw as { text?: unknown; mode?: unknown; is_final?: unknown }
  if (typeof msg.text !== 'string' || msg.text.trim().length === 0) return null

  const mode = typeof msg.mode === 'string' ? msg.mode : ''
  const type: VoiceTranscriptEvent['type'] =
    mode.includes('offline') || msg.is_final === true ? 'final' : 'partial'

  return {
    sessionId,
    type,
    text: msg.text,
    raw
  }
}
