/**
 * OpenCode session title generation — mirrors the Codex 1.4.4 pattern of
 * generating a concise, human-meaningful conversation title from the first
 * user message.
 *
 * **Engine**: delegates to `generateCodexSessionTitle` (GPT-5.4 via the local
 * Codex CLI). The engine is runtime-agnostic — Codex just happens to be the
 * fastest path to a title model already wired up. The opencode-namespaced
 * wrapper exists so call sites in `opencode-service.ts` read clearly, and so
 * we can swap to OpenCode's own `session.summarize` endpoint (or another
 * provider) later without touching the caller.
 *
 * **Why we need this on OpenCode**: OpenCode's server eventually emits a
 * `session.updated` event with a title, but the wait can be long and the
 * intermediate title is often a placeholder ("New Session 2026-..."). This
 * helper provides an immediate fast-path so the user sees a meaningful name
 * within seconds of sending the first prompt.
 *
 * **Race vs server title**: the caller is responsible for only applying the
 * generated title when the current DB title is still a placeholder. The
 * existing `session.updated` handler in `opencode-service.ts` (which detects
 * placeholders via `/^Session \d+$/i` and `/^New session.../i`) will pick up
 * any later, better title from OpenCode itself.
 */

export async function generateOpenCodeSessionTitle(
  message: string,
  worktreePath?: string
): Promise<string | null> {
  // Lazy-load the Codex title generator so this module's pure helpers
  // (`isPlaceholderSessionTitle`, `extractTitleSourceText`) can be imported
  // and unit-tested without dragging in the Codex CLI / logger / Electron
  // dependency chain.
  const { generateCodexSessionTitle } = await import('./codex-session-title')
  return generateCodexSessionTitle(message, worktreePath)
}

/**
 * Detect placeholder titles that should be overwritten by a generated title.
 *
 * Matches:
 *   - "Session 1", "Session 42" — Hive default naming
 *   - "New Session 2026-04-29T..." — OpenCode default naming
 *   - empty / null
 *
 * Mirrors the regex used in `opencode-service.ts` `session.updated` handler
 * so both code paths agree on what counts as a placeholder.
 */
export function isPlaceholderSessionTitle(title: string | null | undefined): boolean {
  if (!title) return true
  const trimmed = title.trim()
  if (trimmed.length === 0) return true
  if (/^Session \d+$/i.test(trimmed)) return true
  if (/^New session\s*-?\s*\d{4}-\d{2}-\d{2}/i.test(trimmed)) return true
  return false
}

/**
 * Extract a user-message text suitable for title generation from a string or
 * a parts array (text + file). Files are skipped; text parts are concatenated
 * with single spaces.
 */
export function extractTitleSourceText(
  messageOrParts:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'file'; mime: string; url: string; filename?: string }
      >
): string {
  if (typeof messageOrParts === 'string') return messageOrParts.trim()
  return messageOrParts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
    .trim()
}
