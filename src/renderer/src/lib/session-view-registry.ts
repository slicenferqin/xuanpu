export interface SessionViewState {
  scrollTop: number
  stickyBottom: boolean
  manualScrollLocked: boolean
  lastSeenVersion: number
}

const STORAGE_KEY = 'xuanpu:session-view-registry'

const DEFAULT_SESSION_VIEW_STATE: SessionViewState = {
  scrollTop: 0,
  stickyBottom: true,
  manualScrollLocked: false,
  lastSeenVersion: 0
}

const _sessionViewRegistry = new Map<string, SessionViewState>()
let _didLoadFromStorage = false

function normalizeSessionViewState(
  state?: Partial<SessionViewState>,
  maxSeenVersion = Number.POSITIVE_INFINITY
): SessionViewState {
  const scrollTop =
    typeof state?.scrollTop === 'number' && Number.isFinite(state.scrollTop)
      ? Math.max(0, state.scrollTop)
      : DEFAULT_SESSION_VIEW_STATE.scrollTop

  const stickyBottom =
    typeof state?.stickyBottom === 'boolean'
      ? state.stickyBottom
      : DEFAULT_SESSION_VIEW_STATE.stickyBottom

  const boundedMaxSeenVersion = Number.isFinite(maxSeenVersion)
    ? Math.max(0, maxSeenVersion)
    : Number.POSITIVE_INFINITY

  const rawLastSeenVersion =
    typeof state?.lastSeenVersion === 'number' && Number.isFinite(state.lastSeenVersion)
      ? Math.max(0, state.lastSeenVersion)
      : DEFAULT_SESSION_VIEW_STATE.lastSeenVersion

  const lastSeenVersion = Math.min(rawLastSeenVersion, boundedMaxSeenVersion)

  const manualScrollLocked =
    stickyBottom
      ? false
      : typeof state?.manualScrollLocked === 'boolean'
        ? state.manualScrollLocked
        : DEFAULT_SESSION_VIEW_STATE.manualScrollLocked

  return {
    scrollTop,
    stickyBottom,
    manualScrollLocked,
    lastSeenVersion
  }
}

function persistRegistry(): void {
  if (typeof window === 'undefined' || typeof window.sessionStorage?.setItem !== 'function') {
    return
  }

  try {
    const payload = Object.fromEntries(_sessionViewRegistry)
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Non-fatal: the in-memory registry still preserves session anchors.
  }
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

    const parsed = JSON.parse(raw) as Record<string, Partial<SessionViewState>>
    for (const [sessionId, state] of Object.entries(parsed)) {
      _sessionViewRegistry.set(sessionId, normalizeSessionViewState(state))
    }
  } catch {
    _sessionViewRegistry.clear()
  }
}

export function getSessionViewState(
  sessionId: string,
  maxSeenVersion = Number.POSITIVE_INFINITY
): SessionViewState {
  ensureRegistryLoaded()

  const current = normalizeSessionViewState(_sessionViewRegistry.get(sessionId), maxSeenVersion)
  _sessionViewRegistry.set(sessionId, current)
  return { ...current }
}

export function setSessionViewState(
  sessionId: string,
  nextState: Partial<SessionViewState>,
  maxSeenVersion = Number.POSITIVE_INFINITY
): SessionViewState {
  ensureRegistryLoaded()

  const current = getSessionViewState(sessionId, maxSeenVersion)
  const next = normalizeSessionViewState(
    {
      ...current,
      ...nextState
    },
    maxSeenVersion
  )
  _sessionViewRegistry.set(sessionId, next)
  persistRegistry()
  return { ...next }
}

export function updateSessionViewState(
  sessionId: string,
  updater: (current: SessionViewState) => Partial<SessionViewState>,
  maxSeenVersion = Number.POSITIVE_INFINITY
): SessionViewState {
  ensureRegistryLoaded()

  const current = getSessionViewState(sessionId, maxSeenVersion)
  return setSessionViewState(sessionId, updater(current), maxSeenVersion)
}

export function resetSessionViewRegistryForTests(): void {
  _sessionViewRegistry.clear()
  _didLoadFromStorage = false

  if (typeof window !== 'undefined' && typeof window.sessionStorage?.removeItem === 'function') {
    window.sessionStorage.removeItem(STORAGE_KEY)
  }
}
