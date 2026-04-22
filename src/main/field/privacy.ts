/**
 * Field Event Stream — privacy + injection gates.
 *
 * Phase 21 introduced `field_collection_enabled` (do we capture events?).
 * Phase 22C.1 added a separate control: `include_memory_in_prompts` (do we
 * read user-authored memory.md files and inject them into prompts?).
 *
 * They are DELIBERATELY separate:
 *   - Event collection is passive capture of user activity. Privacy-sensitive.
 *   - Memory injection is active reading of user-authored markdown. Trust-level
 *     belongs to the user, not to the event-stream privacy model.
 *
 * Each cache MUST be updated synchronously in the same call path as the
 * underlying setting write (see database-handlers.ts) to avoid stale-read
 * windows between the DB write and the next decision point.
 *
 * See docs/prd/phase-21-field-events.md §6 and docs/prd/phase-22c-semantic-memory.md §7
 */
import { getDatabase } from '../db'

// ---------------------------------------------------------------------------
// field_collection_enabled (Phase 21)
// ---------------------------------------------------------------------------

const COLLECTION_SETTING_KEY = 'field_collection_enabled'
let collectionCached: boolean | null = null

export function isFieldCollectionEnabled(): boolean {
  if (collectionCached !== null) return collectionCached
  const value = getDatabase().getSetting(COLLECTION_SETTING_KEY)
  collectionCached = value !== 'false'
  return collectionCached
}

export function setFieldCollectionEnabledCache(value: boolean): void {
  collectionCached = value
}

export const FIELD_COLLECTION_SETTING_KEY = COLLECTION_SETTING_KEY

// ---------------------------------------------------------------------------
// include_memory_in_prompts (Phase 22C.1)
// ---------------------------------------------------------------------------

const INJECTION_SETTING_KEY = 'include_memory_in_prompts'
let injectionCached: boolean | null = null

export function isMemoryInjectionEnabled(): boolean {
  if (injectionCached !== null) return injectionCached
  const value = getDatabase().getSetting(INJECTION_SETTING_KEY)
  injectionCached = value !== 'false'
  return injectionCached
}

export function setMemoryInjectionEnabledCache(value: boolean): void {
  injectionCached = value
}

export const MEMORY_INJECTION_SETTING_KEY = INJECTION_SETTING_KEY

// ---------------------------------------------------------------------------
// agent_bash_capture_output (Phase 21.5)
//
// Bash output (stdout/stderr) captured from agent tool_use observations is
// frequently sensitive: API keys, env dumps, error stacks with tokens.
//
// Default OFF. Opt-in via Settings → Privacy → "Capture Bash stdout/stderr
// for agent analysis". The command itself is still captured regardless of
// this flag (the user can already see it in the sidebar).
// ---------------------------------------------------------------------------

const BASH_CAPTURE_SETTING_KEY = 'agent_bash_capture_output'
let bashCaptureCached: boolean | null = null

export function isBashOutputCaptureEnabled(): boolean {
  if (bashCaptureCached !== null) return bashCaptureCached
  const value = getDatabase().getSetting(BASH_CAPTURE_SETTING_KEY)
  // Default OFF: unset or literally 'false' → false. Must be 'true' to enable.
  bashCaptureCached = value === 'true'
  return bashCaptureCached
}

export function setBashOutputCaptureEnabledCache(value: boolean): void {
  bashCaptureCached = value
}

export const BASH_OUTPUT_CAPTURE_SETTING_KEY = BASH_CAPTURE_SETTING_KEY

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function invalidatePrivacyCache(): void {
  collectionCached = null
  injectionCached = null
  bashCaptureCached = null
}
