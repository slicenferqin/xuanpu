/**
 * Centralised secret redaction (Token Saver stage 0).
 *
 * Before stage 0 there were two near-duplicate `redactSecrets` implementations
 * in `episodic-updater.ts` and `claude-haiku-compactor.ts` with different
 * semantics (line-level vs inline) and identical-but-weak patterns. This module
 * consolidates them and strengthens coverage.
 *
 * Two modes are exposed because the consumers genuinely need both:
 *   - 'inline'  — surgical: replace only the secret value, keep surrounding
 *                 context. Best when downstream consumes the text as natural
 *                 language and needs continuity (LLM compactor input).
 *   - 'line'    — aggressive: replace the entire matching line. Best when the
 *                 redacted text is logged/persisted and we want maximum safety.
 *
 * Patterns are intentionally conservative: false positives here are cheaper
 * than leaking secrets. We err on the side of redacting too much.
 *
 * Future Token Saver stages (MCP Bash interceptor, archive writer) will reuse
 * this module — DO NOT add another local copy elsewhere. If a new pattern is
 * needed, add it here with a test.
 */

/**
 * Inline patterns — match a key-like prefix followed by an assignment and
 * the secret value. The capturing group `kw` preserves the keyword so the
 * replacement reads `keyword=[REDACTED]` instead of an opaque blob.
 */
const INLINE_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // Common credential keywords with assignment-like operators.
  // Examples matched:
  //   API_KEY=sk-1234567890abcdef
  //   password: "hunter2"
  //   Bearer eyJhbG...
  //   authorization: Bearer xyz
  {
    name: 'keyword-assignment',
    regex: /(api[_-]?key|password|passwd|secret|token|authorization|bearer)\s*[:=]?\s*[A-Za-z0-9_\-./+=]{3,}/gi
  },
  // OpenAI-style sk- keys.
  { name: 'openai-key', regex: /\b(sk|pk)-[A-Za-z0-9]{20,}\b/g },
  // Anthropic API keys (sk-ant-...).
  { name: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  // GitHub personal access tokens (ghp_, gho_, ghu_, ghs_, ghr_).
  { name: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  // AWS access key IDs.
  { name: 'aws-access-key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  // JWT (three base64url segments separated by dots, header starts with eyJ).
  { name: 'jwt', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // Generic 32+ char hex (likely API hash / session id).
  { name: 'hex-secret', regex: /\b[a-f0-9]{32,}\b/gi },
  // PEM blocks (private keys).
  {
    name: 'pem-block',
    regex: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g
  }
]

/**
 * Line-level keyword regex — if a line contains any of these keywords (as a
 * whole word, plural or singular), the whole line is replaced. Word boundaries
 * prevent false positives like "secretary" or "tokenize" matching.
 */
const LINE_KEYWORD_REGEX =
  /\b(api[_-]?keys?|passwords?|passwds?|secrets?|tokens?|authorizations?|bearer|credentials?|private[_-]?keys?)\b/i

export type RedactMode = 'inline' | 'line'

export interface RedactOptions {
  mode?: RedactMode
  /**
   * Optional override: caller may provide a custom replacement template.
   * Defaults are mode-specific.
   */
  replacement?: string
}

/**
 * Redact secrets from a string. Defaults to 'inline' mode.
 *
 * The function is allocation-friendly for the common case (no match → returns
 * input string unchanged) so it's safe to call on every Bash output line.
 */
export function redactSecrets(input: string, options: RedactOptions = {}): string {
  if (typeof input !== 'string' || input.length === 0) return input
  const mode = options.mode ?? 'inline'

  if (mode === 'line') {
    const replacement = options.replacement ?? '[REDACTED LINE]'
    // Fast path: no keyword anywhere → no allocation.
    if (!LINE_KEYWORD_REGEX.test(input)) return input
    return input
      .split('\n')
      .map((line) => (LINE_KEYWORD_REGEX.test(line) ? replacement : line))
      .join('\n')
  }

  // Inline mode.
  let result = input
  for (const { regex } of INLINE_PATTERNS) {
    if (!regex.test(result)) {
      // Reset stateful regex (g flag) before next pattern.
      regex.lastIndex = 0
      continue
    }
    regex.lastIndex = 0
    result = result.replace(regex, (match) => {
      // Preserve the leading keyword + separator if present, otherwise replace
      // the whole match. We detect the keyword form by looking for an `=` or
      // `:` in the matched substring within the first ~32 chars.
      const sepIdx = match.search(/[:=]/)
      if (sepIdx > 0 && sepIdx < 32) {
        const kw = match.slice(0, sepIdx).trim()
        return `${kw}=[REDACTED]`
      }
      return '[REDACTED]'
    })
  }
  return result
}

/**
 * Test-only export of patterns (for coverage assertion).
 */
export const __REDACT_INTERNAL_FOR_TEST = {
  INLINE_PATTERNS,
  LINE_KEYWORD_REGEX
}
