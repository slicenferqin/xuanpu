/**
 * xuanpu-agent IPC handlers — Context Budget + runtime status.
 *
 * The XuanpuAgentImplementer registers itself via setXuanpuAgentRuntime()
 * on creation and clears via clearXuanpuAgentRuntime() on disposal.
 */
import { ipcMain } from 'electron'
import { createLogger } from '../services/logger'
import type { XuanpuAgentImplementer } from '../services/xuanpu-agent-implementer'
import { getDatabase } from '../db'
import {
  getTaskRun,
  listEpochsForTaskRun,
  listTaskRunsForSession,
  renewLease,
  updateTaskRunStatus
} from '../db/task-run-repository'
import { DEFAULT_LEASE_WINDOW_MS } from '../services/xuanpu-agent/task-run-policy'

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

  ipcMain.handle('xuanpu-agent:listTaskRuns', async (_event, sessionId: string) => {
    try {
      return listTaskRunsForSession(sessionId)
    } catch (error) {
      log.warn('xuanpu-agent:listTaskRuns failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
      return []
    }
  })

  ipcMain.handle('xuanpu-agent:listEpochs', async (_event, taskRunId: string) => {
    try {
      return listEpochsForTaskRun(taskRunId)
    } catch (error) {
      log.warn('xuanpu-agent:listEpochs failed', {
        taskRunId,
        error: error instanceof Error ? error.message : String(error)
      })
      return []
    }
  })

  ipcMain.handle('xuanpu-agent:pauseTaskRun', async (_event, taskRunId: string) => {
    try {
      const taskRun = getTaskRun(taskRunId)
      updateTaskRunStatus(taskRunId, 'paused', { errorMessage: 'Paused by user' })
      if (taskRun) {
        cancelPendingContinuationsForTaskRun(taskRun.sessionId, taskRunId)
      }
      return { success: true, taskRun: getTaskRun(taskRunId) }
    } catch (error) {
      log.warn('xuanpu-agent:pauseTaskRun failed', {
        taskRunId,
        error: error instanceof Error ? error.message : String(error)
      })
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('xuanpu-agent:resumeTaskRun', async (_event, taskRunId: string) => {
    try {
      const taskRun = getTaskRun(taskRunId)
      if (!taskRun) {
        return { success: false, error: `Task run not found: ${taskRunId}` }
      }
      if (taskRun.status !== 'paused' && taskRun.status !== 'running') {
        return { success: false, error: `Task run cannot be resumed from ${taskRun.status}` }
      }

      let leaseExpiresAt = taskRun.leaseExpiresAt
      if (taskRun.autonomy !== 'short') {
        leaseExpiresAt = new Date(Date.now() + DEFAULT_LEASE_WINDOW_MS).toISOString()
        renewLease(taskRun.id, leaseExpiresAt)
      }
      updateTaskRunStatus(taskRun.id, 'running', { leaseExpiresAt })
      getDatabase().createSessionPendingMessage({
        session_id: taskRun.sessionId,
        agent_session_id: null,
        runtime_id: 'xuanpu-agent',
        content: [
          '继续当前 xuanpu-agent task run。',
          '',
          `<xuanpu-task-run-continuation scope="manual-resume">`,
          `Objective: ${taskRun.objective ?? ''}`,
          'Resume from the latest task-epoch checkpoint and continue the next concrete step.',
          '</xuanpu-task-run-continuation>'
        ].join('\n'),
        prompt_options_json: JSON.stringify({
          mode: 'build',
          taskRunAutonomy: taskRun.autonomy,
          taskRunId: taskRun.id
        })
      })
      return { success: true, taskRun: getTaskRun(taskRun.id) }
    } catch (error) {
      log.warn('xuanpu-agent:resumeTaskRun failed', {
        taskRunId,
        error: error instanceof Error ? error.message : String(error)
      })
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

function cancelPendingContinuationsForTaskRun(sessionId: string, taskRunId: string): void {
  const db = getDatabase()
  const pending = db.listSessionPendingMessages(sessionId, ['pending', 'failed'])
  for (const message of pending) {
    if (!message.prompt_options_json) continue
    try {
      const options = JSON.parse(message.prompt_options_json) as Record<string, unknown>
      if (options.taskRunId === taskRunId) {
        db.cancelSessionPendingMessage(message.id)
      }
    } catch {
      // Ignore malformed rows; pause should still succeed for the task run.
    }
  }
}
