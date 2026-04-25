/**
 * useSessionStream: bridge HubWebSocket frames into a React-friendly state
 * tree for one session. Owns:
 *   - messages[]   (HubMessage list, applied in seq order)
 *   - status       (idle/busy/retry/error)
 *   - permission   (open permission request, if any)
 *   - question     (open question request, if any)
 *   - plan / commandApproval (interactive cards)
 *   - notices      (system/notice ring)
 *   - error        (last server-pushed error code/message)
 *
 * The hook also exposes a `send` helper plus `respondPermission` /
 * `respondQuestion` / `interrupt` / `prompt` action callbacks so the route
 * can stay declarative.
 */

import { useEffect, useReducer, useRef } from 'react'
import { HubWebSocket, type ConnectionState } from '../api/ws'
import type {
  ClientMsg,
  HubMessage,
  HubPart,
  HubSessionStatus,
  MessageUpdateOp,
  ServerMsg
} from '../types/hub'

interface PermissionReq {
  requestId: string
  toolName: string
  input?: unknown
  description?: string
}

interface QuestionReq {
  requestId: string
  question: string
  options?: string[]
}

interface PlanReq {
  requestId: string
  planText: string
}

interface CommandApprovalReq {
  requestId: string
  command: string
  cwd?: string
  reason?: string
}

export interface NoticeEntry {
  /** Server-assigned seq, used as React key. */
  seq: number
  level: 'info' | 'warn' | 'error'
  category: string
  text: string
  data?: unknown
  receivedAt: number
}

const NOTICE_CAP = 30

interface State {
  status: HubSessionStatus
  messages: HubMessage[]
  permission: PermissionReq | null
  question: QuestionReq | null
  plan: PlanReq | null
  commandApproval: CommandApprovalReq | null
  /** Most-recent notice first. Capped at NOTICE_CAP. */
  notices: NoticeEntry[]
  error: { code: string; message?: string } | null
  connection: ConnectionState
}

const INITIAL: State = {
  status: 'idle',
  messages: [],
  permission: null,
  question: null,
  plan: null,
  commandApproval: null,
  notices: [],
  error: null,
  connection: 'connecting'
}

type Action =
  | { type: 'frame'; frame: ServerMsg }
  | { type: 'connection'; value: ConnectionState }
  | { type: 'clearPermission' }
  | { type: 'clearQuestion' }
  | { type: 'clearPlan' }
  | { type: 'clearCommandApproval' }
  | { type: 'dismissNotice'; seq: number }
  | { type: 'clearAllNotices' }

function applyPatch(message: HubMessage, op: MessageUpdateOp): HubMessage {
  const parts = [...message.parts]
  switch (op.op) {
    case 'appendText': {
      const cur = parts[op.partIdx]
      if (cur && cur.type === 'text') {
        parts[op.partIdx] = { ...cur, text: cur.text + op.value }
      }
      break
    }
    case 'replacePart': {
      parts[op.partIdx] = op.value
      break
    }
    case 'appendPart': {
      parts.push(op.value)
      break
    }
  }
  return { ...message, parts }
}

function reducer(state: State, action: Action): State {
  if (action.type === 'connection') {
    return { ...state, connection: action.value }
  }
  if (action.type === 'clearPermission') {
    return { ...state, permission: null }
  }
  if (action.type === 'clearQuestion') {
    return { ...state, question: null }
  }
  if (action.type === 'clearPlan') {
    return { ...state, plan: null }
  }
  if (action.type === 'clearCommandApproval') {
    return { ...state, commandApproval: null }
  }
  if (action.type === 'dismissNotice') {
    return { ...state, notices: state.notices.filter((n) => n.seq !== action.seq) }
  }
  if (action.type === 'clearAllNotices') {
    return { ...state, notices: [] }
  }
  const f = action.frame
  switch (f.type) {
    case 'session/snapshot':
      return {
        ...state,
        status: f.status,
        messages: f.messages,
        permission: null,
        question: null,
        error: null
      }
    case 'message/append':
      return { ...state, messages: [...state.messages, f.message] }
    case 'message/update': {
      const idx = state.messages.findIndex((m) => m.id === f.messageId)
      if (idx === -1) return state
      const next = [...state.messages]
      next[idx] = applyPatch(next[idx]!, f.patch)
      return { ...state, messages: next }
    }
    case 'status':
      return { ...state, status: f.status }
    case 'permission/request':
      return {
        ...state,
        permission: {
          requestId: f.requestId,
          toolName: f.toolName,
          input: f.input,
          description: f.description
        }
      }
    case 'question/request':
      return {
        ...state,
        question: {
          requestId: f.requestId,
          question: f.question,
          options: f.options
        }
      }
    case 'system/notice': {
      const entry: NoticeEntry = {
        seq: f.seq,
        level: f.level,
        category: f.category,
        text: f.text,
        data: f.data,
        receivedAt: Date.now()
      }
      return { ...state, notices: [entry, ...state.notices].slice(0, NOTICE_CAP) }
    }
    case 'plan/request':
      return { ...state, plan: { requestId: f.requestId, planText: f.planText } }
    case 'command_approval/request':
      return {
        ...state,
        commandApproval: {
          requestId: f.requestId,
          command: f.command,
          cwd: f.cwd,
          reason: f.reason
        }
      }
    case 'error': {
      return { ...state, error: { code: f.code, message: f.message } }
    }
    default: {
      // Defensive: if the server adds a new frame type before this bundle
      // ships, fall through quietly and keep state intact instead of
      // returning `undefined` (which would make `useReducer` produce
      // undefined state and crash the SessionDetail tree on the next render
      // — that's the "send message → black screen" failure mode).
      // eslint-disable-next-line no-console
      console.warn('[useSessionStream] ignoring unknown frame type', f)
      return state
    }
  }
}

