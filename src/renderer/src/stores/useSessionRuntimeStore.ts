/**
 * Session Runtime Store — Phase 1
 *
 * Per-session runtime state that survives tab switches and component remounts.
 * This is the **Runtime Layer** truth source for transient session state:
 *   lifecycle, interrupt queue, unread count, activity timestamps.
 *
 * **Not** the durable layer (DB) or view layer (scroll position, etc.).
 *
 * The `useAgentEventBridge` hook is the sole writer; React components are readers.
 */

import { create } from 'zustand'
import type { CanonicalAgentEvent } from '@shared/types/agent-protocol'
import type { StreamingPart } from '@shared/lib/timeline-types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionLifecycle = 'idle' | 'busy' | 'retry' | 'error' | 'materializing'

export type InterruptType = 'question' | 'permission' | 'command_approval' | 'plan'

export interface InterruptItem {
  type: InterruptType
  id: string
  sessionId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  timestamp: number
}

/** A message queued while the agent is busy (Phase 5 — composer state machine) */
export interface PendingMessage {
  id: string
  content: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attachments: any[]
  queuedAt: number
}

export interface SessionRuntimeState {
  lifecycle: SessionLifecycle
  inProgress: boolean
  unreadCount: number
  commandsAvailable: boolean
  lastActivityAt: number
  retryInfo: {
    attempt: number
    message?: string
    next?: number
  } | null
}

/** Exported so external selectors can use stable fallback without calling get() */
export const DEFAULT_SESSION_STATE: Readonly<SessionRuntimeState> = {
  lifecycle: 'idle',
  inProgress: false,
  unreadCount: 0,
  commandsAvailable: false,
  lastActivityAt: 0,
  retryInfo: null
}

// ---------------------------------------------------------------------------
// Per-session event callback registry (module-level, NOT reactive state)
// ---------------------------------------------------------------------------

type EventCallback = (event: CanonicalAgentEvent) => void
const _sessionEventCallbacks = new Map<string, Set<EventCallback>>()

// ---------------------------------------------------------------------------
// Streaming buffer (module-level, non-reactive)
// Survives SessionShell unmount/remount so streaming content is restored
// when the user switches away and comes back during an active turn.
// ---------------------------------------------------------------------------

export interface StreamingBuffer {
  parts: StreamingPart[]
  /** Child session parts keyed by child session id */
  childParts: Map<string, StreamingPart[]>
  streamingContent: string
  isStreaming: boolean
  runStartedAt?: number
  compactionState?: {
    phase: 'running' | 'completed'
    timestamp: number
  } | null
  /** Optimistic user messages not yet persisted to DB */
  optimisticMessages?: Array<{ id: string; role: string; content: string; timestamp: string; attachments?: unknown[] }>
}

const _streamingBuffers = new Map<string, StreamingBuffer>()

export function getStreamingBuffer(sessionId: string): StreamingBuffer | undefined {
  return _streamingBuffers.get(sessionId)
}

export function setStreamingBuffer(sessionId: string, buffer: StreamingBuffer): void {
  _streamingBuffers.set(sessionId, buffer)
}

export function clearStreamingBuffer(sessionId: string): void {
  _streamingBuffers.delete(sessionId)
}

// ---------------------------------------------------------------------------
// Per-session event guard registry (module-level, non-reactive)
// Tracks the active run epoch and latest accepted sessionSequence so the global
// event bridge can drop stale events before they reach any mounted view.
// ---------------------------------------------------------------------------

export interface SessionEventGuardState {
  activeRunEpoch: number
  lastAppliedSequence: number
}

export interface SessionEventGuardResult {
  accepted: boolean
  advancedRun: boolean
  state: SessionEventGuardState
}

const _sessionEventGuards = new Map<string, SessionEventGuardState>()
const DEFAULT_EVENT_GUARD_STATE: Readonly<SessionEventGuardState> = {
  activeRunEpoch: 0,
  lastAppliedSequence: -1
}

export function getSessionEventGuardState(sessionId: string): SessionEventGuardState | undefined {
  const state = _sessionEventGuards.get(sessionId)
  return state ? { ...state } : undefined
}

export function acceptSessionEvent(
  event: Pick<CanonicalAgentEvent, 'sessionId' | 'runEpoch' | 'sessionSequence'>
): SessionEventGuardResult {
  const current = _sessionEventGuards.get(event.sessionId) ?? DEFAULT_EVENT_GUARD_STATE
  const nextRunEpoch = event.runEpoch
  const nextSequence = event.sessionSequence

  if (nextRunEpoch < current.activeRunEpoch) {
    return {
      accepted: false,
      advancedRun: false,
      state: { ...current }
    }
  }

  if (nextRunEpoch > current.activeRunEpoch) {
    const nextState = {
      activeRunEpoch: nextRunEpoch,
      lastAppliedSequence: nextSequence
    }
    _sessionEventGuards.set(event.sessionId, nextState)
    return {
      accepted: true,
      advancedRun: true,
      state: { ...nextState }
    }
  }

  if (nextSequence <= current.lastAppliedSequence) {
    return {
      accepted: false,
      advancedRun: false,
      state: { ...current }
    }
  }

  const nextState = {
    activeRunEpoch: current.activeRunEpoch,
    lastAppliedSequence: nextSequence
  }
  _sessionEventGuards.set(event.sessionId, nextState)
  return {
    accepted: true,
    advancedRun: false,
    state: { ...nextState }
  }
}

