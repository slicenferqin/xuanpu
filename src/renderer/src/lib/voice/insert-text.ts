export interface InsertVoiceTextInput {
  current: string
  insert: string
  selectionStart: number
  selectionEnd: number
}

export interface InsertVoiceTextResult {
  value: string
  cursor: number
}

function isAsciiWord(char: string): boolean {
  return /^[A-Za-z0-9_$]$/.test(char)
}

function needsSpaceBefore(left: string, text: string): boolean {
  if (!left || !text) return false
  const prev = left[left.length - 1]
  const first = text[0]
  return isAsciiWord(prev) && isAsciiWord(first)
}

function needsSpaceAfter(text: string, right: string): boolean {
  if (!right || !text) return false
  const last = text[text.length - 1]
  const next = right[0]
  return isAsciiWord(last) && isAsciiWord(next)
}

export function insertVoiceText(input: InsertVoiceTextInput): InsertVoiceTextResult {
  const start = Math.max(0, Math.min(input.selectionStart, input.current.length))
  const end = Math.max(start, Math.min(input.selectionEnd, input.current.length))
  const left = input.current.slice(0, start)
  const right = input.current.slice(end)
  const normalized = input.insert.trim()

  if (!normalized) {
    return { value: input.current, cursor: start }
  }

  const prefix = needsSpaceBefore(left, normalized) ? ' ' : ''
  const suffix = needsSpaceAfter(normalized, right) ? ' ' : ''
  const nextInsert = `${prefix}${normalized}${suffix}`
  const value = `${left}${nextInsert}${right}`

  return {
    value,
    cursor: left.length + prefix.length + normalized.length
  }
}
