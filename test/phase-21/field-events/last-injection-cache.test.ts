import { describe, it, expect, beforeEach } from 'vitest'
import {
  cacheLastInjection,
  getLastInjection,
  __resetForTest,
  __CACHE_TUNABLES_FOR_TEST
} from '../../../src/main/field/last-injection-cache'

beforeEach(() => {
  __resetForTest()
})

describe('last-injection-cache — Phase 22A M3', () => {
  it('returns null for unknown keys', () => {
    expect(getLastInjection('missing')).toBeNull()
  })

  it('caches and retrieves by a single key', () => {
    cacheLastInjection(['sess-1'], 'preview text', 42)
    const got = getLastInjection('sess-1')
    expect(got?.preview).toBe('preview text')
    expect(got?.approxTokens).toBe(42)
    expect(typeof got?.timestamp).toBe('number')
  })

  it('multi-key: same entry reachable from every provided key', () => {
    cacheLastInjection(['hive-abc', 'runtime-xyz'], 'ctx', 100)
    expect(getLastInjection('hive-abc')?.preview).toBe('ctx')
    expect(getLastInjection('runtime-xyz')?.preview).toBe('ctx')
  })

  it('ignores null and undefined keys', () => {
    cacheLastInjection(['hive-1', null, undefined, 'runtime-1'], 'x', 10)
    expect(getLastInjection('hive-1')?.preview).toBe('x')
    expect(getLastInjection('runtime-1')?.preview).toBe('x')
  })

  it('deduplicates repeated keys in the same call', () => {
    cacheLastInjection(['k', 'k', 'k'], 'once', 5)
    expect(getLastInjection('k')?.preview).toBe('once')
  })

  it('re-caching same key updates the entry', () => {
    cacheLastInjection(['k'], 'old', 5)
    cacheLastInjection(['k'], 'new', 10)
    const got = getLastInjection('k')
    expect(got?.preview).toBe('new')
    expect(got?.approxTokens).toBe(10)
  })

  it('LRU evicts oldest when size exceeds MAX_ENTRIES', () => {
    const max = __CACHE_TUNABLES_FOR_TEST.MAX_ENTRIES
    for (let i = 0; i < max; i++) {
      cacheLastInjection([`k${i}`], `v${i}`, i)
    }
    // Next insertion should evict k0
    cacheLastInjection(['overflow'], 'new', 999)
    expect(getLastInjection('k0')).toBeNull()
    expect(getLastInjection('overflow')?.preview).toBe('new')
    expect(getLastInjection(`k${max - 1}`)?.preview).toBe(`v${max - 1}`)
  })

  it('touching an existing key refreshes its LRU position', () => {
    const max = __CACHE_TUNABLES_FOR_TEST.MAX_ENTRIES
    for (let i = 0; i < max; i++) {
      cacheLastInjection([`k${i}`], `v${i}`, i)
    }
    // Touch k0 (should move to newest)
    cacheLastInjection(['k0'], 'refreshed', 0)
    // Next insert should evict k1 (new oldest), not k0
    cacheLastInjection(['extra'], 'new', 1)
    expect(getLastInjection('k0')?.preview).toBe('refreshed')
    expect(getLastInjection('k1')).toBeNull()
  })

  it('__resetForTest clears everything', () => {
    cacheLastInjection(['a'], 'x', 1)
    cacheLastInjection(['b'], 'y', 2)
    __resetForTest()
    expect(getLastInjection('a')).toBeNull()
    expect(getLastInjection('b')).toBeNull()
  })

  it('timestamps are monotonic across writes', () => {
    cacheLastInjection(['a'], 'first', 1)
    const t1 = getLastInjection('a')!.timestamp
    // Small wait to guarantee Date.now() advances
    const start = Date.now()
    while (Date.now() === start) {
      /* spin */
    }
    cacheLastInjection(['b'], 'second', 2)
    const t2 = getLastInjection('b')!.timestamp
    expect(t2).toBeGreaterThan(t1)
  })
})
