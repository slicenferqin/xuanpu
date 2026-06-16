import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../../src/main/db/database'

const taskRunRepoMock = vi.hoisted(() => ({
  createTaskRun: vi.fn(),
  getActiveTaskRun: vi.fn(),
  getTaskRun: vi.fn(),
  updateTaskRunStatus: vi.fn()
}))

vi.mock('../../src/main/db/task-run-repository', () => taskRunRepoMock)

import {
  shouldResumeActiveTaskRunFromPromptText,
  TaskRunScheduler
} from '../../src/main/services/xuanpu-agent/task-run-scheduler'

const db = {} as DatabaseService

function makeTaskRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-run-1',
    sessionId: 'session-1',
    worktreeId: 'worktree-1',
    projectId: 'project-1',
    originMessageId: 'msg-1',
    status: 'running',
    autonomy: 'short',
    objective: 'objective',
    leaseExpiresAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    epochCount: 0,
    startedAt: '2026-06-16T00:00:00.000Z',
    completedAt: null,
    errorMessage: null,
    ...overrides
  }
}

describe('TaskRunScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    taskRunRepoMock.createTaskRun.mockReturnValue(makeTaskRun())
    taskRunRepoMock.getActiveTaskRun.mockReturnValue(null)
    taskRunRepoMock.getTaskRun.mockReturnValue(null)
  })

  it('creates a new task run with the requested autonomy and lease', () => {
    const scheduler = new TaskRunScheduler(db)

    const result = scheduler.schedule({
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      projectId: 'project-1',
      originMessageId: 'msg-1',
      promptText: 'build the runtime',
      requestedAutonomy: 'long',
      leaseWindowMs: 1000
    })

    expect(result).toMatchObject({ reusedExisting: false, autonomy: 'long' })
    expect(taskRunRepoMock.createTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        worktreeId: 'worktree-1',
        projectId: 'project-1',
        originMessageId: 'msg-1',
        autonomy: 'long',
        objective: 'build the runtime',
        leaseExpiresAt: expect.any(String)
      }),
      db
    )
  })

  it('resumes a paused active task run for continuation prompts without creating a new run', () => {
    taskRunRepoMock.getActiveTaskRun.mockReturnValue(
      makeTaskRun({ id: 'paused-run', status: 'paused', autonomy: 'long' })
    )
    const scheduler = new TaskRunScheduler(db)

    const result = scheduler.schedule({
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      projectId: 'project-1',
      originMessageId: 'msg-2',
      promptText: '继续当前任务',
      requestedAutonomy: 'short',
      leaseWindowMs: 1000
    })

    expect(result).toMatchObject({
      reusedExisting: true,
      autonomy: 'long',
      taskRun: expect.objectContaining({ id: 'paused-run', status: 'running' })
    })
    expect(taskRunRepoMock.getActiveTaskRun).toHaveBeenCalledWith('session-1', db)
    expect(taskRunRepoMock.createTaskRun).not.toHaveBeenCalled()
    expect(taskRunRepoMock.updateTaskRunStatus).toHaveBeenCalledWith(
      'paused-run',
      'running',
      { leaseExpiresAt: expect.any(String) },
      db
    )
  })

  it('recognizes resume intent in Chinese and English prompts', () => {
    expect(shouldResumeActiveTaskRunFromPromptText('继续处理剩下的任务')).toBe(true)
    expect(shouldResumeActiveTaskRunFromPromptText('resume the current task')).toBe(true)
    expect(shouldResumeActiveTaskRunFromPromptText('start a fresh audit')).toBe(false)
  })
})
