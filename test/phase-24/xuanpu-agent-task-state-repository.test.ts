import { describe, expect, it } from 'vitest'

import type { DatabaseService } from '../../src/main/db/database'
import type { AgentTaskState } from '../../src/shared/types/agent-task-state'
import {
  addContext,
  addDecision,
  addStep,
  createTaskState,
  getTaskState
} from '../../src/main/db/task-state-repository'
import { TaskStateManager } from '../../src/main/services/xuanpu-agent/task-state-manager'

interface StoredTaskStateRow {
  id: string
  taskRunId: string
  sessionId: string
  objective: string
  steps: string
  currentBlocker: string | null
  decisions: string
  relevantContext: string
  updatedAt: string
}

function createFakeTaskStateDb(): DatabaseService {
  const rows = new Map<string, StoredTaskStateRow>()
  const sqlite = {
    prepare(sql: string) {
      return {
        run: (...args: unknown[]) => {
          if (sql.includes('INSERT INTO agent_task_states')) {
            const [
              id,
              taskRunId,
              sessionId,
              objective,
              steps,
              currentBlocker,
              decisions,
              relevantContext,
              updatedAt
            ] = args
            rows.set(taskRunId as string, {
              id: id as string,
              taskRunId: taskRunId as string,
              sessionId: sessionId as string,
              objective: objective as string,
              steps: steps as string,
              currentBlocker: currentBlocker as string | null,
              decisions: decisions as string,
              relevantContext: relevantContext as string,
              updatedAt: updatedAt as string
            })
            return
          }

          if (sql.includes('UPDATE agent_task_states')) {
            const [
              objective,
              steps,
              currentBlocker,
              decisions,
              relevantContext,
              updatedAt,
              taskRunId
            ] = args
            const existing = rows.get(taskRunId as string)
            if (!existing) return
            rows.set(taskRunId as string, {
              ...existing,
              objective: objective as string,
              steps: steps as string,
              currentBlocker: currentBlocker as string | null,
              decisions: decisions as string,
              relevantContext: relevantContext as string,
              updatedAt: updatedAt as string
            })
            return
          }

          if (sql.includes('DELETE FROM agent_task_states')) {
            rows.delete(args[0] as string)
          }
        },
        get: (taskRunId: string) => rows.get(taskRunId)
      }
    }
  }

  return { getDb: () => sqlite } as unknown as DatabaseService
}

describe('xuanpu-agent task-state repository', () => {
  it('creates and reads task state for a task run', () => {
    const db = createFakeTaskStateDb()
    const state = createTaskState(
      {
        taskRunId: 'task-run-1',
        sessionId: 'session-1',
        objective: 'Implement bounded long task context'
      },
      db
    )

    expect(getTaskState('task-run-1', db)).toMatchObject({
      id: state.id,
      taskRunId: 'task-run-1',
      sessionId: 'session-1',
      objective: 'Implement bounded long task context',
      steps: [],
      currentBlocker: null,
      decisions: [],
      relevantContext: []
    })
  })

  it('keeps task state arrays bounded as turns accumulate', () => {
    const db = createFakeTaskStateDb()
    createTaskState({ taskRunId: 'task-run-1', sessionId: 'session-1', objective: 'Long task' }, db)

    for (let index = 0; index < 140; index++) {
      addStep(
        'task-run-1',
        {
          id: `step-${index}`,
          description: `step ${index}`,
          status: 'completed'
        },
        db
      )
    }
    for (let index = 0; index < 70; index++) {
      addDecision(
        'task-run-1',
        {
          id: `decision-${index}`,
          context: 'test',
          decision: `decision ${index}`,
          reason: 'test',
          timestamp: new Date().toISOString()
        },
        db
      )
    }
    for (let index = 0; index < 120; index++) {
      addContext(
        'task-run-1',
        {
          id: `ctx-${index}`,
          type: 'file',
          content: `file-${index}.ts`,
          relevance: 0.8,
          timestamp: new Date().toISOString()
        },
        db
      )
    }

    const state = getTaskState('task-run-1', db)
    expect(state?.steps).toHaveLength(120)
    expect(state?.steps[0].id).toBe('step-20')
    expect(state?.decisions).toHaveLength(60)
    expect(state?.decisions[0].id).toBe('decision-10')
    expect(state?.relevantContext).toHaveLength(100)
    expect(state?.relevantContext[0].id).toBe('ctx-20')
  })

  it('manager initializes once and updates from a turn', () => {
    const db = createFakeTaskStateDb()
    const manager = new TaskStateManager({ taskRunId: 'task-run-1', sessionId: 'session-1', db })
    const first = manager.initialize('Implement bounded long task context')
    const second = manager.initialize('Different objective should not overwrite')

    expect(second.id).toBe(first.id)

    const updated = manager.updateFromTurn({
      userMessage: '继续',
      assistantMessage: '我决定采用 task state 作为短记忆。',
      toolCalls: [
        {
          name: 'read_file',
          args: { path: 'src/main.ts' },
          result: 'ok'
        },
        {
          name: 'run_test',
          args: { command: 'pnpm test' },
          result: 'failed',
          isError: true
        }
      ],
      filesChanged: ['src/main.ts'],
      errors: ['run_test failed']
    }) as AgentTaskState

    expect(updated.steps.map((step) => step.status)).toEqual(['completed', 'failed'])
    expect(updated.currentBlocker).toBe('run_test failed')
    expect(updated.decisions[0].decision).toContain('决定采用 task state')
    expect(manager.buildContextSummary()).toContain('## Task Objective')
    expect(manager.buildContextSummary()).toContain('run_test failed')
  })

  it('does not persist misleading execution-budget claims as decisions', () => {
    const db = createFakeTaskStateDb()
    const manager = new TaskStateManager({ taskRunId: 'task-run-1', sessionId: 'session-1', db })
    manager.initialize('Review recent commits')

    const updated = manager.updateFromTurn({
      userMessage: '继续',
      assistantMessage:
        '本轮没有可用工具预算，无法继续读取文件、改代码或跑测试；因此没有新增诊断结论，也没有应用任何变更。',
      toolCalls: [
        {
          name: 'git_status',
          args: {},
          result: 'Branch: feat/xuanpu-agent-oh-my-pi'
        }
      ],
      filesChanged: [],
      errors: []
    }) as AgentTaskState

    expect(updated.decisions).toHaveLength(0)
    expect(manager.buildContextSummary()).not.toContain('没有可用工具预算')
  })
})
