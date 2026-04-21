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
  activeRunEpoch: number
  lastAppliedSequence: number
  mirrorVersion: number
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
type StreamingBufferCallback = () => void
const _streamingBufferCallbacks = new Map<string, Set<StreamingBufferCallback>>()
const _pendingStreamingBufferFlushes = new Set<string>()
const _emptyStreamingBufferSnapshots = new Map<string, StreamingBuffer>()

function createStreamingBuffer(overrides?: Partial<StreamingBuffer>): StreamingBuffer {
  return {
    activeRunEpoch: 0,
    lastAppliedSequence: -1,
    mirrorVersion: 0,
    parts: [],
    childParts: new Map(),
    streamingContent: '',
    isStreaming: false,
    runStartedAt: undefined,
    compactionState: null,
    optimisticMessages: undefined,
    ...overrides
  }
}

function cloneStreamingBuffer(buffer: StreamingBuffer): StreamingBuffer {
  return {
    ...buffer,
    parts: [...buffer.parts],
    childParts: new Map(
      Array.from(buffer.childParts.entries(), ([childId, parts]) => [childId, [...parts]])
    ),
    optimisticMessages: buffer.optimisticMessages ? [...buffer.optimisticMessages] : undefined
  }
}

function getEmptyStreamingBufferSnapshot(sessionId: string): StreamingBuffer {
  const existing = _emptyStreamingBufferSnapshots.get(sessionId)
  if (existing) return existing

  const next = createStreamingBuffer()
  _emptyStreamingBufferSnapshots.set(sessionId, next)
  return next
}

function resetStreamingBufferOverlayState(
  current: StreamingBuffer,
  options?: { preserveOptimisticMessages?: boolean; preserveCompactionState?: boolean }
): StreamingBuffer {
  return createStreamingBuffer({
    activeRunEpoch: current.activeRunEpoch,
    lastAppliedSequence: current.lastAppliedSequence,
    mirrorVersion: current.mirrorVersion,
    optimisticMessages: options?.preserveOptimisticMessages ? current.optimisticMessages : undefined,
    compactionState: options?.preserveCompactionState ? current.compactionState : null
  })
}

function notifyStreamingBufferSubscribers(sessionId: string): void {
  const callbacks = _streamingBufferCallbacks.get(sessionId)
  if (!callbacks) return
  for (const cb of callbacks) {
    try {
      cb()
    } catch (error) {
      console.error('[SessionRuntimeStore] streaming buffer callback error:', error)
    }
  }
}

function flushStreamingBufferVersion(sessionId: string): void {
  const current = _streamingBuffers.get(sessionId)
  if (!current) return
  _streamingBuffers.set(sessionId, {
    ...current,
    mirrorVersion: current.mirrorVersion + 1
  })
  notifyStreamingBufferSubscribers(sessionId)
}

function scheduleStreamingBufferFlush(sessionId: string): void {
  if (_pendingStreamingBufferFlushes.has(sessionId)) return
  _pendingStreamingBufferFlushes.add(sessionId)
  const schedule =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0)

  schedule(() => {
    _pendingStreamingBufferFlushes.delete(sessionId)
    flushStreamingBufferVersion(sessionId)
  })
}

function mapPartStatus(
  value: unknown
): 'pending' | 'running' | 'success' | 'error' {
  if (value === 'pending' || value === 'running') return value
  if (value === 'completed' || value === 'success') return 'success'
  if (value === 'error') return 'error'
  return 'running'
}

export function getStreamingBuffer(sessionId: string): StreamingBuffer | undefined {
  const buffer = _streamingBuffers.get(sessionId)
  return buffer ? cloneStreamingBuffer(buffer) : undefined
}

export function setStreamingBuffer(sessionId: string, buffer: StreamingBuffer): void {
  _streamingBuffers.set(sessionId, cloneStreamingBuffer(buffer))
  _emptyStreamingBufferSnapshots.delete(sessionId)
}

export function clearStreamingBuffer(sessionId: string): void {
  _streamingBuffers.delete(sessionId)
  _pendingStreamingBufferFlushes.delete(sessionId)
  notifyStreamingBufferSubscribers(sessionId)
}

export function resetStreamingBuffersForTests(): void {
  _streamingBuffers.clear()
  _pendingStreamingBufferFlushes.clear()
  _emptyStreamingBufferSnapshots.clear()
  _streamingBufferCallbacks.clear()
}

