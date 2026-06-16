import type { DatabaseService } from '../../db/database'
import {
  createTaskRun,
  getActiveTaskRun,
  getTaskRun,
  updateTaskRunStatus
} from '../../db/task-run-repository'
import type { AgentTaskRun, TaskRunAutonomy } from '../../../shared/types/agent-task-run'
import { inferTaskRunAutonomyFromPromptText } from './task-run-intent'

const DEFAULT_LEASE_WINDOW_MS = 20 * 60 * 1000

export interface TaskRunScheduleInput {
  sessionId: string
  worktreeId: string | null
  projectId: string
  originMessageId: string
  promptText: string
  requestedTaskRunId?: string | null
  requestedAutonomy?: TaskRunAutonomy
  leaseWindowMs?: number
}

export interface TaskRunScheduleResult {
  taskRun: AgentTaskRun
  autonomy: TaskRunAutonomy
  reusedExisting: boolean
}

export class TaskRunScheduler {
  constructor(private readonly db: DatabaseService) {}

  schedule(input: TaskRunScheduleInput): TaskRunScheduleResult {
    const requestedTaskRun = this.resolveRequestedTaskRun(input)
    const reusableTaskRun =
      requestedTaskRun &&
      requestedTaskRun.sessionId === input.sessionId &&
      (requestedTaskRun.status === 'running' || requestedTaskRun.status === 'paused')
        ? requestedTaskRun
        : null
    const requestedAutonomy =
      input.requestedAutonomy ?? inferTaskRunAutonomyFromPromptText(input.promptText) ?? 'short'
    const autonomy = reusableTaskRun?.autonomy ?? requestedAutonomy

    if (reusableTaskRun) {
      const resumed = this.resumeIfPaused(reusableTaskRun, autonomy, input.leaseWindowMs)
      return { taskRun: resumed, autonomy, reusedExisting: true }
    }

    return {
      taskRun: createTaskRun(
        {
          sessionId: input.sessionId,
          worktreeId: input.worktreeId,
          projectId: input.projectId,
          originMessageId: input.originMessageId,
          autonomy,
          objective: input.promptText,
          leaseExpiresAt: this.nextLeaseExpiresAt(autonomy, input.leaseWindowMs)
        },
        this.db
      ),
      autonomy,
      reusedExisting: false
    }
  }

  private resolveRequestedTaskRun(input: TaskRunScheduleInput): AgentTaskRun | null {
    const explicitTaskRun = input.requestedTaskRunId
      ? getTaskRun(input.requestedTaskRunId, this.db)
      : null
    if (explicitTaskRun) return explicitTaskRun

    if (!shouldResumeActiveTaskRunFromPromptText(input.promptText)) return null
    const implicitTaskRun = getActiveTaskRun(input.sessionId, this.db)
    return implicitTaskRun?.status === 'paused' ? implicitTaskRun : null
  }

  private resumeIfPaused(
    taskRun: AgentTaskRun,
    autonomy: TaskRunAutonomy,
    leaseWindowMs?: number
  ): AgentTaskRun {
    if (taskRun.status !== 'paused') return taskRun

    const leaseExpiresAt =
      taskRun.leaseExpiresAt ?? this.nextLeaseExpiresAt(autonomy, leaseWindowMs)
    updateTaskRunStatus(taskRun.id, 'running', { leaseExpiresAt }, this.db)
    return { ...taskRun, status: 'running', leaseExpiresAt }
  }

  private nextLeaseExpiresAt(autonomy: TaskRunAutonomy, leaseWindowMs?: number): string | null {
    if (autonomy === 'short') return null
    const windowMs = Number.isFinite(leaseWindowMs) ? leaseWindowMs! : DEFAULT_LEASE_WINDOW_MS
    return new Date(Date.now() + windowMs).toISOString()
  }
}

export function shouldResumeActiveTaskRunFromPromptText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!normalized) return false

  return [
    /^继续\b/,
    /^请继续\b/,
    /继续(?:当前|这个|上个|上一|跑|执行|推进|完成|处理|剩下|余下|后续)/,
    /(?:跑完|完成|处理).{0,12}(?:剩下|余下|剩余|后续)/,
    /(?:接着|续跑|继续跑)/,
    /\b(?:resume|continue)\b/
  ].some((pattern) => pattern.test(normalized))
}
