/**
 * Last Field Context Injection Cache — Phase 22A §5.
 *
 * Stores the most recent Field Context that was injected into each agent
 * prompt, keyed by session id(s). Enables a debug UI that lets the user see
 * what the Agent actually received.
 *
 * Multi-key support: in agent-handlers.ts, a prompt is processed via the
 * `runtimeSessionId` (the SDK's session id), but the UI queries by the Hive
 * session id. We write the same entry under both keys so either query works.
 *
 * LRU eviction: when the cache exceeds MAX_ENTRIES, the oldest insertion is
 * evicted (Map preserves insertion order).
 */

const MAX_ENTRIES = 200

export interface CachedInjection {
  preview: string
  timestamp: number
  approxTokens: number
}

const cache = new Map<string, CachedInjection>()

/**
 * Cache an injection under multiple keys. All non-empty unique keys will
 * resolve to the same entry. Each call counts as one LRU "write" per unique key.
 */
export function cacheLastInjection(
  keys: ReadonlyArray<string | null | undefined>,
  preview: string,
  approxTokens: number
): void {
  const entry: CachedInjection = {
    preview,
    timestamp: Date.now(),
    approxTokens
  }
  const seen = new Set<string>()
  for (const key of keys) {
    if (!key || seen.has(key)) continue
    seen.add(key)
    // Delete-then-insert so LRU ordering is refreshed even if the key already existed.
    cache.delete(key)
    cache.set(key, entry)
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value
      if (!oldest) break
      cache.delete(oldest)
    }
  }
}

export function getLastInjection(key: string): CachedInjection | null {
  return cache.get(key) ?? null
}

/** Test helper. */
export function __resetForTest(): void {
  cache.clear()
}

export const __CACHE_TUNABLES_FOR_TEST = { MAX_ENTRIES }
