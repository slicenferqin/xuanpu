/**
 * Wire protocol for the Xuanpu Hub websocket bridge (M1).
 *
 * Versioned with PROTOCOL_VERSION; bump when an incompatible change ships.
 *
 * Direction:
 *   ServerMsg   — main → mobile
 *   ClientMsg   — mobile → main
 *
 * The renderer/mobile UIs deal in **HubMessage** — a flattened, agent-agnostic
 * shape so we can layer claude-code / codex / opencode behind the same view.
 * Unknown parts preserve their raw payload via `UnknownPart.raw` so we never
 * drop data we don't yet model.
 *
 * Reconnect: every server-emitted frame carries a monotonic `seq` per session.
 * The mobile client remembers `lastSeq`, on reconnect sends `resume{lastSeq}`,
 * and we replay from a per-session ring buffer. If the buffer rolled over we
 * answer with `error{code:'NEED_FULL_RELOAD'}` and the client refetches via
 * `/api/sessions/:hiveId/history`.
 */

import { z } from 'zod'

export const PROTOCOL_VERSION = 1

// ─── Error codes ────────────────────────────────────────────────────────────

export const HUB_ERROR_CODES = [
  'AUTH_REQUIRED',
  'DEVICE_OFFLINE',
  'SESSION_NOT_FOUND',
  'NEED_FULL_RELOAD',
  'RATE_LIMITED',
  'BAD_REQUEST',
  'INTERNAL'
] as const

export type HubErrorCode = (typeof HUB_ERROR_CODES)[number]

export const HubErrorCodeSchema = z.enum(HUB_ERROR_CODES)

// ─── HubMessage parts ───────────────────────────────────────────────────────

export const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string()
})

export const ToolUsePartSchema = z.object({
  type: z.literal('tool_use'),
  toolUseId: z.string(),
  name: z.string(),
  input: z.unknown().optional(),
  /** When set, the tool call is still streaming. */
  pending: z.boolean().optional(),
  /** Final output payload, set once the tool transitions to completed/error. */
  output: z.unknown().optional(),
  /** True when the runtime reported tool error. */
  isError: z.boolean().optional()
})

export const ToolResultPartSchema = z.object({
  type: z.literal('tool_result'),
  toolUseId: z.string(),
  output: z.unknown().optional(),
  isError: z.boolean().optional()
})

export const DiffPartSchema = z.object({
  type: z.literal('diff'),
  filePath: z.string(),
  patch: z.string()
})

export const UnknownPartSchema = z.object({
  type: z.literal('unknown'),
  /** Original event payload from the agent runtime. Keeps forward-compat. */
  raw: z.unknown()
})

export const HubPartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ToolUsePartSchema,
  ToolResultPartSchema,
  DiffPartSchema,
  UnknownPartSchema
])

export type TextPart = z.infer<typeof TextPartSchema>
export type ToolUsePart = z.infer<typeof ToolUsePartSchema>
export type ToolResultPart = z.infer<typeof ToolResultPartSchema>
export type DiffPart = z.infer<typeof DiffPartSchema>
export type UnknownPart = z.infer<typeof UnknownPartSchema>
export type HubPart = z.infer<typeof HubPartSchema>

// ─── HubMessage ─────────────────────────────────────────────────────────────

export const HubMessageRoleSchema = z.enum(['user', 'assistant', 'system'])
export type HubMessageRole = z.infer<typeof HubMessageRoleSchema>

export const HubMessageSchema = z.object({
  id: z.string(),
  role: HubMessageRoleSchema,
  /** Unix epoch milliseconds. */
  ts: z.number().int().nonnegative(),
  /** Monotonic per-session sequence assigned when the message first appears. */
  seq: z.number().int().nonnegative(),
  parts: z.array(HubPartSchema)
})
export type HubMessage = z.infer<typeof HubMessageSchema>

export const HubSessionStatusSchema = z.enum(['idle', 'busy', 'retry', 'error'])
export type HubSessionStatus = z.infer<typeof HubSessionStatusSchema>

// ─── ServerMsg (main → mobile) ──────────────────────────────────────────────

const baseServerMeta = {
  /** Monotonic per-session sequence. Always increases by 1 per emitted frame. */
  seq: z.number().int().nonnegative()
}

