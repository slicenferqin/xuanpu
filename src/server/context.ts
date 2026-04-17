import type { DatabaseService } from '../main/db/database'
import type { AgentRuntimeManager } from '../main/services/agent-runtime-manager'
import type { EventBus } from './event-bus'

export interface GraphQLContext {
  db: DatabaseService
  /**
   * Canonical runtime registry. All agents (OpenCode / Claude Code / Codex)
   * are registered here and accessed via `runtimeManager.getImplementer(id)`.
   *
   * `sdkManager` is kept as an alias for backwards compatibility with existing
   * GraphQL resolvers; both fields point at the same instance.
   */
  runtimeManager: AgentRuntimeManager
  sdkManager: AgentRuntimeManager
  eventBus: EventBus
  clientIp: string
  authenticated: boolean
}
