import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../../src/main/db/database'

const turnRepoMock = vi.hoisted(() => ({
  createAgentTurn: vi.fn(() => ({ id: 'turn-1' })),
  updateAgentTurnStatus: vi.fn()
}))
const taskRunRepoMock = vi.hoisted(() => ({
  appendContextSegment: vi.fn(() => ({
    id: 'segment-1',
    taskRunId: 'task-run-1',
    sessionId: 'session-1',
    userRoundId: 'round-1',
    ordinal: 0,
    status: 'running',
    checkpointId: null,
    providerCallCount: 0,
    startFillRatio: null,
    endFillRatio: null,
    closeReason: null,
    startedAt: '2026-06-16T00:00:00.000Z',
    closedAt: null
  })),
  closeEpoch: vi.fn(),
  createUserRound: vi.fn(() => ({
    id: 'round-1',
    taskRunId: 'task-run-1',
    sessionId: 'session-1',
    ordinal: 0,
    origin: 'user-originated',
    status: 'running',
    userMessageId: 'msg-user-1',
    promptText: 'finish the runtime',
    providerRequestCount: 0,
    contextSegmentCount: 0,
    startedAt: '2026-06-16T00:00:00.000Z',
    completedAt: null,
    errorMessage: null
  })),
  updateTaskRunStatus: vi.fn(),
  updateUserRoundStatus: vi.fn()
}))

vi.mock('../../src/main/db/turn-repository', () => turnRepoMock)
vi.mock('../../src/main/db/task-run-repository', () => taskRunRepoMock)

import {
  inferUserRoundOrigin,
  UserRoundRunner
} from '../../src/main/services/xuanpu-agent/user-round-runner'

const db = {} as DatabaseService

describe('UserRoundRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts a user round, context segment, and provider turn as one scope', () => {
    const runner = new UserRoundRunner(db)

    const scope = runner.start({
      taskRunId: 'task-run-1',
      sessionId: 'session-1',
      worktreeId: 'worktree-1',
      projectId: 'project-1',
      runtimeId: 'xuanpu-agent',
      promptText: '<xuanpu-task-run-continuation>continue</xuanpu-task-run-continuation>',
      requestedTaskRunId: 'task-run-1',
      userMessageId: 'msg-user-1',
      modelRef: { providerID: 'openai', modelID: 'gpt-test', variant: 'mini' }
    })

    expect(scope).toMatchObject({
      userRound: { id: 'round-1' },
      contextSegment: { id: 'segment-1' },
      turnId: 'turn-1'
    })
    expect(taskRunRepoMock.createUserRound).toHaveBeenCalledWith(
      expect.objectContaining({
        taskRunId: 'task-run-1',
        sessionId: 'session-1',
        origin: 'agent-continuation',
        userMessageId: 'msg-user-1',
        promptText: expect.stringContaining('xuanpu-task-run-continuation')
      }),
      db
    )
    expect(taskRunRepoMock.appendContextSegment).toHaveBeenCalledWith(
      {
        taskRunId: 'task-run-1',
        sessionId: 'session-1',
        userRoundId: 'round-1'
      },
      db
    )
    expect(turnRepoMock.createAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        worktreeId: 'worktree-1',
        projectId: 'project-1',
        runtimeId: 'xuanpu-agent',
        taskRunId: 'task-run-1',
        userRoundId: 'round-1',
        epochId: 'segment-1',
        userMessageId: 'msg-user-1',
        modelProviderId: 'openai',
        modelId: 'gpt-test',
        modelVariant: 'mini'
      }),
      db
    )
  })

  it('marks all active scope records failed or aborted through one runner path', () => {
    const runner = new UserRoundRunner(db)

    runner.failActiveScope(
      {
        turnId: 'turn-1',
        contextSegmentId: 'segment-1',
        taskRunId: 'task-run-1',
        userRoundId: 'round-1'
      },
      'provider failed'
    )

    expect(turnRepoMock.updateAgentTurnStatus).toHaveBeenCalledWith(
      'turn-1',
      'failed',
      { errorMessage: 'provider failed' },
      db
    )
    expect(taskRunRepoMock.closeEpoch).toHaveBeenCalledWith(
      'segment-1',
      { status: 'failed', endFillRatio: null, closeReason: 'watchdog' },
      db
    )
    expect(taskRunRepoMock.updateTaskRunStatus).toHaveBeenCalledWith(
      'task-run-1',
      'failed',
      { errorMessage: 'provider failed' },
      db
    )
    expect(taskRunRepoMock.updateUserRoundStatus).toHaveBeenCalledWith(
      'round-1',
      'failed',
      { errorMessage: 'provider failed' },
      db
    )

    vi.clearAllMocks()
    runner.abortActiveScope({ turnId: 'turn-2', taskRunId: 'task-run-2' }, 'Aborted by user')

    expect(turnRepoMock.updateAgentTurnStatus).toHaveBeenCalledWith(
      'turn-2',
      'aborted',
      { errorMessage: 'Aborted by user' },
      db
    )
    expect(taskRunRepoMock.updateTaskRunStatus).toHaveBeenCalledWith(
      'task-run-2',
      'aborted',
      { errorMessage: 'Aborted by user' },
      db
    )
    expect(taskRunRepoMock.closeEpoch).not.toHaveBeenCalled()
  })

  it('classifies user-round origins', () => {
    expect(inferUserRoundOrigin('plain prompt', null)).toBe('user-originated')
    expect(inferUserRoundOrigin('continue', 'task-run-1')).toBe('agent-continuation')
    expect(inferUserRoundOrigin('reason="no-progress-recovery"', null)).toBe(
      'recovery-continuation'
    )
  })
})
