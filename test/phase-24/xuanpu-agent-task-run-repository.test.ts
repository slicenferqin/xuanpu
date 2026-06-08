import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('@shared/app-identity', () => ({
  getActiveAppDatabasePath: (home: string) => join(home, '.xuanpu', 'test.db'),
  APP_BUNDLE_ID: 'test',
  APP_CLI_NAME: 'test',
  APP_PRODUCT_NAME: 'test'
}))

import { DatabaseService } from '../../src/main/db/database'
import {
  accumulateUsage,
  appendEpoch,
  bindTurnToTaskRun,
  closeEpoch,
  createTaskRun,
  getActiveTaskRun,
  getEpoch,
  getTaskRun,
  incrementEpochProviderCallCount,
  listEpochsForTaskRun,
  listTaskRunsForSession,
  renewLease,
  updateEpochStartFillRatio,
  updateTaskRunStatus
} from '../../src/main/db/task-run-repository'
import { createAgentTurn, getAgentTurn } from '../../src/main/db/turn-repository'

let tmpDir: string
let db: DatabaseService
let projectId: string
let worktreeId: string
let sessionId: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-task-run-repo-'))
  db = new DatabaseService(join(tmpDir, 'test.db'))
  db.init()

  const project = db.createProject({ name: 'Task Run Repo', path: join(tmpDir, 'repo') })
  const worktree = db.createWorktree({
    project_id: project.id,
    name: 'main',
    branch_name: 'main',
    path: join(tmpDir, 'repo')
  })
  const session = db.createSession({
    project_id: project.id,
    worktree_id: worktree.id,
    agent_sdk: 'xuanpu-agent'
  })

  projectId = project.id
  worktreeId = worktree.id
  sessionId = session.id
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('xuanpu-agent task-run repository', () => {
  it('creates a task run and finds it as active for the session', () => {
    const taskRun = createTaskRun(
      {
        sessionId,
        worktreeId,
        projectId,
        originMessageId: 'msg-user-1',
        autonomy: 'long',
        objective: 'Implement the task-run runtime',
        leaseExpiresAt: '2026-06-05T01:00:00.000Z'
      },
      db
    )

    expect(getTaskRun(taskRun.id, db)).toMatchObject({
      id: taskRun.id,
      sessionId,
      worktreeId,
      projectId,
      originMessageId: 'msg-user-1',
      status: 'running',
      autonomy: 'long',
      objective: 'Implement the task-run runtime',
      leaseExpiresAt: '2026-06-05T01:00:00.000Z',
      epochCount: 0
    })
    expect(getActiveTaskRun(sessionId, db)?.id).toBe(taskRun.id)
  })

  it('appends epochs with monotonic ordinals and updates close metadata', () => {
    const taskRun = createTaskRun({ sessionId, worktreeId, projectId }, db)
    const first = appendEpoch({ taskRunId: taskRun.id, sessionId, startFillRatio: 0.1 }, db)
    const second = appendEpoch({ taskRunId: taskRun.id, sessionId }, db)

    expect(first.ordinal).toBe(0)
    expect(second.ordinal).toBe(1)
    expect(getTaskRun(taskRun.id, db)?.epochCount).toBe(2)

    updateEpochStartFillRatio(first.id, 0.2, db)
    incrementEpochProviderCallCount(first.id, db)
    incrementEpochProviderCallCount(first.id, db)
    closeEpoch(
      first.id,
      {
        status: 'compacted',
        endFillRatio: 0.39,
        closeReason: 'compact'
      },
      db
    )

    expect(getEpoch(first.id, db)).toMatchObject({
      id: first.id,
      status: 'compacted',
      providerCallCount: 2,
      startFillRatio: 0.2,
      endFillRatio: 0.39,
      closeReason: 'compact'
    })
  })

  it('accumulates usage and renews leases', () => {
    const taskRun = createTaskRun({ sessionId, worktreeId, projectId, autonomy: 'long' }, db)

    accumulateUsage(taskRun.id, { inputTokens: 10, outputTokens: 5, cost: 0.01 }, db)
    accumulateUsage(taskRun.id, { inputTokens: 20, outputTokens: 7, cost: 0.02 }, db)
    renewLease(taskRun.id, '2026-06-05T02:00:00.000Z', db)

    expect(getTaskRun(taskRun.id, db)).toMatchObject({
      totalInputTokens: 30,
      totalOutputTokens: 12,
      totalCost: 0.03,
      leaseExpiresAt: '2026-06-05T02:00:00.000Z'
    })
  })

  it('binds existing turns to a task run and epoch', () => {
    const taskRun = createTaskRun({ sessionId, worktreeId, projectId }, db)
    const epoch = appendEpoch({ taskRunId: taskRun.id, sessionId }, db)
    const turn = createAgentTurn(
      {
        sessionId,
        worktreeId,
        projectId,
        runtimeId: 'xuanpu-agent',
        userMessageId: 'msg-user-1'
      },
      db
    )

    bindTurnToTaskRun(turn.id, taskRun.id, epoch.id, db)

    expect(getAgentTurn(turn.id, db)).toMatchObject({
      id: turn.id,
      taskRunId: taskRun.id,
      epochId: epoch.id
    })
  })

  it('removes completed task runs from the active lookup', () => {
    const taskRun = createTaskRun({ sessionId, worktreeId, projectId }, db)

    updateTaskRunStatus(taskRun.id, 'completed', undefined, db)

    expect(getTaskRun(taskRun.id, db)).toMatchObject({
      status: 'completed',
      errorMessage: null
    })
    expect(getActiveTaskRun(sessionId, db)).toBeNull()
  })

  it('lists task runs for a session and epochs for a task run', () => {
    const first = createTaskRun({ sessionId, worktreeId, projectId, objective: 'first' }, db)
    const second = createTaskRun({ sessionId, worktreeId, projectId, objective: 'second' }, db)
    const epochA = appendEpoch({ taskRunId: second.id, sessionId }, db)
    const epochB = appendEpoch({ taskRunId: second.id, sessionId }, db)

    const runs = listTaskRunsForSession(sessionId, { limit: 10 }, db)
    expect(runs.map((run) => run.id)).toContain(first.id)
    expect(runs.map((run) => run.id)).toContain(second.id)

    expect(listEpochsForTaskRun(second.id, db).map((epoch) => epoch.id)).toEqual([
      epochA.id,
      epochB.id
    ])
  })
})
