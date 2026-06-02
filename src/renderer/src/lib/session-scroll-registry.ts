export interface ScrollAnchorState {
  scrollTop: number
  stickyBottom: boolean
  manualScrollLocked: boolean
  lastSeenVersion: number
}

// Storage key intentionally kept as 'xuanpu:session-view-registry' for backward compatibility.
// This is sessionStorage (per-tab, cleared on close), so there is no long-term migration burden,
// but keeping the key avoids losing scroll state for users who upgrade while the app is running.
const STORAGE_KEY = 'xuanpu:session-view-registry'
const PERSIST_DEBOUNCE_MS = 250

const DEFAULT_SCROLL_ANCHOR_STATE: ScrollAnchorState = {
  scrollTop: 0,
  stickyBottom: true,
  manualScrollLocked: false,
  lastSeenVersion: 0
}

const _scrollAnchorRegistry = new Map<string, ScrollAnchorState>()
let _didLoadFromStorage = false
let _persistTimeoutHandle: ReturnType<typeof setTimeout> | null = null
let _persistIdleHandle: number | null = null

function normalizeScrollAnchorState(
  state?: Partial<ScrollAnchorState>,
  maxSeenVersion = Number.POSITIVE_INFINITY
): ScrollAnchorState {
  const scrollTop =
    typeof state?.scrollTop === 'number' && Number.isFinite(state.scrollTop)
      ? Math.max(0, state.scrollTop)
      : DEFAULT_SCROLL_ANCHOR_STATE.scrollTop

  const stickyBottom =
    typeof state?.stickyBottom === 'boolean'
      ? state.stickyBottom
      : DEFAULT_SCROLL_ANCHOR_STATE.stickyBottom

  const boundedMaxSeenVersion = Number.isFinite(maxSeenVersion)
    ? Math.max(0, maxSeenVersion)
    : Number.POSITIVE_INFINITY

  const rawLastSeenVersion =
    typeof state?.lastSeenVersion === 'number' && Number.isFinite(state.lastSeenVersion)
      ? Math.max(0, state.lastSeenVersion)
      : DEFAULT_SCROLL_ANCHOR_STATE.lastSeenVersion

  const lastSeenVersion = Math.min(rawLastSeenVersion, boundedMaxSeenVersion)

  const manualScrollLocked =
    stickyBottom
      ? false
      : typeof state?.manualScrollLocked === 'boolean'
        ? state.manualScrollLocked
        : DEFAULT_SCROLL_ANCHOR_STATE.manualScrollLocked

  return {
    scrollTop,
    stickyBottom,
    manualScrollLocked,
    lastSeenVersion
  }
}

function cancelScheduledPersist(): void {
  if (_persistTimeoutHandle !== null) {
    clearTimeout(_persistTimeoutHandle)
    _persistTimeoutHandle = null
  }

  if (
    _persistIdleHandle !== null &&
    typeof globalThis.cancelIdleCallback === 'function'
  ) {
    globalThis.cancelIdleCallback(_persistIdleHandle)
    _persistIdleHandle = null
  }
}

function flushPersistRegistry(): void {
  _persistTimeoutHandle = null
  _persistIdleHandle = null

  if (typeof window === 'undefined') {
    return
  }

  const sessionStorage = window.sessionStorage
  if (
    typeof sessionStorage?.setItem !== 'function' ||
    typeof sessionStorage?.removeItem !== 'function'
  ) {
    return
  }

  try {
    if (_scrollAnchorRegistry.size === 0) {
      sessionStorage.removeItem(STORAGE_KEY)
      return
    }

    const payload = Object.fromEntries(_scrollAnchorRegistry)
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Non-fatal: the in-memory registry still preserves session anchors.
  }
}

function persistRegistry(): void {
  cancelScheduledPersist()

  if (typeof globalThis.requestIdleCallback === 'function') {
    _persistIdleHandle = globalThis.requestIdleCallback(
      () => {
        flushPersistRegistry()
      },
      { timeout: PERSIST_DEBOUNCE_MS }
    )
    return
  }

  _persistTimeoutHandle = setTimeout(() => {
    flushPersistRegistry()
  }, PERSIST_DEBOUNCE_MS)
}

function ensureRegistryLoaded(): void {
  if (_didLoadFromStorage) return
  _didLoadFromStorage = true

  if (typeof window === 'undefined' || typeof window.sessionStorage?.getItem !== 'function') {
    return
  }

  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return

    const parsed = JSON.parse(raw) as Record<string, Partial<ScrollAnchorState>>
    for (const [sessionId, state] of Object.entries(parsed)) {
      _scrollAnchorRegistry.set(sessionId, normalizeScrollAnchorState(state))
    }
  } catch {
    _scrollAnchorRegistry.clear()
  }
}

export function getScrollAnchorState(
  sessionId: string,
  maxSeenVersion = Number.POSITIVE_INFINITY
): ScrollAnchorState {
  ensureRegistryLoaded()

  const current = normalizeScrollAnchorState(_scrollAnchorRegistry.get(sessionId), maxSeenVersion)
  _scrollAnchorRegistry.set(sessionId, current)
  return { ...current }
}

export function setScrollAnchorState(
  sessionId: string,
  nextState: Partial<ScrollAnchorState>,
  maxSeenVersion = Number.POSITIVE_INFINITY
): ScrollAnchorState {
  ensureRegistryLoaded()

  const current = getScrollAnchorState(sessionId, maxSeenVersion)
  const next = normalizeScrollAnchorState(
    {
      ...current,
      ...nextState
    },
    maxSeenVersion
  )
  _scrollAnchorRegistry.set(sessionId, next)
  persistRegistry()
  return { ...next }
}

export function updateScrollAnchorState(
  sessionId: string,
  updater: (current: ScrollAnchorState) => Partial<ScrollAnchorState>,
  maxSeenVersion = Number.POSITIVE_INFINITY
): ScrollAnchorState {
  ensureRegistryLoaded()

  const current = getScrollAnchorState(sessionId, maxSeenVersion)
  return setScrollAnchorState(sessionId, updater(current), maxSeenVersion)
}

export function removeScrollAnchorState(sessionId: string): void {
  ensureRegistryLoaded()

  if (!_scrollAnchorRegistry.has(sessionId)) return

  _scrollAnchorRegistry.delete(sessionId)
  persistRegistry()
}

export function resetScrollAnchorRegistryForTests(): void {
  cancelScheduledPersist()
  _scrollAnchorRegistry.clear()
  _didLoadFromStorage = false

  if (typeof window !== 'undefined' && typeof window.sessionStorage?.removeItem === 'function') {
    window.sessionStorage.removeItem(STORAGE_KEY)
  }
}
