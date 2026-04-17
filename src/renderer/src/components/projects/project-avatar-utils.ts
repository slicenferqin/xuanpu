const TOKEN_SPLIT_RE = /[\s._/-]+/
const TOKEN_STRIP_RE = /[\s._/-]+/g
const ALNUM_RE = /[A-Za-z0-9]/

export const PROJECT_AVATAR_COLOR_CLASSES = [
  'bg-emerald-600',
  'bg-blue-600',
  'bg-amber-600',
  'bg-violet-600',
  'bg-rose-600',
  'bg-cyan-600',
  'bg-orange-600',
  'bg-fuchsia-600',
  'bg-teal-600',
  'bg-sky-600'
] as const

function getLatinChars(value: string): string[] {
  return Array.from(value).filter((char) => ALNUM_RE.test(char))
}

function getVisibleChars(value: string): string[] {
  return Array.from(value.replace(TOKEN_STRIP_RE, '')).filter((char) => char.trim() !== '')
}

function getFirstLatinChar(value: string): string | null {
  return getLatinChars(value)[0] ?? null
}

export function getProjectAvatarInitials(name: string | null | undefined): string {
  const trimmed = name?.trim() ?? ''
  if (!trimmed) return '?'

  const tokens = trimmed
    .split(TOKEN_SPLIT_RE)
    .map((token) => token.trim())
    .filter(Boolean)

  const latinTokens = tokens.filter((token) => ALNUM_RE.test(token))

  if (latinTokens.length >= 2) {
    const first = getFirstLatinChar(latinTokens[0])
    const last = getFirstLatinChar(latinTokens[latinTokens.length - 1])
    const initials = [first, last].filter(Boolean).join('').toUpperCase()
    if (initials) return initials
  }

  if (latinTokens.length === 1) {
    const singleToken = getLatinChars(latinTokens[0]).slice(0, 2).join('').toUpperCase()
    if (singleToken) return singleToken
  }

  const visibleChars = getVisibleChars(trimmed).slice(0, 2).join('')
  return visibleChars || '?'
}

export function getProjectAvatarColorClass(name: string | null | undefined): string {
  const seed = name?.trim() || '?'

  let hash = 0
  for (const char of Array.from(seed)) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0
  }

  return PROJECT_AVATAR_COLOR_CLASSES[hash % PROJECT_AVATAR_COLOR_CLASSES.length]
}
