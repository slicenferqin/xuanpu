/**
 * Parser for the Token Saver footer appended by
 * `src/main/services/token-saver/xuanpu-tools-mcp.ts :: formatToolResultText`.
 *
 * Output shape (when compression fires):
 *
 *   <compressed text>
 *   ---
 *   [Token Saver] compressed 8432B → 412B (-95%) · via ansi-strip, progress-dedup · original: /path/to/file.txt
 *
 * Rules:
 *   - Footer always starts with `[Token Saver]` on its own line.
 *   - The `---` separator line precedes it (added by formatToolResultText).
 *   - `original:` is optional (missing when archive write failed).
 *   - If the raw body has no footer, we return null and callers render as-is.
 *
 * This is a best-effort parser. If the SDK / an upstream tool happens to
 * include a literal `[Token Saver]` line for any other reason we'd mis-parse,
 * but the prefix is unusual enough that false positives are acceptable.
 */

export interface ParsedTokenSaverFooter {
  /** Body above the separator — the actual content to render. */
  body: string
  /** Original size in bytes. */
  beforeBytes: number
  /** Compressed size in bytes. */
  afterBytes: number
  /** Saved percentage as an integer 0-100. */
  savedPercent: number
  /** Comma-separated list of strategy names that fired. */
  rules: string[]
  /** Absolute path to the archived original, if available. */
  archivePath: string | null
}

const FOOTER_REGEX =
  /\[Token Saver\]\s+compressed\s+(\d+)B\s*→\s*(\d+)B\s*\(-(\d+)%\)\s*·\s*via\s+([^·\n]+?)(?:\s*·\s*original:\s*(\S+))?\s*$/m

/**
 * Parse the compressed tool result body. Returns `null` if no footer is
 * present (compression didn't fire, or body is from another tool).
 */
export function parseTokenSaverFooter(
  raw: string | null | undefined
): ParsedTokenSaverFooter | null {
  if (!raw || typeof raw !== 'string') return null
  const match = FOOTER_REGEX.exec(raw)
  if (!match) return null

  const [fullLine, beforeStr, afterStr, savedStr, rulesStr, archivePath] = match

  // Strip the footer + its preceding separator line if present.
  const footerStart = raw.lastIndexOf(fullLine)
  if (footerStart === -1) return null
  let bodyEnd = footerStart
  // Back up over trailing newline(s).
  while (bodyEnd > 0 && (raw[bodyEnd - 1] === '\n' || raw[bodyEnd - 1] === '\r')) {
    bodyEnd--
  }
  // Back up over the `---` separator line (if we added one).
  const sepCandidate = raw.slice(0, bodyEnd).trimEnd()
  const sepIdx = sepCandidate.lastIndexOf('\n---')
  if (sepIdx !== -1 && sepCandidate.length - sepIdx <= 4) {
    bodyEnd = sepIdx
  } else if (sepCandidate.endsWith('---')) {
    bodyEnd = sepCandidate.length - 3
  }
  const body = raw.slice(0, bodyEnd).replace(/\s+$/g, '')

  return {
    body,
    beforeBytes: parseInt(beforeStr, 10) || 0,
    afterBytes: parseInt(afterStr, 10) || 0,
    savedPercent: parseInt(savedStr, 10) || 0,
    rules: rulesStr
      .split(',')
      .map((r) => r.trim())
      .filter((r) => r.length > 0),
    archivePath: archivePath ?? null
  }
}

/** Format a byte count for UI display (B / KB / MB). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}
