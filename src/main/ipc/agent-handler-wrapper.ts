/**
 * Agent handler wrapper — unifies try/catch, zod validation, and error shape
 * for the IPC layer so every agent:* channel behaves the same way.
 *
 * Usage:
 *   ipcMain.handle('agent:prompt', createAgentHandler({
 *     channel: 'agent:prompt',
 *     schema: promptSchema,
 *     handler: async (args, ctx) => {
 *       const impl = ctx.runtimeManager.getImplementer(args.runtimeId)
 *       await impl.prompt(args.worktreePath, args.sessionId, args.message)
 *       return { sessionId: args.sessionId }
 *     }
 *   }))
 *
 * Return shape (backward-compatible with existing `{success, error}` consumers):
 *   Success: { success: true, ...data }
 *   Failure: { success: false, error: string, errorCode: ErrorCode }
 *
 * `error` stays a human-readable string (so `toast.error(result.error)` still
 * works everywhere); `errorCode` is added for callers that want structured
 * handling (retry, route to specific UI, telemetry).
 */

import type { IpcMainInvokeEvent } from 'electron'
import type { ZodSchema, ZodError } from 'zod'
import type { AgentRuntimeManager } from '../services/agent-runtime-manager'
import type { AgentRuntimeId } from '../services/agent-runtime-types'
import type { DatabaseService } from '../db/database'
import { createLogger } from '../services/logger'
import type {
  AgentErrorCode as SharedAgentErrorCode,
  AgentIpcResult,
  AgentIpcSuccess,
  AgentIpcFailure
} from '@shared/types/agent-ipc'
import { AgentErrorCodeValues } from '@shared/types/agent-ipc'

const log = createLogger({ component: 'AgentHandlerWrapper' })

// Re-export so existing imports from agent-handlers.ts keep working
export type AgentErrorCode = SharedAgentErrorCode
export const AgentErrorCode = AgentErrorCodeValues.reduce(
  (acc, v) => {
    acc[v] = v
    return acc
  },
  {} as Record<SharedAgentErrorCode, SharedAgentErrorCode>
)

// Re-export result aliases
export type AgentHandlerSuccess<T> = AgentIpcSuccess<T>
export type AgentHandlerFailure = AgentIpcFailure
export type AgentHandlerResult<T> = AgentIpcResult<T>

/** Thrown inside a handler body to produce a specific error code. */
export class AgentHandlerError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AgentHandlerError'
  }
}

// ---------------------------------------------------------------------------
// Handler context — dependencies every agent handler needs
// ---------------------------------------------------------------------------

export interface AgentHandlerContext {
  runtimeManager: AgentRuntimeManager
  dbService: DatabaseService
}

// ---------------------------------------------------------------------------
// Wrapper factory
// ---------------------------------------------------------------------------

interface CreateAgentHandlerOptions<TInput, TOutput> {
  /** IPC channel name — used for logging */
  channel: string
  /**
   * zod schema validating the raw IPC args array. For single-payload handlers
   * use `z.tuple([payloadSchema])`, for positional use `z.tuple([arg1, arg2, ...])`.
   * Input type is inferred from the schema; unwrap tuple in the handler body.
   */
  schema: ZodSchema<TInput>
  /** Handler body — receives parsed args and context, returns data to merge into success result */
  handler: (args: TInput, ctx: AgentHandlerContext) => Promise<TOutput>
}

/**
 * Build an ipcMain.handle-compatible callback.
 *
 * The wrapper:
 *  - collects all IPC args into a tuple and validates against `schema`
 *  - catches ZodError → INVALID_PARAM
 *  - catches AgentHandlerError → its code
 *  - catches everything else → INTERNAL_ERROR
 *  - logs failures once, with channel + error code
 */
export function createAgentHandler<TInput, TOutput extends Record<string, unknown> | void>(
  ctx: AgentHandlerContext,
  opts: CreateAgentHandlerOptions<TInput, TOutput>
): (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<AgentHandlerResult<TOutput extends void ? Record<string, never> : TOutput>> {
  return async (_event, ...args) => {
    let parsed: TInput
    try {
      parsed = opts.schema.parse(args)
    } catch (err) {
      const zodErr = err as ZodError
      const message = zodErr.issues
        ? zodErr.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        : String(err)
      log.warn(`IPC ${opts.channel} validation failed`, { message })
      return {
        success: false,
        error: `Invalid params: ${message}`,
        errorCode: AgentErrorCode.INVALID_PARAM
      } as AgentHandlerFailure
    }

    try {
      const result = await opts.handler(parsed, ctx)
      return { success: true, ...(result ?? {}) } as AgentHandlerSuccess<
        TOutput extends void ? Record<string, never> : TOutput
      >
    } catch (err) {
      if (err instanceof AgentHandlerError) {
        log.warn(`IPC ${opts.channel} failed`, { code: err.code, message: err.message })
        return {
          success: false,
          error: err.message,
          errorCode: err.code
        }
      }
      const message = err instanceof Error ? err.message : String(err)
      log.error(`IPC ${opts.channel} threw`, { message, err })
      return {
        success: false,
        error: message,
        errorCode: AgentErrorCode.INTERNAL_ERROR
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: resolve runtime id with standard errors
// ---------------------------------------------------------------------------

/**
 * Resolve the runtime id for a session, falling back to `opencode` when the
 * session row is missing. Keeps the lookup logic identical across handlers.
 */
export function resolveRuntimeId(
  ctx: AgentHandlerContext,
  sessionId: string,
  fallback: AgentRuntimeId = 'opencode'
): AgentRuntimeId {
  return ctx.dbService.getRuntimeIdForSession(sessionId) ?? fallback
}
