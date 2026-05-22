/**
 * Session Send Actions — Phase 5
 *
 * Pure state-machine logic for the composer. Given session lifecycle,
 * interrupt state, and connection status, determines which actions are
 * available and provides an orchestrator to execute them.
 *
 * Three-state model:
 *   idle       → Send
 *   busy       → Queue / Steer / Stop+Send
 *   interrupt  → Reply to interrupt
 */

import type { SessionLifecycle, PendingMessage } from '@/stores/useSessionRuntimeStore'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Actions the composer can perform */
export type ComposerAction = 'send' | 'queue' | 'steer' | 'stop_and_send' | 'reply_interrupt'

/** Input state used to derive available actions (pure — no store reference) */
export interface ComposerInput {
  lifecycle: SessionLifecycle
  hasInterrupt: boolean
  hasPendingMessages: boolean
  hasDraftContent: boolean
  hasAttachments?: boolean
  isConnected: boolean
  supportsSteer?: boolean
  preferSteerWhenBusy?: boolean
}

/** Result of the state-machine evaluation */
export interface ComposerActionSet {
  /** Primary action for the send button */
  primary: ComposerAction | null
  /** Available alternative actions (e.g. shown in a dropdown) */
  alternatives: ComposerAction[]
  /** Whether the text input should accept typing */
  inputEnabled: boolean
  /** Label for the primary action button */
  primaryLabel: string
  /** Icon hint for rendering */
  iconHint: 'send' | 'stop' | 'queue' | 'steer' | 'reply' | 'disabled'
}

// ---------------------------------------------------------------------------
// State machine — pure function, zero side-effects
// ---------------------------------------------------------------------------

/**
 * Determine what the composer can do right now.
 *
 * Priority order:
 *   1. Not connected → disabled
 *   2. Interrupt pending → reply mode
 *   3. idle / error → send
 *   4. busy / materializing →
 *      - empty input: stop+send (primary)
 *      - draft content: queue (primary) by default, or steer (primary)
 *        when the runtime prefers steering busy turns and the draft has no
 *        attachments.
 *   5. retry → queue (primary), stop+send (alt)
 */
export function determineComposerActions(input: ComposerInput): ComposerActionSet {
  const {
    lifecycle,
    hasInterrupt,
    hasPendingMessages,
    hasDraftContent,
    hasAttachments = false,
    isConnected,
    supportsSteer = false,
    preferSteerWhenBusy = false
  } = input

  // 1. Not connected
  if (!isConnected) {
    return {
      primary: null,
      alternatives: [],
      inputEnabled: false,
      primaryLabel: 'Disconnected',
      iconHint: 'disabled'
    }
  }

  // 2. Interrupt pending takes priority
  if (hasInterrupt) {
    return {
      primary: 'reply_interrupt',
      alternatives: [],
      inputEnabled: true,
      primaryLabel: 'Reply',
      iconHint: 'reply'
    }
  }

  // 3-5. Lifecycle-based
  switch (lifecycle) {
    case 'idle':
    case 'error':
      return {
        primary: 'send',
        alternatives: [],
        inputEnabled: true,
        primaryLabel: hasPendingMessages ? 'Send (queued)' : 'Send',
        iconHint: 'send'
      }

    case 'busy':
    case 'materializing':
      if (hasDraftContent) {
        const preferSteer = preferSteerWhenBusy && supportsSteer && !hasAttachments
        return {
          primary: preferSteer ? 'steer' : 'queue',
          alternatives: preferSteer
            ? ['queue', 'stop_and_send']
            : supportsSteer
              ? ['steer', 'stop_and_send']
              : ['stop_and_send'],
          inputEnabled: true,
          primaryLabel: preferSteer ? 'Steer' : 'Queue',
          iconHint: preferSteer ? 'steer' : 'queue'
        }
      }
      return {
        primary: 'stop_and_send',
        alternatives: supportsSteer ? ['queue', 'steer'] : ['queue'],
        inputEnabled: true,
        primaryLabel: 'Stop',
        iconHint: 'stop'
      }

    case 'retry':
      return {
        primary: 'queue',
        alternatives: ['stop_and_send'],
        inputEnabled: true,
        primaryLabel: 'Queue',
        iconHint: 'queue'
      }
  }
}

