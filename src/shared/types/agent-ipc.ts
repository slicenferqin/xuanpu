/**
 * Shared IPC response type for all `agent:*` channels.
 *
 * Handlers built with `createAgentHandler` always return one of these two
 * shapes. Renderer consumers can narrow via `if (!result.success)` to get
 * typed access to `error` (human message) and `errorCode` (stable enum).
 *
 * Adding a new field to the success payload? Parametrize via `TData`:
 *   AgentIpcResult<{ sessionId: string }>
 *
 * This keeps preload/index.d.ts concise and lets error-handling code share
 * one source of truth across the renderer.
 */

export const AgentErrorCodeValues = [
  'INVALID_PARAM',
  'UNKNOWN_RUNTIME',
  'RUNTIME_UNAVAILABLE',
  'STEER_NOT_SUPPORTED',
  'SESSION_NOT_FOUND',
  'INTERNAL_ERROR'
] as const

export type AgentErrorCode = (typeof AgentErrorCodeValues)[number]

export type AgentIpcSuccess<TData> = { success: true } & TData
export interface AgentIpcFailure {
  success: false
  error: string
  errorCode: AgentErrorCode
}

export type AgentIpcResult<TData = Record<string, never>> =
  | AgentIpcSuccess<TData>
  | AgentIpcFailure
