import type { BrowserWindow } from 'electron'
import type { AgentRuntimeId, AgentRuntimeCapabilities, AgentRuntimeAdapter } from './agent-runtime-types'
import { createLogger } from './logger'

const log = createLogger({ component: 'AgentRuntimeManager' })

export class AgentRuntimeManager {
  private implementers: Map<AgentRuntimeId, AgentRuntimeAdapter>
  readonly defaultRuntimeId: AgentRuntimeId = 'opencode'

  constructor(implementers: AgentRuntimeAdapter[]) {
    this.implementers = new Map<AgentRuntimeId, AgentRuntimeAdapter>(
      implementers.map((impl) => [impl.id, impl])
    )
    log.info('AgentRuntimeManager initialized', {
      runtimes: Array.from(this.implementers.keys())
    })
  }

  getImplementer(runtimeId: AgentRuntimeId): AgentRuntimeAdapter {
    const impl = this.implementers.get(runtimeId)
    if (!impl) {
      throw new Error(`Unknown agent runtime: "${runtimeId}"`)
    }
    return impl
  }

  /**
   * Returns all registered adapters. Use this for cross-agent dispatch — e.g.
   * HITL handlers where the requestId doesn't carry a runtime tag, so the
   * dispatcher has to ask every adapter whether it owns the pending request.
   */
  listAgents(): AgentRuntimeAdapter[] {
    return Array.from(this.implementers.values())
  }

  getCapabilities(runtimeId: AgentRuntimeId): AgentRuntimeCapabilities {
    return this.getImplementer(runtimeId).capabilities
  }

  setMainWindow(window: BrowserWindow): void {
    for (const impl of this.implementers.values()) {
      impl.setMainWindow(window)
    }
  }

  async cleanupAll(): Promise<void> {
    log.info('Cleaning up all runtime implementers')
    for (const [id, impl] of this.implementers) {
      try {
        await impl.cleanup()
        log.info('Cleaned up runtime', { id })
      } catch (error) {
        log.error('Error cleaning up runtime', {
          id,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}
