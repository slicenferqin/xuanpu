import type { DatabaseService } from '../../db/database'
import {
  createTaskRun,
  getActiveTaskRun,
  getTaskRun,
  listTaskRunsForSession,
  updateTaskRunStatus
} from '../../db/task-run-repository'
import type { AgentTaskRun } from '../../../shared/types/agent-task-run'

const DEFAULT_LEASE_WINDOW_MS = 20 * 60 * 1000

export interface TaskRunScheduleInput {
  sessionId: string
  worktreeId: string | null
  projectId: string
  originMessageId: string
  promptText: string
  requestedTaskRunId?: string | null
  leaseWindowMs?: number
}

export interface TaskRunScheduleResult {
  taskRun: AgentTaskRun
  reusedExisting: boolean
}

export class TaskRunScheduler {
  constructor(private readonly db: DatabaseService) {}

  schedule(input: TaskRunScheduleInput): TaskRunScheduleResult {
    const requestedTaskRun = this.resolveRequestedTaskRun(input)
    const reusableTaskRun =
      requestedTaskRun &&
      requestedTaskRun.sessionId === input.sessionId &&
      (requestedTaskRun.status === 'running' ||
        requestedTaskRun.status === 'paused' ||
        requestedTaskRun.status === 'completed')
        ? requestedTaskRun
        : null

    if (reusableTaskRun) {
      const resumed = this.resumeTaskRun(reusableTaskRun, input.leaseWindowMs)
      return { taskRun: resumed, reusedExisting: true }
    }

    return {
      taskRun: createTaskRun(
        {
          sessionId: input.sessionId,
          worktreeId: input.worktreeId,
          projectId: input.projectId,
          originMessageId: input.originMessageId,
          objective: input.promptText,
          leaseExpiresAt: this.nextLeaseExpiresAt(input.leaseWindowMs)
        },
        this.db
      ),
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
    if (implicitTaskRun?.status === 'running' || implicitTaskRun?.status === 'paused') {
      return implicitTaskRun
    }

    return (
      listTaskRunsForSession(input.sessionId, { limit: 10 }, this.db).find(
        (taskRun) => taskRun.status === 'completed' && !isBareContinuationPrompt(taskRun.objective)
      ) ?? null
    )
  }

  private resumeTaskRun(taskRun: AgentTaskRun, leaseWindowMs?: number): AgentTaskRun {
    if (taskRun.status === 'running') return taskRun

    const leaseExpiresAt = this.nextLeaseExpiresAt(leaseWindowMs)
    updateTaskRunStatus(taskRun.id, 'running', { leaseExpiresAt }, this.db)
    return { ...taskRun, status: 'running', leaseExpiresAt, completedAt: null, errorMessage: null }
  }

  private nextLeaseExpiresAt(leaseWindowMs?: number): string | null {
    const windowMs = Number.isFinite(leaseWindowMs) ? leaseWindowMs! : DEFAULT_LEASE_WINDOW_MS
    return new Date(Date.now() + windowMs).toISOString()
  }
}

function isBareContinuationPrompt(text: string | null | undefined): boolean {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (!normalized) return false

  return [
    /^继续$/,
    /^请继续$/,
    /^继续吧$/,
    /^继续吧[，,\s]*长任务执行$/,
    /^继续一下$/,
    /^继续[，,\s]*(?:长任务执行|执行长任务)$/,
    /^继续当前(?:任务|task run)?$/,
    /^继续(?:处理|完成|推进)(?:剩下|余下|剩余|后续)(?:的)?(?:任务|工作)?$/,
    /^continue$/,
    /^resume$/
  ].some((pattern) => pattern.test(normalized))
}

export function shouldResumeActiveTaskRunFromPromptText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!normalized) return false

  return [
    /^继续$/,
    /^继续吧$/,
    /^继续\b/,
    /^请继续\b/,
    /继续(?:当前|这个|上个|上一|跑|执行|推进|完成|处理|剩下|余下|后续)/,
    /(?:跑完|完成|处理).{0,12}(?:剩下|余下|剩余|后续)/,
    /(?:接着|续跑|继续跑)/,
    /\b(?:resume|continue)\b/
  ].some((pattern) => pattern.test(normalized))
}
