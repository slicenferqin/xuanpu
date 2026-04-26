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
 *    Mobile-originated `prompt` is dispatched directly to the runtime — there
 *    is no desktop confirmation gate (the IM-style flow). Auth happens at the
 *    websocket layer; users opt out via the Hub master switch.
 *
 * 4. The bridge is intentionally framework-agnostic for tests: pass a
 *    `HubRegistry` in. In production, `createHubBridge` wires the real
 *    Electron `ipcMain`/BrowserWindow.
 */

import type { BrowserWindow, WebContents } from 'electron'
import type { CanonicalAgentEvent } from '../../../shared/types/agent-protocol'
import type { AgentRuntimeManager } from '../agent-runtime-manager'
import type { AgentRuntimeAdapter } from '../agent-runtime-types'
import type {
  TimelineMessage,
  StreamingPart,
  ToolUseInfo
} from '../../../shared/lib/timeline-types'
import { getSessionTimeline } from '../session-timeline-service'
import { stripInjectedContextEnvelope } from '../../../shared/lib/timeline-mappers'
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

export interface HubBridgeOptions {
  registry: HubRegistry
  runtimeManager: AgentRuntimeManager
  /**
   * Fallback routing resolver used when the bridge has no explicit
   * `registerSessionRouting()` entry for an incoming `hiveSessionId`. Lets
   * the Hub light up for any desktop-opened session without requiring every
   * session creation site to call into the hub. Returning `null` keeps the
   * old behavior (`SESSION_NOT_FOUND`).
   */
  routingResolver?: (
    hiveSessionId: string
  ) =>
    | { worktreePath: string; agentSessionId: string; runtimeId?: AgentRuntimeAdapter['id'] }
    | null
    | Promise<
        | { worktreePath: string; agentSessionId: string; runtimeId?: AgentRuntimeAdapter['id'] }
        | null
      >
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
  private readonly routingResolver: (
    hiveSessionId: string
  ) =>
    | { worktreePath: string; agentSessionId: string; runtimeId?: AgentRuntimeAdapter['id'] }
    | null
    | Promise<
        | { worktreePath: string; agentSessionId: string; runtimeId?: AgentRuntimeAdapter['id'] }
        | null
      >
  private readonly primaryRuntimeId: AgentRuntimeAdapter['id']
  private readonly now: () => number
  /** worktreePath per hive session — needed to call runtime methods. */
  private readonly worktreePaths = new Map<string, string>()
  /** agent-session-id per hive session. */
  private readonly agentSessionIds = new Map<string, string>()
  /**
   * Runtime id per hive session — set when routingResolver returns one.
   * Defaults to `primaryRuntimeId` when missing. Lets a single hub bridge
   * route inbound prompts to whichever runtime owns each session
   * (claude-code / codex / opencode), rather than hard-coding one.
   */
  private readonly runtimeIds = new Map<string, AgentRuntimeAdapter['id']>()
  /**
   * Active streaming assistant message per hive session. Used by the bridge
   * to coalesce many `message.part.updated` events into a single HubMessage
   * bubble on the mobile UI. Cleared on `message.updated` / `session.idle`,
   * so the NEXT assistant turn opens a new bubble.
   */
  private readonly streamingMsgs = new Map<
    string,
    { hubMsgId: string; partIdx: Map<string, number>; nextPartIdx: number }
  >()
  /**
   * Last emit timestamp (ms) per `${sessionId}:${noticeCategory}`. Lets us
   * throttle high-frequency notices like `context_usage` so mobile doesn't get
   * a notice every assistant tick.
   */
  private readonly noticeLastEmit = new Map<string, number>()

  constructor(opts: HubBridgeOptions) {
    this.registry = opts.registry
    this.runtimeManager = opts.runtimeManager
    this.routingResolver = opts.routingResolver ?? (() => null)
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
    this.runtimeIds.delete(hiveSessionId)
  }

