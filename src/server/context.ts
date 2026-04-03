import type { DatabaseService } from '../main/db/database'
import type { AgentSdkManager } from '../main/services/agent-sdk-manager'
import type { AgentRuntimeManager } from '../main/services/agent-runtime-manager'
import type { EventBus } from './event-bus'

export interface GraphQLContext {
  db: DatabaseService
  sdkManager: AgentSdkManager
  runtimeManager: AgentRuntimeManager
  eventBus: EventBus
  clientIp: string
  authenticated: boolean
}