export interface SessionStream {
  state: State
  send: (msg: ClientMsg) => boolean
  prompt: (text: string) => void
  interrupt: () => void
  respondPermission: (decision: 'once' | 'always' | 'reject', message?: string) => void
  respondQuestion: (answers: string[][]) => void
  /** Mark a permission/question card as locally dismissed (kept for UX echo). */
  dismissPermission: () => void
  dismissQuestion: () => void
  respondPlan: (decision: 'approve' | 'reject', feedback?: string) => void
  respondCommandApproval: (
    decision: 'approve_once' | 'approve_always' | 'reject',
    message?: string
  ) => void
  dismissNotice: (seq: number) => void
  clearAllNotices: () => void
}

export function useSessionStream(deviceId: string, hiveId: string): SessionStream {
  const [state, dispatch] = useReducer(reducer, INITIAL)
  const wsRef = useRef<HubWebSocket | null>(null)

  useEffect(() => {
    const ws = new HubWebSocket(deviceId, hiveId)
    wsRef.current = ws
    const offFrame = ws.onFrame((f) => dispatch({ type: 'frame', frame: f as ServerMsg }))
    const offState = ws.onState((s) => dispatch({ type: 'connection', value: s }))
    ws.connect()
    return () => {
      offFrame()
      offState()
      ws.destroy()
      wsRef.current = null
    }
  }, [deviceId, hiveId])

  const send = (msg: ClientMsg): boolean => {
    return wsRef.current?.send(msg as unknown as Parameters<HubWebSocket['send']>[0]) ?? false
  }

  const prompt = (text: string): void => {
    const clientMsgId = `cm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    if (send({ type: 'prompt', clientMsgId, text })) {
      // Optimistic user bubble — IM-style: send goes through immediately,
      // assistant reply streams in subsequent frames.
      const userPart: HubPart = { type: 'text', text }
      const localMsg: HubMessage = {
        id: `local-${clientMsgId}`,
        role: 'user',
        ts: Date.now(),
        seq: 0,
        parts: [userPart]
      }
      dispatch({
        type: 'frame',
        frame: { type: 'message/append', seq: 0, message: localMsg }
      })
    }
  }

  const interrupt = (): void => {
    send({ type: 'interrupt' })
  }

  const respondPermission = (
    decision: 'once' | 'always' | 'reject',
    message?: string
  ): void => {
    if (!state.permission) return
    send({
      type: 'permission/respond',
      requestId: state.permission.requestId,
      decision,
      message
    })
    dispatch({ type: 'clearPermission' })
  }

  const respondQuestion = (answers: string[][]): void => {
    if (!state.question) return
    send({
      type: 'question/respond',
      requestId: state.question.requestId,
      answers
    })
    dispatch({ type: 'clearQuestion' })
  }

  const dismissPermission = (): void => {
    dispatch({ type: 'clearPermission' })
  }
  const dismissQuestion = (): void => {
    dispatch({ type: 'clearQuestion' })
  }

  const respondPlan = (decision: 'approve' | 'reject', feedback?: string): void => {
    if (!state.plan) return
    send({ type: 'plan/respond', requestId: state.plan.requestId, decision, feedback })
    dispatch({ type: 'clearPlan' })
  }

  const respondCommandApproval = (
    decision: 'approve_once' | 'approve_always' | 'reject',
    message?: string
  ): void => {
    if (!state.commandApproval) return
    send({
      type: 'command_approval/respond',
      requestId: state.commandApproval.requestId,
      decision,
      message
    })
    dispatch({ type: 'clearCommandApproval' })
  }

  const dismissNotice = (seq: number): void => {
    dispatch({ type: 'dismissNotice', seq })
  }
  const clearAllNotices = (): void => {
    dispatch({ type: 'clearAllNotices' })
  }

  return {
    state,
    send,
    prompt,
    interrupt,
    respondPermission,
    respondQuestion,
    dismissPermission,
    dismissQuestion,
    respondPlan,
    respondCommandApproval,
    dismissNotice,
    clearAllNotices
  }
}