  /**
   * Pull recent durable messages for a session out of SQLite and translate
   * them into HubMessages so the mobile UI can show prior turns the moment a
   * phone reconnects. Falls back to `[]` on any error — the live stream still
   * works.
   *
   * `limit` counts text-bearing messages (real user/assistant turns) rather
   * than raw timeline rows. Codex `commandExecution` activities are merged
   * into the timeline as synthetic tool-only assistant rows
   * (`mergeCodexActivityMessages` in timeline-mappers.ts), and previously a
   * naive `slice(-N)` could fill the entire window with those — leaving the
   * mobile snapshot showing only command cards and no conversation text.
   * Counting by text content keeps both real turns and the tool cards that
   * came with them.
   */
  getHistorySnapshot(hiveSessionId: string, limit = 30): HubMessage[] {
    try {
      const result = getSessionTimeline(hiveSessionId)
      const messages = result.messages
      let startIdx = 0
      let textCount = 0
      for (let i = messages.length - 1; i >= 0; i--) {
        if (hasRenderableText(messages[i])) {
          textCount += 1
          if (textCount >= limit) {
            startIdx = i
            break
          }
        }
      }
      const tail = messages.slice(startIdx)
      return tail
        .map((m, idx) => translateTimelineMessage(m, idx))
        .filter((m): m is HubMessage => m !== null)
    } catch (err) {
      log.warn('getHistorySnapshot failed', {
        hiveSessionId,
        error: err instanceof Error ? err.message : String(err)
      })
      return []
    }
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
    // Allow events from any runtime through. Earlier code filtered to
    // primaryRuntimeId only — that broke any hub session whose underlying
    // runtime wasn't claude-code (codex/opencode emit the same canonical
    // protocol so the translator handles them uniformly).
    this.translateAndBroadcast(envelope)
  }

