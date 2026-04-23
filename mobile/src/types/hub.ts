/**
 * Loose mirrors of src/main/services/hub/hub-protocol.ts — we deliberately
 * keep these typed without zod to avoid bloating the mobile bundle.
 * Server-side zod schemas are source of truth; this file is convenience.
 */

export type HubRole = 'user' | 'assistant' | 'system'
export type HubSessionStatus = 'idle' | 'busy' | 'retry' | 'error'
export type HubErrorCode =
  | 'AUTH_REQUIRED'
  | 'DEVICE_OFFLINE'
  | 'SESSION_NOT_FOUND'
  | 'CONFIRM_TIMEOUT'
  | 'NEED_FULL_RELOAD'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'INTERNAL'

export type HubPart =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use'
      toolUseId: string
      name: string
      input?: unknown
      pending?: boolean
    }
  | {
      type: 'tool_result'
      toolUseId: string
      output?: unknown
      isError?: boolean
    }
  | { type: 'diff'; filePath: string; patch: string }
  | { type: 'unknown'; raw: unknown }

export interface HubMessage {
  id: string
  role: HubRole
  ts: number
  seq: number
  parts: HubPart[]
}

export type MessageUpdateOp =
  | { op: 'appendText'; partIdx: number; value: string }
  | { op: 'replacePart'; partIdx: number; value: HubPart }
  | { op: 'appendPart'; value: HubPart }

export type ServerMsg =
  | {
      type: 'session/snapshot'
      seq: number
      status: HubSessionStatus
      messages: HubMessage[]
      lastSeq: number
    }
  | { type: 'message/append'; seq: number; message: HubMessage }
  | {
      type: 'message/update'
      seq: number
      messageId: string
      patch: MessageUpdateOp
    }
  | {
      type: 'permission/request'
      seq: number
      requestId: string
      toolName: string
      input?: unknown
      description?: string
    }
  | {
      type: 'question/request'
      seq: number
      requestId: string
      question: string
      options?: string[]
    }
  | { type: 'status'; seq: number; status: HubSessionStatus }
  | {
      type: 'confirmation/request'
      seq: number
      confirmId: string
      preview: string
    }
  | { type: 'error'; seq?: number; code: HubErrorCode; message?: string }

export type ClientMsg =
  | { type: 'prompt'; clientMsgId: string; text: string }
  | { type: 'interrupt' }
  | {
      type: 'permission/respond'
      requestId: string
      decision: 'once' | 'always' | 'reject'
      message?: string
    }
  | { type: 'question/respond'; requestId: string; answers: string[][] }
  | { type: 'resume'; lastSeq: number }
