export type InlineCodeKind =
  | 'symbol'
  | 'command'
  | 'path'
  | 'id'
  | 'metric'
  | 'phrase'
  | 'unknown'

export function classifyInlineCode(content: string): InlineCodeKind {
  const trimmed = content.trim()
  if (!trimmed) return 'unknown'

  // Path: contains / or \, known file extensions, starts with ~/ ./
  if (
    /[\\/]/.test(trimmed) ||
    /^~?\.\//.test(trimmed) ||
    /\.(tsx?|jsx?|css|json|md|yaml|yml|toml|rs|go|py|sh|sql|html|svg)$/i.test(trimmed)
  ) {
    return 'path'
  }

  // ID: UUID, hash, session-id shape
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed) ||
    /^[0-9a-f]{16,}$/i.test(trimmed)
  ) {
    return 'id'
  }

  // Command: starts with common commands or has shell flags
  if (
    /^(pnpm|npm|yarn|npx|git|docker|kubectl|cargo|pip|brew|curl|wget|ssh|scp|rg|grep|sed|awk|cd|ls|cat|rm|mv|cp|mkdir|chmod|sudo|make|cmake|node|python|go|rustc|java|gcc|clang)\b/.test(
      trimmed
    ) ||
    /^--?[a-z]/.test(trimmed) ||
    /^[A-Z_]+=[^\s]+/.test(trimmed)
  ) {
    return 'command'
  }

  // Metric: key: value or key=value
  if (/^[a-zA-Z_][\w.-]*[:=]\s*.+$/.test(trimmed)) {
    return 'metric'
  }

  // Symbol: function call, class name, member access, code identifier
  if (
    /^[a-zA-Z_$][\w$]*\(/.test(trimmed) ||
    /^[A-Z][a-zA-Z0-9]+$/.test(trimmed) ||
    /\.[a-zA-Z_$][\w$]*/.test(trimmed) ||
    /^(true|false|null|undefined|void|never|any|unknown|string|number|boolean|Promise|Array|Map|Set|Record|Partial|Required|Omit|Pick)\b/.test(trimmed)
  ) {
    return 'symbol'
  }

  // Phrase: contains CJK or spaces with no code punctuation
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(trimmed)) {
    return 'phrase'
  }
  if (/^[a-zA-Z\s'-]+$/.test(trimmed) && trimmed.includes(' ') && trimmed.length > 15) {
    return 'phrase'
  }

  // Fallback: if it looks like a single identifier, treat as symbol
  if (/^[a-zA-Z_$][\w$]*$/.test(trimmed)) {
    return 'symbol'
  }

  return 'unknown'
}