export function clearSessionEventGuard(sessionId: string): void {
  _sessionEventGuards.delete(sessionId)
}

export function resetSessionEventGuardsForTests(): void {
  _sessionEventGuards.clear()
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface SessionRuntimeStoreState {
  /** Per-session runtime state. */
  sessions: Map<string, SessionRuntimeState>
  /** Per-session HITL interrupt queue (unified: question/permission/approval/plan). */
  interruptQueues: Map<string, InterruptItem[]>
  /** Per-session pending message queue (Phase 5 — composer state machine). */
  pendingMessages: Map<string, PendingMessage[]>
}

interface SessionRuntimeStoreActions {
  // Session state
  getSession(sessionId: string): SessionRuntimeState
  setLifecycle(sessionId: string, lifecycle: SessionLifecycle): void
  setRetryInfo(
    sessionId: string,
    info: { attempt: number; message?: string; next?: number } | null
  ): void
  setInProgress(sessionId: string, value: boolean): void
  setCommandsAvailable(sessionId: string, value: boolean): void
  touchActivity(sessionId: string): void

  // Unread
  incrementUnread(sessionId: string): void
  clearUnread(sessionId: string): void

  // Interrupt queue
  pushInterrupt(sessionId: string, item: Omit<InterruptItem, 'timestamp'>): void
  removeInterrupt(sessionId: string, id: string): void
  getInterruptQueue(sessionId: string): InterruptItem[]
  getFirstInterrupt(sessionId: string): InterruptItem | null
  getInterruptsByType(sessionId: string, type: InterruptType): InterruptItem[]
  clearSessionInterrupts(sessionId: string): void

  // Per-session event dispatch (for SessionView streaming)
  subscribeToSessionEvents(sessionId: string, cb: EventCallback): () => void
  dispatchToSession(sessionId: string, event: CanonicalAgentEvent): void

  // Pending message queue (Phase 5 — composer state machine)
  queueMessage(sessionId: string, message: PendingMessage): void
  dequeueMessage(sessionId: string): PendingMessage | null
  getPendingMessages(sessionId: string): PendingMessage[]
  getPendingCount(sessionId: string): number
  clearPendingMessages(sessionId: string): void

  // Cleanup
  clearSession(sessionId: string): void
}

export type SessionRuntimeStore = SessionRuntimeStoreState & SessionRuntimeStoreActions

// Stable singletons — returning these from selectors avoids creating new
// references on every call, which would cause useSyncExternalStore (#185) loops.
const EMPTY_INTERRUPT_QUEUE: readonly InterruptItem[] = []
const EMPTY_PENDING_MESSAGES: readonly PendingMessage[] = []

function ensureSession(
  sessions: Map<string, SessionRuntimeState>,
  sessionId: string
): SessionRuntimeState {
  return sessions.get(sessionId) ?? DEFAULT_SESSION_STATE
}

export const useSessionRuntimeStore = create<SessionRuntimeStore>()((set, get) => ({
  // -- State --
  sessions: new Map(),
  interruptQueues: new Map(),
  pendingMessages: new Map(),

  // -- Session state --
  getSession(sessionId) {
    return ensureSession(get().sessions, sessionId)
  },

  setLifecycle(sessionId, lifecycle) {
    set((state) => {
      const sessions = new Map(state.sessions)
      const existing = ensureSession(sessions, sessionId)
      sessions.set(sessionId, {
        ...existing,
        lifecycle,
        inProgress: lifecycle === 'busy' || lifecycle === 'retry',
        lastActivityAt: Date.now()
      })
      return { sessions }
    })
  },

  setRetryInfo(sessionId, info) {
    set((state) => {
      const sessions = new Map(state.sessions)
      const existing = ensureSession(sessions, sessionId)
      sessions.set(sessionId, { ...existing, retryInfo: info })
      return { sessions }
    })
  },

  setInProgress(sessionId, value) {
    set((state) => {
      const sessions = new Map(state.sessions)
      const existing = ensureSession(sessions, sessionId)
      sessions.set(sessionId, { ...existing, inProgress: value })
      return { sessions }
    })
  },

  setCommandsAvailable(sessionId, value) {
    set((state) => {
      const sessions = new Map(state.sessions)
      const existing = ensureSession(sessions, sessionId)
      sessions.set(sessionId, { ...existing, commandsAvailable: value })
      return { sessions }
    })
  },

  touchActivity(sessionId) {
    set((state) => {
      const sessions = new Map(state.sessions)
      const existing = ensureSession(sessions, sessionId)
      sessions.set(sessionId, { ...existing, lastActivityAt: Date.now() })
      return { sessions }
    })
  },

  // -- Unread --
  incrementUnread(sessionId) {
    set((state) => {
      const sessions = new Map(state.sessions)
      const existing = ensureSession(sessions, sessionId)
      sessions.set(sessionId, {
        ...existing,
        unreadCount: existing.unreadCount + 1
      })
      return { sessions }
    })
  },

  clearUnread(sessionId) {
    set((state) => {
      const sessions = new Map(state.sessions)
      const existing = ensureSession(sessions, sessionId)
      if (existing.unreadCount === 0) return state
      sessions.set(sessionId, { ...existing, unreadCount: 0 })
      return { sessions }
    })
  },

  // -- Interrupt queue --
  pushInterrupt(sessionId, item) {
    set((state) => {
      const queues = new Map(state.interruptQueues)
      const queue = [...(queues.get(sessionId) ?? [])]
      // Deduplicate by id
      if (queue.some((q) => q.id === item.id)) return state
      queue.push({ ...item, timestamp: Date.now() })
      queues.set(sessionId, queue)
      return { interruptQueues: queues }
    })
  },

  removeInterrupt(sessionId, id) {
    set((state) => {
      const queues = new Map(state.interruptQueues)
      const queue = queues.get(sessionId)
      if (!queue) return state
      const filtered = queue.filter((item) => item.id !== id)
      if (filtered.length === queue.length) return state
      if (filtered.length === 0) {
        queues.delete(sessionId)
      } else {
        queues.set(sessionId, filtered)
      }
      return { interruptQueues: queues }
    })
  },

  getInterruptQueue(sessionId) {
    return get().interruptQueues.get(sessionId) ?? EMPTY_INTERRUPT_QUEUE
  },

  getFirstInterrupt(sessionId) {
    const queue = get().interruptQueues.get(sessionId)
    return queue?.[0] ?? null
  },

  getInterruptsByType(sessionId, type) {
    const queue = get().interruptQueues.get(sessionId) ?? []
    return queue.filter((item) => item.type === type)
  },

  clearSessionInterrupts(sessionId) {
    set((state) => {
      const queues = new Map(state.interruptQueues)
      if (!queues.has(sessionId)) return state
      queues.delete(sessionId)
      return { interruptQueues: queues }
    })
  },

  // -- Per-session event dispatch --
  subscribeToSessionEvents(sessionId, cb) {
    let callbackSet = _sessionEventCallbacks.get(sessionId)
    if (!callbackSet) {
      callbackSet = new Set()
      _sessionEventCallbacks.set(sessionId, callbackSet)
    }
    callbackSet.add(cb)
    return () => {
      const s = _sessionEventCallbacks.get(sessionId)
      if (s) {
        s.delete(cb)
        if (s.size === 0) _sessionEventCallbacks.delete(sessionId)
      }
    }
  },

  dispatchToSession(sessionId, event) {
    const callbacks = _sessionEventCallbacks.get(sessionId)
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(event)
        } catch (e) {
          console.error('[SessionRuntimeStore] callback error:', e)
        }
      }
    }
  },

  // -- Pending message queue (Phase 5) --
  queueMessage(sessionId, message) {
    set((state) => {
      const pending = new Map(state.pendingMessages)
      const queue = [...(pending.get(sessionId) ?? [])]
      queue.push(message)
      pending.set(sessionId, queue)
      return { pendingMessages: pending }
    })
  },

  dequeueMessage(sessionId) {
    // P1-5 CR fix: read-then-write inside the set() updater to avoid TOCTOU race
    let first: PendingMessage | null = null
    set((state) => {
      const queue = state.pendingMessages.get(sessionId)
      if (!queue || queue.length === 0) return state
      const [head, ...rest] = queue
      first = head
      const pending = new Map(state.pendingMessages)
      if (rest.length === 0) {
        pending.delete(sessionId)
      } else {
        pending.set(sessionId, rest)
      }
      return { pendingMessages: pending }
    })
    return first
  },

  getPendingMessages(sessionId) {
    return get().pendingMessages.get(sessionId) ?? EMPTY_PENDING_MESSAGES
  },

  getPendingCount(sessionId) {
    return get().pendingMessages.get(sessionId)?.length ?? 0
  },

  clearPendingMessages(sessionId) {
    set((state) => {
      const pending = new Map(state.pendingMessages)
      if (!pending.has(sessionId)) return state
      pending.delete(sessionId)
      return { pendingMessages: pending }
    })
  },

  // -- Cleanup --
  clearSession(sessionId) {
    set((state) => {
      const sessions = new Map(state.sessions)
      const queues = new Map(state.interruptQueues)
      const pending = new Map(state.pendingMessages)
      sessions.delete(sessionId)
      queues.delete(sessionId)
      pending.delete(sessionId)
      return { sessions, interruptQueues: queues, pendingMessages: pending }
    })
    _sessionEventCallbacks.delete(sessionId)
    _streamingBuffers.delete(sessionId)
    _sessionEventGuards.delete(sessionId)
  }
}))
