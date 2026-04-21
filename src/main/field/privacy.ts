/**
 * Field Event Stream — privacy gate.
 *
 * Phase 21: a single boolean toggle (`field_collection_enabled` setting)
 * determines whether ANY field events are recorded. Default: enabled.
 *
 * The cache MUST be updated synchronously in the same call path as the
 * underlying setting write (see settings-handlers.ts) to avoid a stale-read
 * window between writing the DB and the next event being processed.
 *
 * See docs/prd/phase-21-field-events.md §6
 */
import { getDatabase } from '../db'

const SETTING_KEY = 'field_collection_enabled'

let cached: boolean | null = null

export function isFieldCollectionEnabled(): boolean {
  if (cached !== null) return cached
  const value = getDatabase().getSetting(SETTING_KEY)
  // Absent or any value other than the literal string 'false' -> enabled.
  cached = value !== 'false'
  return cached
}

/**
 * Update the cache immediately, in the same call path as the DB write.
 * Call this from the settings:set IPC handler when the user toggles
 * `field_collection_enabled`.
 */
export function setFieldCollectionEnabledCache(value: boolean): void {
  cached = value
}

/**
 * Force the next read to re-query the DB. Intended for tests and for
 * recovery after manual DB edits; not used in the normal toggle path.
 */
export function invalidatePrivacyCache(): void {
  cached = null
}

export const FIELD_COLLECTION_SETTING_KEY = SETTING_KEY
