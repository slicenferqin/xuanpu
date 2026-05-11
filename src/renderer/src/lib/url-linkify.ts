export type UrlLinkifyPart =
  | { type: 'text'; text: string }
  | { type: 'url'; text: string; url: string }

// Stop before ANSI ESC as run output often colorizes URLs with SGR resets.
// eslint-disable-next-line no-control-regex
const URL_RE = /https?:\/\/[^\s<>"'\x1b]+/gi
const TRAILING_PUNCTUATION = new Set(['.', ',', '!', '?', ';', ':'])
const CLOSING_TO_OPENING: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{'
}

function countChar(text: string, char: string): number {
  let count = 0
  for (const current of text) {
    if (current === char) count++
  }
  return count
}

function splitTrailingUrlText(candidate: string): { url: string; trailing: string } {
  let url = candidate
  let trailing = ''

  while (url.length > 0) {
    const last = url.at(-1)
    if (!last) break

    if (TRAILING_PUNCTUATION.has(last)) {
      trailing = last + trailing
      url = url.slice(0, -1)
      continue
    }

    const opening = CLOSING_TO_OPENING[last]
    if (opening && countChar(url, last) > countChar(url, opening)) {
      trailing = last + trailing
      url = url.slice(0, -1)
      continue
    }

    break
  }

  return { url, trailing }
}

export function linkifyHttpUrls(text: string): UrlLinkifyPart[] {
  URL_RE.lastIndex = 0

  const parts: UrlLinkifyPart[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', text: text.slice(lastIndex, match.index) })
    }

    const candidate = match[0]
    const { url, trailing } = splitTrailingUrlText(candidate)

    if (url.length > 0) {
      parts.push({ type: 'url', text: url, url })
    } else {
      parts.push({ type: 'text', text: candidate })
    }

    if (trailing.length > 0) {
      parts.push({ type: 'text', text: trailing })
    }

    lastIndex = match.index + candidate.length
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', text: text.slice(lastIndex) })
  }

  return parts
}

export function hasHttpUrl(text: string): boolean {
  URL_RE.lastIndex = 0
  return URL_RE.test(text)
}
