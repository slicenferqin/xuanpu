/**
 * useSessionStream: bridge HubWebSocket frames into a React-friendly state
 * tree for one session. Owns:
 *   - messages[]   (HubMessage list, applied in seq order)
 *   - status       (idle/busy/retry/error)
 *   - permission   (open permission request, if any)
 *   - question     (open question request, if any)
 *   - awaitingConfirmation (true while a prompt is queued waiting for desktop)
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

interface State {
  status: HubSessionStatus
  messages: HubMessage[]
  permission: PermissionReq | null
  question: QuestionReq | null
  awaitingConfirmation: { clientMsgId: string; text: string } | null
  error: { code: string; message?: string } | null
  connection: ConnectionState
}

const INITIAL: State = {
  status: 'idle',
  messages: [],
  permission: null,
  question: null,
  awaitingConfirmation: null,
  error: null,
  connection: 'connecting'
}

type Action =
  | { type: 'frame'; frame: ServerMsg }
  | { type: 'connection'; value: ConnectionState }
  | { type: 'awaiting'; payload: { clientMsgId: string; text: string } | null }
  | { type: 'clearPermission' }
  | { type: 'clearQuestion' }

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
  if (action.type === 'awaiting') {
    return { ...state, awaitingConfirmation: action.payload }
  }
  if (action.type === 'clearPermission') {
    return { ...state, permission: null }
  }
  if (action.type === 'clearQuestion') {
    return { ...state, question: null }
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
    case 'confirmation/request':
      return state // not used in M1
    case 'error': {
      // CONFIRM_TIMEOUT clears any pending awaiting state.
      const next = { ...state, error: { code: f.code, message: f.message } }
      if (f.code === 'CONFIRM_TIMEOUT' || f.code === 'BAD_REQUEST') {
        next.awaitingConfirmation = null
      }
      return next
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
      dispatch({ type: 'awaiting', payload: { clientMsgId, text } })

      // Optimistic user bubble — user sees what they sent immediately.
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
    dispatch({ type: 'awaiting', payload: null })
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

  return {
    state,
    send,
    prompt,
    interrupt,
    respondPermission,
    respondQuestion,
    dismissPermission,
    dismissQuestion
  }
}