export const SnapshotMsgSchema = z.object({
  type: z.literal('session/snapshot'),
  ...baseServerMeta,
  status: HubSessionStatusSchema,
  messages: z.array(HubMessageSchema),
  /** Last seq carried by `messages` (or 0 if empty). Convenience for clients. */
  lastSeq: z.number().int().nonnegative()
})

export const MessageAppendMsgSchema = z.object({
  type: z.literal('message/append'),
  ...baseServerMeta,
  message: HubMessageSchema
})

/**
 * Patch ops are intentionally NOT JSON Patch — we use named ops so both ends
 * stay narrowly typed and forward-compatible.
 */
export const MessageUpdateOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('appendText'),
    /** Index into `parts` — must point at a TextPart. */
    partIdx: z.number().int().nonnegative(),
    value: z.string()
  }),
  z.object({
    op: z.literal('replacePart'),
    partIdx: z.number().int().nonnegative(),
    value: HubPartSchema
  }),
  z.object({
    op: z.literal('appendPart'),
    value: HubPartSchema
  })
])
export type MessageUpdateOp = z.infer<typeof MessageUpdateOpSchema>

export const MessageUpdateMsgSchema = z.object({
  type: z.literal('message/update'),
  ...baseServerMeta,
  messageId: z.string(),
  patch: MessageUpdateOpSchema
})

export const PermissionRequestMsgSchema = z.object({
  type: z.literal('permission/request'),
  ...baseServerMeta,
  requestId: z.string(),
  toolName: z.string(),
  input: z.unknown().optional(),
  description: z.string().optional()
})

export const QuestionRequestMsgSchema = z.object({
  type: z.literal('question/request'),
  ...baseServerMeta,
  requestId: z.string(),
  question: z.string(),
  options: z.array(z.string()).optional()
})

export const StatusMsgSchema = z.object({
  type: z.literal('status'),
  ...baseServerMeta,
  status: HubSessionStatusSchema
})

/**
 * Out-of-band notice from the runtime that doesn't belong on the message
 * timeline (e.g. context-usage update, compaction notice, transient warning).
 * Mobile can render these as a top status bar / toast.
 */
export const SystemNoticeMsgSchema = z.object({
  type: z.literal('system/notice'),
  ...baseServerMeta,
  level: z.enum(['info', 'warn', 'error']),
  /** Stable category so the UI can deduplicate (e.g. 'context_usage'). */
  category: z.string(),
  text: z.string(),
  /** Optional structured payload for richer rendering (kept opaque). */
  data: z.unknown().optional()
})

/**
 * `plan.ready` request awaiting mobile-side approve/reject. Mirrors the
 * desktop's `PlanReadyImplementFab` flow.
 */
export const PlanRequestMsgSchema = z.object({
  type: z.literal('plan/request'),
  ...baseServerMeta,
  requestId: z.string(),
  planText: z.string()
})

/**
 * Pre-execution approval gate for a shell command (e.g. `command.approval_needed`).
 * Mobile shows command + cwd and either approves once / always or rejects.
 */
export const CommandApprovalRequestMsgSchema = z.object({
  type: z.literal('command_approval/request'),
  ...baseServerMeta,
  requestId: z.string(),
  command: z.string(),
  cwd: z.string().optional(),
  reason: z.string().optional()
})

export const ErrorMsgSchema = z.object({
  type: z.literal('error'),
  /** Sequence is optional on errors — pre-resume errors have no session yet. */
  seq: z.number().int().nonnegative().optional(),
  code: HubErrorCodeSchema,
  message: z.string().optional()
})

export const ServerMsgSchema = z.discriminatedUnion('type', [
  SnapshotMsgSchema,
  MessageAppendMsgSchema,
  MessageUpdateMsgSchema,
  PermissionRequestMsgSchema,
  QuestionRequestMsgSchema,
  StatusMsgSchema,
  SystemNoticeMsgSchema,
  PlanRequestMsgSchema,
  CommandApprovalRequestMsgSchema,
  ErrorMsgSchema
])
export type ServerMsg = z.infer<typeof ServerMsgSchema>

// ─── ClientMsg (mobile → main) ──────────────────────────────────────────────

export const PromptClientMsgSchema = z.object({
  type: z.literal('prompt'),
  /** Echoed back so the client can correlate its optimistic message. */
  clientMsgId: z.string(),
  text: z.string()
})

export const InterruptClientMsgSchema = z.object({
  type: z.literal('interrupt')
})

export const PermissionRespondClientMsgSchema = z.object({
  type: z.literal('permission/respond'),
  requestId: z.string(),
  decision: z.enum(['once', 'always', 'reject']),
  message: z.string().optional()
})

