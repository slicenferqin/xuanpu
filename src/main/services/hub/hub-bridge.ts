/**
 * hub-bridge: zero-intrusion fan-out from the existing agent runtime IPC to
 * hub-registry subscribers (mobile websockets).
 *
 * Design:
 *
 * 1. `wrapWebContents(real, bridge)` returns a proxy that mirrors the methods
 *    `emitAgentEvent()` uses (`send`, `id`, `isDestroyed`). The real renderer
 *    still receives every event; we additionally feed them into the bridge
 *    so claude-code / codex / opencode implementers stay UNTOUCHED.
 *
 * 2. The bridge routes incoming `agent:stream` envelopes (CanonicalAgentEvent)
 *    to a HubRegistry session keyed by `(localDeviceId, hiveSessionId)`, using
 *    a best-effort translation to the agent-agnostic `ServerMsg` protocol. We
 *    deliberately keep the translation lossy-but-lossless: anything we don't
 *    model yet is wrapped as a HubMessage with a single `UnknownPart{ raw }`,
 *    so the mobile client can render the raw payload and we never drop data.
 *
 * 3. Reverse path (ClientMsg → runtime) lives in `handleClientMessage`.
 *    `prompt` goes through `requestPromptConfirmation()` which talks to the
 *    desktop window over IPC `hub:prompt-confirm-request`; on approval we call
 *    `runtime.prompt(...)`. A 30s timeout yields ServerMsg error
 *    `CONFIRM_TIMEOUT`.
 *
 * 4. The bridge is intentionally framework-agnostic for tests: pass a
 *    `PromptConfirmer` and `HubRegistry` in. In production, `createHubBridge`
 *    wires the real Electron `ipcMain`/BrowserWindow.
 */

import type { BrowserWindow, WebContents } from 'electron'
import type { CanonicalAgentEvent } from '../../../shared/types/agent-protocol'
import type { AgentRuntimeManager } from '../agent-runtime-manager'
import type { AgentRuntimeAdapter } from '../agent-runtime-types'
import { HubRegistry, type HubSubscriber } from './hub-registry'
import {
  type ClientMsg,
  type HubMessage,
  type HubPart,
  type ServerMsg,
  type HubSessionStatus,
  type HubErrorCode,
  ClientMsgSchema
} from './hub-protocol'
import { createLogger } from '../logger'

const log = createLogger({ component: 'HubBridge' })

export const AGENT_STREAM_CHANNEL = 'agent:stream'
export const CONFIRM_TIMEOUT_MS = 30_000

export interface PromptConfirmer {
  /**
   * Ask the desktop user to approve a mobile-originated prompt. Resolves with
   * `{ approved: true }` or `{ approved: false, reason? }`. Rejects on
   * timeout — the bridge treats rejection as CONFIRM_TIMEOUT.
   */
  confirm(req: {
    confirmId: string
    hiveSessionId: string
    preview: string
  }): Promise<{ approved: boolean; reason?: string }>
}

export interface HubBridgeOptions {
  registry: HubRegistry
  runtimeManager: AgentRuntimeManager
  confirmer: PromptConfirmer
  /** Override for tests. */
  now?: () => number
  /** Defaults to 'claude-code' (M1 only supports Claude). */
  primaryRuntimeId?: AgentRuntimeAdapter['id']
}

// ─── webContents shim ──────────────────────────────────────────────────────

/**
 * The subset of Electron `WebContents` that `emitAgentEvent` touches. Kept
 * narrow so tests don't need a real BrowserWindow.
 */
export interface WebContentsLike {
  id?: number
  isDestroyed?(): boolean
  send(channel: string, ...args: unknown[]): void
}

export interface BrowserWindowLike {
  isDestroyed(): boolean
  webContents: WebContentsLike
}

/**
 * Wrap a real BrowserWindow so that every `webContents.send(channel, ...args)`
 * also funnels into the hub bridge. Everything else is passed through via a
 * plain prototype clone — we only intercept `webContents.send`.
 */