// ---------------------------------------------------------------------------
// Action labels (for dropdown / tooltip)
// ---------------------------------------------------------------------------

const ACTION_LABELS: Record<ComposerAction, string> = {
  send: 'Send',
  queue: 'Queue for later',
  steer: 'Steer (redirect agent)',
  stop_and_send: 'Stop & Send',
  reply_interrupt: 'Reply'
}

export function getActionLabel(action: ComposerAction): string {
  return ACTION_LABELS[action]
}

// ---------------------------------------------------------------------------
// Pending message factory
// ---------------------------------------------------------------------------

let _nextPendingId = 1

export function createPendingMessage(
  content: string,
  attachments: Array<{
    kind: string
    id: string
    name: string
    mime: string
    [k: string]: unknown
  }> = [],
  options: Pick<PendingMessage, 'runtimeId' | 'agentSessionId' | 'promptOptions' | 'model'> = {}
): PendingMessage {
  return {
    id: `pending-${_nextPendingId++}`,
    content,
    attachments,
    queuedAt: Date.now(),
    status: 'pending',
    runtimeId: options.runtimeId,
    agentSessionId: options.agentSessionId,
    promptOptions: options.promptOptions,
    model: options.model
  }
}

/** Reset the ID counter (for tests only) */
export function _resetPendingIdCounter(): void {
  _nextPendingId = 1
}

// ---------------------------------------------------------------------------
// Action executor context
// ---------------------------------------------------------------------------

/**
 * External dependencies injected into the executor so that
 * session-send-actions stays a pure-logic module with no global imports.
 */