export function subscribeToStreamingBuffer(sessionId: string, cb: StreamingBufferCallback): () => void {
  let callbackSet = _streamingBufferCallbacks.get(sessionId)
  if (!callbackSet) {
    callbackSet = new Set()
    _streamingBufferCallbacks.set(sessionId, callbackSet)
  }
  callbackSet.add(cb)
  return () => {
    const setForSession = _streamingBufferCallbacks.get(sessionId)
    if (!setForSession) return
    setForSession.delete(cb)
    if (setForSession.size === 0) {
      _streamingBufferCallbacks.delete(sessionId)
    }
  }
}

export function getStreamingBufferSnapshot(sessionId: string): StreamingBuffer {
  return _streamingBuffers.get(sessionId) ?? getEmptyStreamingBufferSnapshot(sessionId)
}

export function updateStreamingBuffer(
  sessionId: string,
  updater: (current: StreamingBuffer) => StreamingBuffer,
  options?: { notify?: 'none' | 'frame' | 'immediate' }
): StreamingBuffer {
  const current = _streamingBuffers.get(sessionId) ?? createStreamingBuffer()
  const next = updater(current)

  if (next === current) {
    return getStreamingBufferSnapshot(sessionId)
  }

  _streamingBuffers.set(sessionId, next)
  _emptyStreamingBufferSnapshots.delete(sessionId)

  const notifyMode = options?.notify ?? 'frame'
  if (notifyMode === 'immediate') {
    flushStreamingBufferVersion(sessionId)
  } else if (notifyMode === 'frame') {
    scheduleStreamingBufferFlush(sessionId)
  }

  return getStreamingBufferSnapshot(sessionId)
}

export function clearStreamingBufferOverlay(
  sessionId: string,
  options?: {
    notify?: 'none' | 'frame' | 'immediate'
    preserveOptimisticMessages?: boolean
    preserveCompactionState?: boolean
  }
): StreamingBuffer {
  return updateStreamingBuffer(
    sessionId,
    (current) => {
      if (!_streamingBuffers.has(sessionId)) {
        return current
      }

      return resetStreamingBufferOverlayState(current, {
        preserveOptimisticMessages: options?.preserveOptimisticMessages,
        preserveCompactionState: options?.preserveCompactionState
      })
    },
    { notify: options?.notify ?? 'immediate' }
  )
}

export function syncStreamingBufferGuardState(
  sessionId: string,
  state: SessionEventGuardState,
  options?: { resetOverlay?: boolean; notify?: 'none' | 'frame' | 'immediate' }
): StreamingBuffer {
  return updateStreamingBuffer(
    sessionId,
    (current) =>
      options?.resetOverlay
        ? {
            ...resetStreamingBufferOverlayState(current, {
              preserveOptimisticMessages: true,
              preserveCompactionState: true
            }),
            activeRunEpoch: state.activeRunEpoch,
            lastAppliedSequence: state.lastAppliedSequence
          }
        : {
            ...current,
            activeRunEpoch: state.activeRunEpoch,
            lastAppliedSequence: state.lastAppliedSequence
          },
    { notify: options?.notify ?? 'none' }
  )
}

