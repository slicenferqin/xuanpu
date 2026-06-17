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
  appendContextSegment,
  appendEpoch,
  bindTurnToTaskRun,
  closeEpoch,
  createTaskRun,
  createUserRound,
  getActiveTaskRun,
  getEpoch,
  getTaskRun,
  getUserRound,
  incrementEpochProviderCallCount,
  listContextSegmentsForTaskRun,
  listEpochsForTaskRun,
  listTaskRunsForSession,
  listUserRoundsForTaskRun,
  renewLease,
  updateEpochStartFillRatio,
  updateTaskRunStatus
} from '../../src/main/db/task-run-repository'
import {
  createAgentTurn,
  createAgentTurnContextSnapshot,
  getAgentTurn,
  getProviderRequestReplay,
  listProviderRequestSummariesForTaskRun
} from '../../src/main/db/turn-repository'

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
  it('keeps agent_task_runs free of removed mode columns', () => {
    const columns = db.getDb().pragma('table_info(agent_task_runs)') as Array<{ name: string }>

    expect(columns.map((column) => column.name)).not.toContain('autonomy')
  })

  it('creates a task run and finds it as active for the session', () => {
    const taskRun = createTaskRun(
      {
        sessionId,
        worktreeId,
        projectId,
        originMessageId: 'msg-user-1',
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
    const taskRun = createTaskRun({ sessionId, worktreeId, projectId }, db)

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

  it('models user rounds and context segments while preserving epoch storage compatibility', () => {
    const taskRun = createTaskRun({ sessionId, worktreeId, projectId }, db)
    const round = createUserRound(
      {
        taskRunId: taskRun.id,
        sessionId,
        origin: 'user-originated',
        userMessageId: 'msg-user-1',
        promptText: 'complete the objective'
      },
      db
    )
    const segment = appendContextSegment(
      {
        taskRunId: taskRun.id,
        sessionId,
        userRoundId: round.id,
        startFillRatio: 0.12
      },
      db
    )

    incrementEpochProviderCallCount(segment.id, db)
    incrementEpochProviderCallCount(segment.id, db)

    expect(getUserRound(round.id, db)).toMatchObject({
      id: round.id,
      taskRunId: taskRun.id,
      sessionId,
      ordinal: 0,
      origin: 'user-originated',
      status: 'running',
      contextSegmentCount: 1,
      providerRequestCount: 0
    })
    expect(listUserRoundsForTaskRun(taskRun.id, db).map((item) => item.id)).toEqual([round.id])
    expect(listContextSegmentsForTaskRun(taskRun.id, db)).toMatchObject([
      {
        id: segment.id,
        taskRunId: taskRun.id,
        userRoundId: round.id,
        ordinal: 0,
        providerCallCount: 2,
        startFillRatio: 0.12
      }
    ])
    expect(listEpochsForTaskRun(taskRun.id, db).map((item) => item.id)).toEqual([segment.id])
    expect(getTaskRun(taskRun.id, db)?.epochCount).toBe(1)
  })

  it('replays provider request snapshots by snapshot id', () => {
    const taskRun = createTaskRun({ sessionId, worktreeId, projectId }, db)
    const round = createUserRound(
      {
        taskRunId: taskRun.id,
        sessionId,
        origin: 'user-originated',
        userMessageId: 'msg-user-1',
        promptText: 'inspect provider input'
      },
      db
    )
    const segment = appendContextSegment(
      {
        taskRunId: taskRun.id,
        sessionId,
        userRoundId: round.id,
        startFillRatio: 0.2
      },
      db
    )
    const turn = createAgentTurn(
      {
        sessionId,
        worktreeId,
        projectId,
        runtimeId: 'xuanpu-agent',
        taskRunId: taskRun.id,
        userRoundId: round.id,
        epochId: segment.id,
        userMessageId: 'msg-user-1'
      },
      db
    )
    const snapshot = createAgentTurnContextSnapshot(
      {
        turnId: turn.id,
        sessionId,
        xfpPacketId: 'packet-1',
        taskRunId: taskRun.id,
        userRoundId: round.id,
        contextSegmentId: segment.id,
        contextSegmentOrdinal: segment.ordinal,
        providerCallSeq: 0,
        providerRequestHash: 'hash-123',
        prefixHash: 'prefix-123',
        managedContextJson: JSON.stringify({ zones: ['current'] }),
        providerMessagesJson: JSON.stringify({ promptMessage: { role: 'user' } }),
        providerToolsJson: JSON.stringify([{ name: 'read_file' }]),
        providerConfigJson: JSON.stringify({ providerID: 'openai', modelID: 'gpt-test' }),
        decisionsJson: JSON.stringify({ providerExecution: 'enabled' }),
        managedApproxTokens: 100,
        providerEstimatedInputTokens: 120,
        maxContextTokens: 150000
      },
      db
    )

    expect(listProviderRequestSummariesForTaskRun(taskRun.id, { limit: 5 }, db)).toMatchObject([
      {
        id: snapshot.id,
        turnId: turn.id,
        taskRunId: taskRun.id,
        userRoundId: round.id,
        contextSegmentId: segment.id,
        contextSegmentOrdinal: 0,
        providerRequestHash: 'hash-123'
      }
    ])
    expect(getProviderRequestReplay(snapshot.id, db)).toMatchObject({
      id: snapshot.id,
      turnId: turn.id,
      sessionId,
      xfpPacketId: 'packet-1',
      taskRunId: taskRun.id,
      userRoundId: round.id,
      contextSegmentId: segment.id,
      contextSegmentOrdinal: 0,
      providerCallSeq: 0,
      providerRequestHash: 'hash-123',
      prefixHash: 'prefix-123',
      managedContextJson: JSON.stringify({ zones: ['current'] }),
      providerMessagesJson: JSON.stringify({ promptMessage: { role: 'user' } }),
      providerToolsJson: JSON.stringify([{ name: 'read_file' }]),
      providerConfigJson: JSON.stringify({ providerID: 'openai', modelID: 'gpt-test' }),
      decisionsJson: JSON.stringify({ providerExecution: 'enabled' }),
      managedApproxTokens: 100,
      providerEstimatedInputTokens: 120,
      maxContextTokens: 150000
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