export function wrapBrowserWindow(
  real: BrowserWindow,
  bridge: HubBridge
): BrowserWindow {
  const originalWc = real.webContents as unknown as WebContentsLike
  const wrappedWc: WebContentsLike = {
    get id() {
      return (originalWc as WebContents).id
    },
    isDestroyed: () => {
      return originalWc.isDestroyed?.() ?? false
    },
    send: (channel: string, ...args: unknown[]) => {
      try {
        originalWc.send(channel, ...args)
      } catch (err) {
        log.warn('wrapped webContents.send threw', {
          channel,
          error: err instanceof Error ? err.message : String(err)
        })
      }
      try {
        bridge.onIpcEvent(channel, args)
      } catch (err) {
        log.warn('bridge.onIpcEvent threw', {
          channel,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  }

  // Build a proxy that forwards all methods to `real` except `webContents`.
  return new Proxy(real, {
    get(target, prop: string | symbol) {
      if (prop === 'webContents') return wrappedWc
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const value = (target as any)[prop]
      if (typeof value === 'function') return value.bind(target)
      return value
    }
  }) as BrowserWindow
}

// ─── Bridge ─────────────────────────────────────────────────────────────────

export class HubBridge {
  private readonly registry: HubRegistry
  private readonly runtimeManager: AgentRuntimeManager
  private readonly confirmer: PromptConfirmer
  private readonly primaryRuntimeId: AgentRuntimeAdapter['id']
  private readonly now: () => number
  /** worktreePath per hive session — needed to call runtime methods. */
  private readonly worktreePaths = new Map<string, string>()
  /** agent-session-id per hive session. */
  private readonly agentSessionIds = new Map<string, string>()

  constructor(opts: HubBridgeOptions) {
    this.registry = opts.registry
    this.runtimeManager = opts.runtimeManager
    this.confirmer = opts.confirmer
    this.primaryRuntimeId = opts.primaryRuntimeId ?? 'claude-code'
    this.now = opts.now ?? Date.now
  }

  /**
   * Tell the bridge how to resolve a hive session back to `(worktreePath,
   * agentSessionId)`. Called by the hub-server or IPC handler layer when a
   * session becomes known (e.g. on WS subscribe).
   */
  registerSessionRouting(
    hiveSessionId: string,
    worktreePath: string,
    agentSessionId: string
  ): void {
    this.worktreePaths.set(hiveSessionId, worktreePath)
    this.agentSessionIds.set(hiveSessionId, agentSessionId)
  }

  /** Inverse of `registerSessionRouting`. */
  forgetSession(hiveSessionId: string): void {
    this.worktreePaths.delete(hiveSessionId)
    this.agentSessionIds.delete(hiveSessionId)
  }

  // ── outbound (runtime → mobile) ──────────────────────────────────────────

  /**
   * Called by the webContents shim for every IPC event. We only care about
   * `agent:stream`; everything else is ignored.
   */
  onIpcEvent(channel: string, args: unknown[]): void {
    if (channel !== AGENT_STREAM_CHANNEL) return
    const envelope = args[0] as CanonicalAgentEvent | undefined
    if (!envelope || typeof envelope !== 'object') return
    if (envelope.runtimeId && envelope.runtimeId !== this.primaryRuntimeId) {
      // M1: claude-code only. Ignore other runtimes for now.
      return
    }
    this.translateAndBroadcast(envelope)
  }

  private translateAndBroadcast(ev: CanonicalAgentEvent): void {
    const deviceId = this.registry.localDeviceId
    const hiveSessionId = ev.sessionId
    const frames = this.translate(ev)
    for (const partial of frames) {
      const seq = this.registry.nextSeq(deviceId, hiveSessionId)
      const frame = { ...partial, seq } as ServerMsg
      this.registry.broadcast(deviceId, hiveSessionId, frame)
    }
  }

  /**
   * Translate a CanonicalAgentEvent into zero or more ServerMsg frames
   * *without* `seq` — the caller assigns seq in emit order. We type the
   * intermediate as `ServerMsg` with `seq:0`, which the discriminated union
   * accepts; the seq gets overwritten in `translateAndBroadcast`.
   */
  private translate(ev: CanonicalAgentEvent): ServerMsg[] {
    switch (ev.type) {
      case 'session.status': {
        const raw = ev.statusPayload ?? ev.data?.status
        const status = mapStatus(raw?.type)
        if (status === null) return []
        this.registry.setStatus(this.registry.localDeviceId, ev.sessionId, status)
        return [{ type: 'status', seq: 0, status }]
      }
      case 'permission.asked': {
        const d = ev.data
        return [
          {
            type: 'permission/request',
            seq: 0,
            requestId: d.id,
            toolName: (d.metadata?.tool as string | undefined) ?? d.permission,
            input: d.metadata,
            description: d.permission
          }
        ]
      }
      case 'question.asked': {
        const d = ev.data
        const questionText =
          typeof (d.questions?.[0] as { question?: unknown })?.question === 'string'
            ? ((d.questions[0] as { question: string }).question)
            : ''
        return [
          {
            type: 'question/request',
            seq: 0,
            requestId: d.requestId,
            question: questionText,
            options: undefined
          }
        ]
      }
      case 'message.updated':
      case 'message.part.updated':
      case 'session.materialized':
      case 'session.updated':
      case 'session.warning':
      case 'session.error':
      case 'session.idle':
      case 'session.context_compacted':
      case 'session.compaction_started':
      case 'session.commands_available':
      case 'session.model_limits':
      case 'session.context_usage':
      case 'permission.replied':
      case 'question.replied':
      case 'question.rejected':
      case 'command.approval_needed':
      case 'command.approval_replied':
      case 'command.approval_problem':
      case 'plan.ready':
      case 'plan.resolved': {
        // Generic fall-through: wrap raw event in a HubMessage with one
        // UnknownPart so the mobile UI can render it as "agent activity".
        const part: HubPart = { type: 'unknown', raw: ev }
        const message: HubMessage = {
          id: ev.eventId,
          role: 'assistant',
          ts: this.now(),
          seq: 0, // filled in by caller via frame.seq
          parts: [part]
        }
        return [{ type: 'message/append', seq: 0, message }]
      }
    }
  }

  // ── inbound (mobile → runtime) ───────────────────────────────────────────

  async handleClientMessage(
    ws: HubSubscriber,
    hiveSessionId: string,
    raw: unknown
  ): Promise<void> {
    let msg: ClientMsg
    try {
      msg = ClientMsgSchema.parse(raw)
    } catch (err) {
      this.emitError(ws, 'BAD_REQUEST', err instanceof Error ? err.message : 'invalid message')
      return
    }

    const routing = this.getRouting(hiveSessionId)
    if (!routing && msg.type !== 'resume') {
      this.emitError(ws, 'SESSION_NOT_FOUND', `no routing for ${hiveSessionId}`)
      return
    }

    const runtime = this.runtimeManager.getImplementer(this.primaryRuntimeId)

    switch (msg.type) {
      case 'prompt': {
        if (!routing) return
        const confirmId = `confirm-${this.now()}-${Math.random().toString(36).slice(2, 8)}`
        const timer: Promise<{ approved: boolean; reason?: string }> = new Promise(
          (_, reject) =>
            setTimeout(() => reject(new Error('CONFIRM_TIMEOUT')), CONFIRM_TIMEOUT_MS)
        )
        try {
          const result = await Promise.race([
            this.confirmer.confirm({
              confirmId,
              hiveSessionId,
              preview: msg.text
            }),
            timer
          ])
          if (!result.approved) {
            this.emitError(ws, 'BAD_REQUEST', result.reason ?? 'prompt rejected')
            return
          }
        } catch (err) {
          if (err instanceof Error && err.message === 'CONFIRM_TIMEOUT') {
            this.emitError(ws, 'CONFIRM_TIMEOUT', 'desktop confirmation timed out')
            return
          }
          throw err
        }
        await runtime.prompt(routing.worktreePath, routing.agentSessionId, msg.text)
        return
      }
      case 'interrupt': {
        if (!routing) return
        await runtime.abort(routing.worktreePath, routing.agentSessionId)
        return
      }
      case 'permission/respond': {
        if (!routing) return
        await runtime.permissionReply(
          msg.requestId,
          msg.decision,
          routing.worktreePath,
          msg.message
        )
        return
      }
      case 'question/respond': {
        if (!routing) return
        if (msg.answers.length === 0) {
          await runtime.questionReject(msg.requestId, routing.worktreePath)
        } else {
          await runtime.questionReply(msg.requestId, msg.answers, routing.worktreePath)
        }
        return
      }
      case 'resume': {
        const s = this.registry.getSession(this.registry.localDeviceId, hiveSessionId)
        if (!s) {
          this.emitError(ws, 'SESSION_NOT_FOUND', hiveSessionId)
          return
        }
        const replay = s.ringBuffer.replayAfter(msg.lastSeq)
        if (!replay.ok) {
          this.emitError(ws, 'NEED_FULL_RELOAD', 'gap evicted')
          return
        }
        for (const frame of replay.frames) ws.send(JSON.stringify(frame))
        return
      }
    }
  }

  private getRouting(
    hiveSessionId: string
  ): { worktreePath: string; agentSessionId: string } | null {
    const worktreePath = this.worktreePaths.get(hiveSessionId)
    const agentSessionId = this.agentSessionIds.get(hiveSessionId)
    if (!worktreePath || !agentSessionId) return null
    return { worktreePath, agentSessionId }
  }

  private emitError(ws: HubSubscriber, code: HubErrorCode, message?: string): void {
    const frame: ServerMsg = { type: 'error', code, message }
    try {
      ws.send(JSON.stringify(frame))
    } catch {
      /* ignore */
    }
  }
}

function mapStatus(raw: string | undefined): HubSessionStatus | null {
  switch (raw) {
    case 'idle':
    case 'busy':
    case 'retry':
    case 'error':
      return raw
    default:
      return null
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export interface CreateHubBridgeDeps {
  registry: HubRegistry
  runtimeManager: AgentRuntimeManager
  confirmer: PromptConfirmer
}

export function createHubBridge(deps: CreateHubBridgeDeps): HubBridge {
  return new HubBridge(deps)
}