export function writeEventToStreamingBuffer(
  sessionId: string,
  event: CanonicalAgentEvent,
  options?: { activeSessionId?: string | null }
): StreamingBuffer {
  // activeSessionId used to gate inactive-session idle cleanup; no longer
  // needed now that idle keeps parts intact. Kept in the signature for
  // backwards compat with callers that still supply it.
  void options

  return updateStreamingBuffer(
    sessionId,
    (current) => {
      if (event.type === 'message.part.updated') {
        const partData = event.data as Record<string, unknown> | undefined
        const part = partData?.part as Record<string, unknown> | undefined
        if (!part) return current

        if (event.childSessionId) {
          const nextChildParts = new Map(current.childParts)
          const existing = [...(nextChildParts.get(event.childSessionId) ?? [])]

          if (part.type === 'text') {
            const delta = (partData?.delta as string) ?? (part.text as string) ?? ''
            if (!delta) return current
            const last = existing[existing.length - 1]
            if (last?.type === 'text') {
              existing[existing.length - 1] = { ...last, text: (last.text ?? '') + delta }
            } else {
              existing.push({ type: 'text', text: delta })
            }
          } else if (part.type === 'tool') {
            const toolId =
              (part.callID as string) || (part.id as string) || `child-tool-${Date.now()}`
            const toolName = (part.tool as string) || 'unknown'
            const state = (part.state as Record<string, unknown>) || {}
            const stateTime = state.time as Record<string, number> | undefined
            const idx = existing.findIndex((p) => p.type === 'tool_use' && p.toolUse?.id === toolId)
            // Merge with the previous part instead of overwriting it. Some
            // updates only carry status/output/time and would otherwise wipe
            // already-streamed input (e.g. the bash command shown on the card).
            const previous = idx >= 0 ? existing[idx]?.toolUse : undefined
            const nextStatus = mapPartStatus(state.status)
            const toolPart: StreamingPart = {
              type: 'tool_use',
              toolUse: {
                id: toolId,
                name: toolName !== 'unknown' ? toolName : previous?.name ?? toolName,
                input: (state.input as Record<string, unknown>) ?? previous?.input ?? {},
                status: nextStatus,
                startTime: stateTime?.start || previous?.startTime || Date.now(),
                endTime: stateTime?.end ?? previous?.endTime,
                output:
                  nextStatus === 'success' || nextStatus === 'error'
                    ? (state.output as string) ?? previous?.output
                    : previous?.output,
                error:
                  nextStatus === 'error'
                    ? (state.error as string) ?? previous?.error
                    : previous?.error
              }
            }
            if (idx >= 0) {
              existing[idx] = toolPart
            } else {
              existing.push(toolPart)
            }
          } else {
            return current
          }

          nextChildParts.set(event.childSessionId, existing)
          return {
            ...current,
            childParts: nextChildParts,
            isStreaming: true
          }
        }

        if (part.type === 'text') {
          const delta = (partData?.delta as string) ?? (part.text as string) ?? ''
          if (!delta) return current

          const nextParts = [...current.parts]
          const last = nextParts[nextParts.length - 1]
          if (last?.type === 'text') {
            nextParts[nextParts.length - 1] = {
              ...last,
              text: (last.text ?? '') + delta
            }
          } else {
            nextParts.push({ type: 'text', text: delta })
          }

          return {
            ...current,
            parts: nextParts,
            streamingContent: current.streamingContent + delta,
            isStreaming: true
          }
        }

        if (part.type === 'tool') {
          const toolId = (part.callID as string) || (part.id as string) || `tool-${Date.now()}`
          const toolName = (part.tool as string) || 'unknown'
          const state = (part.state as Record<string, unknown>) || {}
          const stateTime = state.time as Record<string, number> | undefined
          const nextParts = [...current.parts]
          const idx = nextParts.findIndex((p) => p.type === 'tool_use' && p.toolUse?.id === toolId)
          // Merge with the previous part rather than rebuild from this update
          // alone — partial updates (e.g. status -> success without input,
          // tool_progress with status only) would otherwise wipe already-
          // streamed fields like the command/input.
          const previous = idx >= 0 ? nextParts[idx]?.toolUse : undefined
          const nextStatus = mapPartStatus(state.status)
          const toolPart: StreamingPart = {
            type: 'tool_use',
            toolUse: {
              id: toolId,
              name: toolName !== 'unknown' ? toolName : previous?.name ?? toolName,
              input: (state.input as Record<string, unknown>) ?? previous?.input ?? {},
              status: nextStatus,
              startTime: stateTime?.start || previous?.startTime || Date.now(),
              endTime: stateTime?.end ?? previous?.endTime,
              output:
                nextStatus === 'success' || nextStatus === 'error'
                  ? (state.output as string) ?? previous?.output
                  : previous?.output,
              error:
                nextStatus === 'error'
                  ? (state.error as string) ?? previous?.error
                  : previous?.error
            }
          }

          if (idx >= 0) {
            nextParts[idx] = toolPart
          } else {
            nextParts.push(toolPart)
          }

          return {
            ...current,
            parts: nextParts,
            isStreaming: true
          }
        }

        if (part.type === 'reasoning') {
          const delta = (partData?.delta as string) ?? (part.text as string) ?? ''
          if (!delta) return current
          const nextParts = [...current.parts]
          const last = nextParts[nextParts.length - 1]
          if (last?.type === 'reasoning') {
            nextParts[nextParts.length - 1] = {
              ...last,
              reasoning: (last.reasoning ?? '') + delta
            }
          } else {
            nextParts.push({ type: 'reasoning', reasoning: delta })
          }
          return {
            ...current,
            parts: nextParts,
            isStreaming: true
          }
        }

        if (part.type === 'subtask') {
          return {
            ...current,
            parts: [
              ...current.parts,
              {
                type: 'subtask',
                subtask: {
                  id: (part.id as string) || `subtask-${Date.now()}`,
                  sessionID: (part.sessionID as string) || '',
                  prompt: (part.prompt as string) || '',
                  description: (part.description as string) || '',
                  agent: (part.agent as string) || 'unknown',
                  parts: [],
                  status: 'running'
                }
              }
            ],
            isStreaming: true
          }
        }

        return current
      }

      if (event.type === 'session.status') {
        const statusType =
          (event.statusPayload as { type?: string } | undefined)?.type ??
          ((event.data as Record<string, unknown> | undefined)?.status as { type?: string } | undefined)
            ?.type

        if (statusType === 'busy' || statusType === 'materializing') {
          return {
            ...current,
            isStreaming: true,
            runStartedAt: current.runStartedAt ?? Date.now()
          }
        }

        if (statusType === 'retry') {
          return {
            ...current,
            runStartedAt: undefined
          }
        }

        if (statusType === 'idle') {
          // Keep `parts` intact regardless of whether this session is the
          // active view. Before, inactive sessions had their overlay wiped
          // the moment their turn ended — so switching away mid-turn and
          // back would show an empty (or near-empty) transcript until the
          // next user message. The next send calls resetLiveOverlay(true)
          // to clear, so there's no need to do it here.
          return {
            ...current,
            isStreaming: false,
            runStartedAt: undefined
          }
        }

        return current
      }

      if (event.type === 'session.compaction_started') {
        return {
          ...current,
          compactionState: {
            phase: 'running',
            timestamp: Date.now()
          }
        }
      }

      if (event.type === 'session.context_compacted') {
        return {
          ...current,
          compactionState: {
            phase: 'completed',
            timestamp: Date.now()
          }
        }
      }

      if (event.type === 'session.error') {
        return {
          ...current,
          runStartedAt: undefined
        }
      }

      return current
    },
    { notify: 'frame' }
  )
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
  requeueMessageFront(sessionId: string, message: PendingMessage): void
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

function syncQueuedState(sessionId: string, queued: boolean): void {
  if (typeof window === 'undefined' || !window.systemOps?.setSessionQueuedState) {
    return
  }

  window.systemOps.setSessionQueuedState(sessionId, queued).catch((error) => {
    console.warn('[SessionRuntimeStore] Failed to sync queued state', {
      sessionId,
      queued,
      error
    })
  })
}

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
    syncQueuedState(sessionId, true)
  },

  dequeueMessage(sessionId) {
    // P1-5 CR fix: read-then-write inside the set() updater to avoid TOCTOU race
    let first: PendingMessage | null = null
    let stillQueued = false
    set((state) => {
      const queue = state.pendingMessages.get(sessionId)
      if (!queue || queue.length === 0) return state
      const [head, ...rest] = queue
      first = head
      stillQueued = rest.length > 0
      const pending = new Map(state.pendingMessages)
      if (rest.length === 0) {
        pending.delete(sessionId)
      } else {
        pending.set(sessionId, rest)
      }
      return { pendingMessages: pending }
    })
    if (first) {
      syncQueuedState(sessionId, stillQueued)
    }
    return first
  },

  requeueMessageFront(sessionId, message) {
    set((state) => {
      const pending = new Map(state.pendingMessages)
      const queue = [...(pending.get(sessionId) ?? [])]
      pending.set(sessionId, [message, ...queue])
      return { pendingMessages: pending }
    })
  },

  getPendingMessages(sessionId) {
    return get().pendingMessages.get(sessionId) ?? EMPTY_PENDING_MESSAGES
  },

  getPendingCount(sessionId) {
    return get().pendingMessages.get(sessionId)?.length ?? 0
  },

  clearPendingMessages(sessionId) {
    let changed = false
    set((state) => {
      const pending = new Map(state.pendingMessages)
      if (!pending.has(sessionId)) return state
      changed = true
      pending.delete(sessionId)
      return { pendingMessages: pending }
    })
    if (changed) {
      syncQueuedState(sessionId, false)
    }
  },

  // -- Cleanup --
  clearSession(sessionId) {
    const hadPending = get().pendingMessages.has(sessionId)
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
    _emptyStreamingBufferSnapshots.delete(sessionId)
    _pendingStreamingBufferFlushes.delete(sessionId)
    _sessionEventGuards.delete(sessionId)
    if (hadPending) {
      syncQueuedState(sessionId, false)
    }
  }
}))
