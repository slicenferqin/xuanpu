// src/server/resolvers/helpers/runtime-dispatch.ts
import type { GraphQLContext } from '../../context'
import type { AgentRuntimeId, AgentRuntimeAdapter } from '../../../main/services/agent-runtime-types'

/** Map GraphQL runtime enum value to internal AgentRuntimeId */
export function mapGraphQLRuntimeToInternal(gqlRuntime: string): AgentRuntimeId {
  if (gqlRuntime === 'claude_code') return 'claude-code'
  return gqlRuntime as AgentRuntimeId
}

/**
 * Runtime dispatch by agent session ID.
 * Looks up which runtime a session uses via db.getRuntimeIdForSession().
 * If a non-OpenCode runtime, routes to its implementer; otherwise uses OpenCode.
 */
export async function withRuntimeDispatch<T>(
  ctx: GraphQLContext,
  agentSessionId: string,
  opencodeFn: () => Promise<T>,
  runtimeFn: (impl: AgentRuntimeAdapter) => Promise<T>
): Promise<T> {
  if (ctx.runtimeManager && ctx.db) {
    const runtimeId = ctx.db.getRuntimeIdForSession(agentSessionId)
    if (runtimeId && runtimeId !== 'opencode' && runtimeId !== 'terminal') {
      return runtimeFn(ctx.runtimeManager.getImplementer(runtimeId))
    }
  }
  return opencodeFn()
}

/**
 * Runtime dispatch by Hive session ID (used for connect, where agent session
 * doesn't exist yet). Looks up session.runtime_id from the DB.
 */
export async function withRuntimeDispatchByHiveSession<T>(
  ctx: GraphQLContext,
  hiveSessionId: string,
  opencodeFn: () => Promise<T>,
  runtimeFn: (impl: AgentRuntimeAdapter) => Promise<T>
): Promise<T> {
  if (ctx.runtimeManager && ctx.db) {
    const session = ctx.db.getSession(hiveSessionId)
    if (
      session?.runtime_id &&
      session.runtime_id !== 'opencode' &&
      session.runtime_id !== 'terminal'
    ) {
      return runtimeFn(ctx.runtimeManager.getImplementer(session.runtime_id))
    }
  }
  return opencodeFn()
}