export interface SendContext {
  worktreePath: string
  /** Agent session id used for prompt/abort/steer IPC calls. */
  sessionId: string
  /** Optional store/session id used for queued-message bookkeeping. */
  queueSessionId?: string
  /** IPC: send a prompt to the agent */
  prompt: (
    worktreePath: string,
    sessionId: string,
    content: string
  ) => Promise<{ success: boolean; error?: string }>
  /** IPC: steer the active turn */
  steer?: (
    worktreePath: string,
    sessionId: string,
    content: string
  ) => Promise<{ success: boolean; error?: string }>
  /** IPC: abort the current agent run */
  abort: (worktreePath: string, sessionId: string) => Promise<{ success: boolean; error?: string }>
  /** Optional wait gate used after abort so the next prompt lands on a clean turn boundary. */
  waitForAbortReady?: () => Promise<void>
  /** Runtime used to persist durable queued-message metadata. */
  runtimeId?: PendingMessage['runtimeId']
  /** Prompt options captured when the user queued the message. */
  promptOptions?: PendingMessage['promptOptions']
  /** Model captured when the user queued the message. */
  model?: PendingMessage['model']
  /** Store: enqueue a pending message */
  queueMessage: (sessionId: string, message: PendingMessage) => void
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

/**
 * Execute a composer action.
 *
 * @returns `true` if the content was consumed (sent or queued) and
 *          the composer input should be cleared; `false` otherwise.
 */
export async function executeSendAction(
  action: ComposerAction,
  content: string,
  attachments: Array<{
    kind: string
    id: string
    name: string
    mime: string
    [k: string]: unknown
  }>,
  ctx: SendContext
): Promise<boolean> {
  const ensureSuccess = async (
    op: Promise<{ success: boolean; error?: string }>,
    fallbackMessage: string
  ): Promise<void> => {
    const result = await op
    if (!result.success) {
      throw new Error(result.error || fallbackMessage)
    }
  }

  switch (action) {
    case 'send': {
      await ensureSuccess(
        ctx.prompt(ctx.worktreePath, ctx.sessionId, content),
        'Failed to send message'
      )
      return true
    }

    case 'queue': {
      const msg = createPendingMessage(content, attachments, {
        runtimeId: ctx.runtimeId,
        agentSessionId: ctx.sessionId,
        promptOptions: ctx.promptOptions,
        model: ctx.model
      })
      ctx.queueMessage(ctx.queueSessionId ?? ctx.sessionId, msg)
      return true
    }

    case 'steer': {
      if (!ctx.steer) {
        throw new Error('Steer is not available for this session')
      }

      if (attachments.length > 0) {
        throw new Error('Steer only supports text messages')
      }

      await ensureSuccess(
        ctx.steer(ctx.worktreePath, ctx.sessionId, content),
        'Failed to steer active turn'
      )
      return true
    }

    case 'stop_and_send': {
      await ensureSuccess(ctx.abort(ctx.worktreePath, ctx.sessionId), 'Failed to stop active turn')
      await ctx.waitForAbortReady?.()
      await ensureSuccess(
        ctx.prompt(ctx.worktreePath, ctx.sessionId, content),
        'Failed to send message after stopping active turn'
      )
      return true
    }

    case 'reply_interrupt': {
      // The interrupt dock handles the structured reply; the composer just
      // sends the free-text content as a regular prompt.
      await ensureSuccess(
        ctx.prompt(ctx.worktreePath, ctx.sessionId, content),
        'Failed to reply to interrupt'
      )
      return true
    }
  }
}

// ---------------------------------------------------------------------------
// Pending queue drain — call when lifecycle transitions busy → idle
// ---------------------------------------------------------------------------

/**
 * Pop the next pending message from the queue and send it.
 *
 * @param storeSessionId  DB-level session ID (used as key for the pending queue in the store)
 * @param agentSessionId  Agent-level session ID (used for the IPC prompt call)
 * @returns `true` if a message was drained, `false` if the queue was empty.
 */
export async function drainNextPending(
  storeSessionId: string,
  agentSessionId: string,
  dequeue: (sessionId: string) => PendingMessage | null,
  prompt: (
    worktreePath: string,
    sessionId: string,
    message: PendingMessage
  ) => Promise<{ success: boolean; error?: string }>,
  worktreePath: string,
  requeueFront?: (sessionId: string, message: PendingMessage) => void,
  complete?: (sessionId: string, message: PendingMessage) => void
): Promise<boolean> {
  const next = dequeue(storeSessionId)
  if (!next) return false
  try {
    const result = await prompt(worktreePath, agentSessionId, next)
    if (!result.success) {
      throw new Error(result.error || 'Failed to drain pending message')
    }
    complete?.(storeSessionId, next)
  } catch (error) {
    requeueFront?.(storeSessionId, next)
    throw error
  }
  return true
}

export interface PendingDrainController {
  drainNextPending(
    storeSessionId: string,
    agentSessionId: string,
    dequeue: (sessionId: string) => PendingMessage | null,
    prompt: (
      worktreePath: string,
      sessionId: string,
      message: PendingMessage
    ) => Promise<{ success: boolean; error?: string }>,
    worktreePath: string,
    requeueFront?: (sessionId: string, message: PendingMessage) => void,
    complete?: (sessionId: string, message: PendingMessage) => void
  ): Promise<boolean>
}

export function createPendingDrainController(): PendingDrainController {
  const inFlightSessions = new Set<string>()

  return {
    async drainNextPending(
      storeSessionId: string,
      agentSessionId: string,
      dequeue: (sessionId: string) => PendingMessage | null,
      prompt: (
        worktreePath: string,
        sessionId: string,
        message: PendingMessage
      ) => Promise<{ success: boolean; error?: string }>,
      worktreePath: string,
      requeueFront?: (sessionId: string, message: PendingMessage) => void,
      complete?: (sessionId: string, message: PendingMessage) => void
    ): Promise<boolean> {
      if (inFlightSessions.has(storeSessionId)) return false
      inFlightSessions.add(storeSessionId)
      try {
        return await drainNextPending(
          storeSessionId,
          agentSessionId,
          dequeue,
          prompt,
          worktreePath,
          requeueFront,
          complete
        )
      } finally {
        inFlightSessions.delete(storeSessionId)
      }
    }
  }
}
