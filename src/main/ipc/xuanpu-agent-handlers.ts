/**
 * xuanpu-agent IPC handlers — Context Budget + runtime status.
 *
 * The XuanpuAgentImplementer registers itself via setXuanpuAgentRuntime()
 * on creation and clears via clearXuanpuAgentRuntime() on disposal.
 */
import { ipcMain } from 'electron'
import { createLogger } from '../services/logger'
import type { XuanpuAgentImplementer } from '../services/xuanpu-agent-implementer'

const log = createLogger({ component: 'XuanpuAgentIpc' })

let runtime: XuanpuAgentImplementer | null = null

export function setXuanpuAgentRuntime(impl: XuanpuAgentImplementer): void {
  runtime = impl
}

export function clearXuanpuAgentRuntime(): void {
  runtime = null
}

export function registerXuanpuAgentHandlers(): void {
  log.info('Registering xuanpu-agent IPC handlers')

  ipcMain.handle('xuanpu-agent:getBudgetState', async (_event, sessionId: string) => {
    try {
      if (!runtime) return null
      return runtime.getBudgetState(sessionId)
    } catch (error) {
      log.warn('xuanpu-agent:getBudgetState failed', {
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  })
}