  private translateAndBroadcast(ev: CanonicalAgentEvent): void {
    const deviceId = this.registry.localDeviceId
    const hiveSessionId = ev.sessionId
    const frames = this.translate(ev)
    const subCount = this.registry.subscriberCount(deviceId, hiveSessionId)
    log.info('bridge: outbound', {
      evType: ev.type,
      hiveSessionId,
      deviceId,
      frameCount: frames?.length ?? 0,
      subscribers: subCount
    })
    if (!frames) return
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
        // An assistant turn is "done" when the session goes idle. Clearing
        // the streaming buffer here (and ONLY here) guarantees each turn
        // stays coalesced into one bubble, while the next turn opens a
        // fresh one. `message.updated` fires on every usage refresh from
        // the Claude SDK so it is NOT a reliable turn boundary.
        if (status === 'idle') this.streamingMsgs.delete(ev.sessionId)
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
      case 'message.part.updated': {
        // Coalesce part updates into a single live "assistant" HubMessage per
        // session — first event opens the bubble via `message/append`, every
        // subsequent text delta becomes an `appendText` op, every tool update
        // becomes `replacePart` (status flips from running → completed/error).
        // When a tool reaches a terminal state (completed/error/cancelled)
        // and has output, we additionally emit a sibling `tool_result` part
        // so the mobile client renders the actual command output / patch
        // result, not just the "done" indicator. Result on the mobile UI:
        // one IM-style bubble that streams in place.
        const d = ev.data as { part?: Record<string, unknown>; delta?: string }
        const rawPart = d.part
        if (!rawPart || typeof rawPart !== 'object') return []
        const pType = (rawPart as { type?: unknown }).type
        let partKey: string
        let initialPart: HubPart
        let textDelta: string | null = null
        let toolResultEmit: {
          partKey: string
          part: HubPart
        } | null = null

        if (pType === 'text' || pType === 'reasoning') {
          partKey = pType
          textDelta =
            typeof d.delta === 'string'
              ? d.delta
              : typeof (rawPart as { text?: unknown }).text === 'string'
                ? ((rawPart as { text: string }).text)
                : ''
          if (!textDelta) return []
          initialPart = { type: 'text', text: textDelta }
        } else if (pType === 'tool') {
          const tool = rawPart as {
            callID?: string
            tool?: string
            state?: {
              input?: unknown
              status?: string
              output?: unknown
              error?: unknown
              result?: unknown
            }
          }
          const callId = tool.callID ?? ev.eventId
          partKey = `tool:${callId}`
          const status = tool.state?.status
          // PR41 used isDone (completed|error). PR42 widened to include
          // cancelled, which is the right terminal set: a cancelled tool
          // should also stop showing as pending and emit whatever partial
          // output it accumulated.
          const isTerminal =
            status === 'completed' || status === 'error' || status === 'cancelled'
          initialPart = {
            type: 'tool_use',
            toolUseId: callId,
            name: tool.tool ?? 'tool',
            input: tool.state?.input,
            pending: !isTerminal
          }

          // On terminal transition, queue a separate tool_result part with the
          // actual output / error. PR41 used to inline output on the tool_use
          // itself (output / isError fields); PR42 split this out so mobile
          // clients receive the standard tool_use → tool_result pair, with
          // 4KB truncation to save bandwidth.
          if (isTerminal) {
            const output = tool.state?.output
            const errorVal = tool.state?.error
            const result = tool.state?.result
            const truncatedOutput =
              typeof output === 'string' && output.length > 4096
                ? output.slice(0, 4096) + `\n…[truncated ${output.length - 4096} bytes]…`
                : output
            const isError = status === 'error' || tool.state?.error !== undefined
            const hasPayload =
              truncatedOutput !== undefined ||
              errorVal !== undefined ||
              result !== undefined
            if (hasPayload) {
              toolResultEmit = {
                partKey: `tool-result:${callId}`,
                part: {
                  type: 'tool_result',
                  toolUseId: callId,
                  output:
                    truncatedOutput !== undefined
                      ? truncatedOutput
                      : (result ?? errorVal),
                  isError
                }
              }
            }
          }
        } else {
          // Unknown part shape (e.g. compaction). Drop quietly.
          return []
        }

        const sessionId = ev.sessionId
        let stream = this.streamingMsgs.get(sessionId)
        const out: ServerMsg[] = []

        if (!stream) {
          // Open a new assistant bubble seeded with this first part.
          const hubMsgId = `mb-${sessionId}-${this.now()}-${Math.random()
            .toString(36)
            .slice(2, 6)}`
          stream = {
            hubMsgId,
            partIdx: new Map([[partKey, 0]]),
            nextPartIdx: 1
          }
          this.streamingMsgs.set(sessionId, stream)
          const message: HubMessage = {
            id: hubMsgId,
            role: 'assistant',
            ts: this.now(),
            seq: 0,
            parts: [initialPart]
          }
          out.push({ type: 'message/append', seq: 0, message })
        } else {
          const existingIdx = stream.partIdx.get(partKey)
          if (existingIdx !== undefined) {
            if (textDelta !== null) {
              // Append the new chunk to the live text part — mobile UI grows
              // the same bubble in place.
              out.push({
                type: 'message/update',
                seq: 0,
                messageId: stream.hubMsgId,
                patch: { op: 'appendText', partIdx: existingIdx, value: textDelta }
              })
            } else {
              // Tool status update — replace the whole part (so pending → done
              // and `input`/`output` get refreshed).
              out.push({
                type: 'message/update',
                seq: 0,
                messageId: stream.hubMsgId,
                patch: { op: 'replacePart', partIdx: existingIdx, value: initialPart }
              })
            }
          } else {
            // First time this partKey appears in the current bubble — append it.
            stream.partIdx.set(partKey, stream.nextPartIdx)
            stream.nextPartIdx += 1
            out.push({
              type: 'message/update',
              seq: 0,
              messageId: stream.hubMsgId,
              patch: { op: 'appendPart', value: initialPart }
            })
          }
        }

        // Append the tool_result sibling part on terminal transition (once
        // per callId; subsequent terminal updates won't re-append).
        if (toolResultEmit && stream && !stream.partIdx.has(toolResultEmit.partKey)) {
          stream.partIdx.set(toolResultEmit.partKey, stream.nextPartIdx)
          stream.nextPartIdx += 1
          out.push({
            type: 'message/update',
            seq: 0,
            messageId: stream.hubMsgId,
            patch: { op: 'appendPart', value: toolResultEmit.part }
          })
        }

        return out
      }
      case 'session.error': {
        const text = pickEventText(ev.data, '会话出错')
        return [makeNotice('error', 'session_error', text)]
      }
      case 'session.warning': {
        const text = pickEventText(ev.data, '会话警告')
        return [makeNotice('warn', 'session_warning', text)]
      }
      case 'session.context_compacted': {
        return [makeNotice('info', 'context_compacted', '上下文已压缩')]
      }
      case 'session.compaction_started': {
        return [makeNotice('info', 'compaction_started', '正在压缩上下文…')]
      }
      case 'session.context_usage': {
        // High-frequency event — throttle to one per 10s per session so the
        // mobile UI doesn't get a flood of notices during a busy turn.
        const key = `${ev.sessionId}:context_usage`
        const last = this.noticeLastEmit.get(key) ?? 0
        const now = this.now()
        if (now - last < 10_000) return []
        this.noticeLastEmit.set(key, now)
        const text = pickEventText(ev.data, '上下文用量更新')
        return [makeNotice('info', 'context_usage', text, ev.data)]
      }
      case 'plan.ready': {
        const d = ev.data as { requestId?: string; planText?: string; plan?: string; id?: string }
        const requestId = d.requestId ?? d.id ?? ev.eventId
        const planText = typeof d.planText === 'string' ? d.planText : (d.plan ?? '')
        return [{ type: 'plan/request', seq: 0, requestId, planText }]
      }
      case 'command.approval_needed': {
        const d = ev.data as {
          requestId?: string
          id?: string
          command?: string
          cwd?: string
          reason?: string
        }
        return [
          {
            type: 'command_approval/request',
            seq: 0,
            requestId: d.requestId ?? d.id ?? ev.eventId,
            command: d.command ?? '',
            cwd: d.cwd,
            reason: d.reason
          }
        ]
      }
      case 'message.updated':
      case 'session.idle':
      case 'session.materialized':
      case 'session.updated':
      case 'session.commands_available':
      case 'session.model_limits':
      case 'session.turn_diff':
      case 'permission.replied':
      case 'question.replied':
      case 'question.rejected':
      case 'command.approval_replied':
      case 'command.approval_problem':
      case 'plan.resolved': {
        // Metadata / lifecycle events with no user-visible content. Status
        // is already pushed via the dedicated `status` frame, plan/command
        // approval results land via the dedicated *.respond client frames.
        return []
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

    const routing = await this.getRouting(hiveSessionId)
    if (!routing && msg.type !== 'resume') {
      this.emitError(ws, 'SESSION_NOT_FOUND', `no routing for ${hiveSessionId}`)
      return
    }

    const runtime = this.runtimeManager.getImplementer(
      routing?.runtimeId ?? this.primaryRuntimeId
    )

    switch (msg.type) {
      case 'prompt': {
        if (!routing) return
        // IM-style flow: no desktop-side confirmation gate. Mobile sends,
        // we hand straight to the runtime. Authentication on the WS already
        // happened upstream; per-prompt confirm has been removed.
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
      case 'plan/respond': {
        if (!routing) return
        // claude-code adapter ships these methods but they aren't on the
        // generic AgentRuntimeAdapter contract — cast structurally.
        const claude = runtime as unknown as {
          planApprove?: (
            worktreePath: string,
            hiveSessionId: string,
            requestId?: string
          ) => Promise<void>
          planReject?: (
            worktreePath: string,
            hiveSessionId: string,
            requestId?: string,
            feedback?: string
          ) => Promise<void>
        }
        if (msg.decision === 'approve') {
          await claude.planApprove?.(routing.worktreePath, hiveSessionId, msg.requestId)
        } else {
          await claude.planReject?.(
            routing.worktreePath,
            hiveSessionId,
            msg.requestId,
            msg.feedback
          )
        }
        return
      }
      case 'command_approval/respond': {
        if (!routing) return
        const claude = runtime as unknown as {
          commandApprovalReply?: (
            worktreePath: string,
            requestId: string,
            decision: 'approve_once' | 'approve_always' | 'reject',
            message?: string
          ) => Promise<void>
        }
        await claude.commandApprovalReply?.(
          routing.worktreePath,
          msg.requestId,
          msg.decision,
          msg.message
        )
        return
      }
    }
  }

  private async getRouting(
    hiveSessionId: string
  ): Promise<{
    worktreePath: string
    agentSessionId: string
    runtimeId: AgentRuntimeAdapter['id']
  } | null> {
    const worktreePath = this.worktreePaths.get(hiveSessionId)
    const agentSessionId = this.agentSessionIds.get(hiveSessionId)
    if (worktreePath && agentSessionId) {
      const runtimeId = this.runtimeIds.get(hiveSessionId) ?? this.primaryRuntimeId
      return { worktreePath, agentSessionId, runtimeId }
    }
    // Fallback: ask the runtime directly. Cache the answer so subsequent
    // messages for the same session don't pay the lookup cost, and so that
    // `forgetSession()` still works as the cleanup hook. The resolver may
    // return a Promise — e.g. the production resolver in hub-controller falls
    // back to a SQLite + reconnect() path for sessions the desktop hasn't
    // materialized yet.
    const resolved = await this.routingResolver(hiveSessionId)
    if (resolved) {
      this.worktreePaths.set(hiveSessionId, resolved.worktreePath)
      this.agentSessionIds.set(hiveSessionId, resolved.agentSessionId)
      const runtimeId = resolved.runtimeId ?? this.primaryRuntimeId
      this.runtimeIds.set(hiveSessionId, runtimeId)
      return {
        worktreePath: resolved.worktreePath,
        agentSessionId: resolved.agentSessionId,
        runtimeId
      }
    }
    return null
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

function pickEventText(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    for (const key of ['message', 'text', 'reason', 'summary']) {
      const v = d[key]
      if (typeof v === 'string' && v.length > 0) return v
    }
  }
  return fallback
}

function makeNotice(
  level: 'info' | 'warn' | 'error',
  category: string,
  text: string,
  data?: unknown
): ServerMsg {
  return { type: 'system/notice', seq: 0, level, category, text, data }
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

// ─── Timeline → HubMessage translation ─────────────────────────────────────

function hasRenderableText(msg: TimelineMessage): boolean {
  if (typeof msg.content === 'string' && msg.content.trim() !== '') return true
  if (msg.parts) {
    for (const p of msg.parts) {
      if (p.type === 'text' && typeof p.text === 'string' && p.text.trim() !== '') return true
      if (p.type === 'reasoning' && typeof p.reasoning === 'string' && p.reasoning.trim() !== '')
        return true
    }
  }
  return false
}

function translateStreamingPart(p: StreamingPart): HubPart | null {
  switch (p.type) {
    case 'text': {
      const text = typeof p.text === 'string' ? p.text : ''
      if (!text) return null
      return { type: 'text', text }
    }
    case 'reasoning': {
      // Mobile has no dedicated reasoning type — render as plain text so
      // the user at least sees Claude's prior thinking in the bubble.
      const text = typeof p.reasoning === 'string' ? p.reasoning : p.text ?? ''
      if (!text) return null
      return { type: 'text', text }
    }
    case 'tool_use': {
      const t: ToolUseInfo | undefined = p.toolUse
      if (!t) return null
      return {
        type: 'tool_use',
        toolUseId: t.id,
        name: t.name,
        input: t.input,
        pending: t.status === 'pending' || t.status === 'running'
      }
    }
    // subtask / step_start / step_finish / compaction — skip in M1 so the
    // mobile timeline stays readable. We can surface them later as chips.
    default:
      return null
  }
}

// Mirror desktop chat UI: strip `<task-notification>…</task-notification>`
// blocks from rendered text. Kept inline because content-sanitizer lives under
// src/renderer which main can't import. Keep in sync with
// src/renderer/src/lib/content-sanitizer.ts.
const TASK_NOTIFICATION_RE = /<task-notification>\s*([\s\S]*?)\s*<\/task-notification>/gi
function stripTaskNotifications(s: string): string {
  return s.replace(TASK_NOTIFICATION_RE, '').trim()
}

function sanitizeText(role: 'user' | 'assistant' | 'system', text: string): string {
  let out = text
  if (role === 'user') out = stripInjectedContextEnvelope(out)
  out = stripTaskNotifications(out)
  return out
}

function translateTimelineMessage(msg: TimelineMessage, idx: number): HubMessage | null {
  // Desktop UI hides system role entirely (AgentTimeline.tsx).
  if (msg.role === 'system') return null
  const role = msg.role === 'user' ? 'user' : 'assistant'

  let parts: HubPart[] = []
  if (msg.parts && msg.parts.length > 0) {
    parts = msg.parts
      .map(translateStreamingPart)
      .filter((p): p is HubPart => p !== null)
      .map((p) => {
        if (p.type === 'text') {
          const cleaned = sanitizeText(role, p.text)
          return cleaned ? { ...p, text: cleaned } : null
        }
        return p
      })
      .filter((p): p is HubPart => p !== null)
  }
  const cleanedContent =
    typeof msg.content === 'string' && msg.content.trim() !== ''
      ? sanitizeText(role, msg.content)
      : ''

  // Timeline rows can legitimately contain tool-only structured parts while
  // the human-readable assistant conclusion lives only in flattened `content`.
  // If we rendered structured parts alone, mobile history would show just the
  // command/tool cards and hide the actual reply text. Append the fallback
  // text when no structured text part survived translation.
  const hasRenderableTextPart = parts.some((p) => p.type === 'text' && p.text.trim() !== '')

  // Fall back to the flattened content text when the message has no
  // structured parts (e.g. legacy rows).
  if (parts.length === 0 && cleanedContent) {
    parts = [{ type: 'text', text: cleanedContent }]
  } else if (!hasRenderableTextPart && cleanedContent) {
    parts = [...parts, { type: 'text', text: cleanedContent }]
  }
  if (parts.length === 0) return null
  const ts = (() => {
    const n = Date.parse(msg.timestamp)
    return Number.isFinite(n) ? n : 0
  })()
  return {
    id: msg.id,
    role,
    ts,
    // seq monotonically orders history within the snapshot. Live frames
    // continue from the registry's own counter; snapshot replaces state
    // on the client so there's no collision risk.
    seq: idx,
    parts
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export interface CreateHubBridgeDeps {
  registry: HubRegistry
  runtimeManager: AgentRuntimeManager
  routingResolver?: (
    hiveSessionId: string
  ) =>
    | { worktreePath: string; agentSessionId: string; runtimeId?: AgentRuntimeAdapter['id'] }
    | null
    | Promise<
        | { worktreePath: string; agentSessionId: string; runtimeId?: AgentRuntimeAdapter['id'] }
        | null
      >
}

export function createHubBridge(deps: CreateHubBridgeDeps): HubBridge {
  return new HubBridge(deps)
}
