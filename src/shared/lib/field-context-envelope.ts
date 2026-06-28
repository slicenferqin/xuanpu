const FIELD_CONTEXT_HEADER_RE =
  /^\s*\[(?:Field Context|Xuanpu Field Fallback|Xuanpu Plan Mode)(?:\s+[^\]\r\n]*|[\u2013\u2014-][^\]\r\n]*)?\][ \t]*(?:\r?\n|$)/

const USER_MESSAGE_MARKER_RE = /(?:^|\r?\n)[ \t]*\[User Message\][ \t]*(?:\r?\n|$)/

/**
 * Extract the user-authored text from a Xuanpu-injected prompt envelope.
 *
 * Non-envelope input is returned byte-for-byte unchanged. For envelope input,
 * only the injected wrapper is removed; the message content after
 * `[User Message]` is preserved as written.
 */
export function stripFieldContextEnvelope(content: string): string {
  if (!content) return content

  const header = FIELD_CONTEXT_HEADER_RE.exec(content)
  if (!header) return content

  const marker = USER_MESSAGE_MARKER_RE.exec(content.slice(header[0].length))
  if (!marker) return content

  return content.slice(header[0].length + marker.index + marker[0].length)
}

export type FieldContextMessagePart = {
  type: string
  text?: string
  mime?: string
  url?: string
  filename?: string
}

export type FieldContextMessage = string | FieldContextMessagePart[]

export function stripFieldContextEnvelopeFromMessage<T extends FieldContextMessage>(message: T): T {
  if (typeof message === 'string') {
    return stripFieldContextEnvelope(message) as T
  }

  let changed = false
  const parts = message.map((part) => {
    if (part.type !== 'text' || typeof part.text !== 'string') return part
    const strippedText = stripFieldContextEnvelope(part.text)
    if (strippedText === part.text) return part
    changed = true
    return { ...part, text: strippedText }
  })

  return (changed ? parts : message) as T
}