export const QuestionRespondClientMsgSchema = z.object({
  type: z.literal('question/respond'),
  requestId: z.string(),
  /** Empty array means "reject". */
  answers: z.array(z.array(z.string()))
})

export const ResumeClientMsgSchema = z.object({
  type: z.literal('resume'),
  lastSeq: z.number().int().nonnegative()
})

export const PlanRespondClientMsgSchema = z.object({
  type: z.literal('plan/respond'),
  requestId: z.string(),
  decision: z.enum(['approve', 'reject']),
  feedback: z.string().optional()
})

export const CommandApprovalRespondClientMsgSchema = z.object({
  type: z.literal('command_approval/respond'),
  requestId: z.string(),
  decision: z.enum(['approve_once', 'approve_always', 'reject']),
  message: z.string().optional()
})

export const ClientMsgSchema = z.discriminatedUnion('type', [
  PromptClientMsgSchema,
  InterruptClientMsgSchema,
  PermissionRespondClientMsgSchema,
  QuestionRespondClientMsgSchema,
  ResumeClientMsgSchema,
  PlanRespondClientMsgSchema,
  CommandApprovalRespondClientMsgSchema
])
export type ClientMsg = z.infer<typeof ClientMsgSchema>

// ─── Ring buffer ────────────────────────────────────────────────────────────

export const DEFAULT_RING_BUFFER_CAPACITY = 500

export interface RingBufferReplayHit {
  ok: true
  frames: ServerMsg[]
}

export interface RingBufferReplayMiss {
  ok: false
  code: 'NEED_FULL_RELOAD'
}

export type RingBufferReplay = RingBufferReplayHit | RingBufferReplayMiss

/**
 * Per-session ring buffer of emitted ServerMsg frames, used to replay events
 * to a reconnecting client. Capacity defaults to 500 frames.
 *
 * Frames must be pushed in seq order. `replayAfter(lastSeq)` returns every
 * frame strictly newer than `lastSeq`; if that range has been evicted we
 * return `NEED_FULL_RELOAD` so the client can refetch via REST.
 */
export class MessageRingBuffer {
  private readonly capacity: number
  private buf: ServerMsg[] = []
  /** seq of the oldest retained frame (0 when empty). */
  private oldestSeq = 0
  /** seq of the newest retained frame (0 when empty). */
  private newestSeq = 0

  constructor(capacity: number = DEFAULT_RING_BUFFER_CAPACITY) {
    if (capacity <= 0) throw new Error('capacity must be > 0')
    this.capacity = capacity
  }

  push(frame: ServerMsg): void {
    // Errors without seq aren't replayable — ignore them in the buffer.
    if (frame.seq === undefined) return
    if (this.buf.length === 0) {
      this.oldestSeq = frame.seq
    }
    this.buf.push(frame)
    this.newestSeq = frame.seq
    while (this.buf.length > this.capacity) {
      this.buf.shift()
      this.oldestSeq = this.buf[0]?.seq ?? 0
    }
  }

  /** Returns frames with seq > lastSeq. */
  replayAfter(lastSeq: number): RingBufferReplay {
    if (this.buf.length === 0) {
      return { ok: true, frames: [] }
    }
    if (lastSeq >= this.newestSeq) {
      return { ok: true, frames: [] }
    }
    // We need anything strictly greater than lastSeq. If the oldest retained
    // frame is already > lastSeq + 1, we've evicted the gap and must full-reload.
    if (lastSeq + 1 < this.oldestSeq) {
      return { ok: false, code: 'NEED_FULL_RELOAD' }
    }
    return {
      ok: true,
      frames: this.buf.filter((f) => (f.seq ?? -1) > lastSeq)
    }
  }

  size(): number {
    return this.buf.length
  }

  latestSeq(): number {
    return this.newestSeq
  }

  clear(): void {
    this.buf = []
    this.oldestSeq = 0
    this.newestSeq = 0
  }
}

// ─── Seq generator ──────────────────────────────────────────────────────────

/**
 * Per-session monotonic counter. Use `next()` whenever the bridge is about
 * to emit a frame so seq is always assigned in send order.
 */
export class SeqCounter {
  private cur = 0
  next(): number {
    this.cur += 1
    return this.cur
  }
  current(): number {
    return this.cur
  }
  reset(to = 0): void {
    this.cur = to
  }
}
