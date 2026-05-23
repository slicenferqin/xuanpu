import { describe, expect, test } from 'vitest'
import {
  extractMissionTasks,
  getSessionTaskDisplayTitle,
  sortSessionTasks,
  type SessionTask
} from '@/lib/session-tasks'
import type { TimelineMessage, ToolUseInfo } from '@shared/lib/timeline-types'

function toolUse(name: string, input: Record<string, unknown>): ToolUseInfo {
  return {
    id: `${name}-1`,
    name,
    input,
    status: 'success',
    startTime: 1
  }
}

function message(
  id: string,
  role: TimelineMessage['role'],
  toolName: string,
  input: Record<string, unknown>
): TimelineMessage {
  return {
    id,
    role,
    content: '',
    timestamp: '2026-05-21T00:00:00.000Z',
    parts: [
      {
        type: 'tool_use',
        toolUse: toolUse(toolName, input)
      }
    ]
  }
}

function userMessage(id: string, content: string): TimelineMessage {
  return {
    id,
    role: 'user',
    content,
    timestamp: '2026-05-21T00:00:00.000Z'
  }
}

describe('extractMissionTasks', () => {
  test('replays mixed task tool events into the latest canonical state', () => {
    const messages: TimelineMessage[] = [
      message('snapshot', 'assistant', 'TodoWrite', {
        todos: [
          { id: 'task-1', content: 'Read current implementation', status: 'pending' },
          { id: 'task-2', content: 'Extract helper', status: 'pending' }
        ]
      }),
      message('create', 'assistant', 'TaskCreate', {
        taskId: 'task-3',
        subject: 'Add grouped task panel',
        description: 'Render grouped sections in the right panel'
      }),
      message('update-existing', 'assistant', 'TaskUpdate', {
        taskId: 'task-2',
        status: 'in-progress',
        description: 'Helper extraction is underway'
      }),
      message('update-created', 'assistant', 'task_update', {
        taskId: 'task-3',
        status: 'done'
      })
    ]

    expect(extractMissionTasks(messages)).toEqual([
      { id: 'task-1', content: 'Read current implementation', status: 'pending' },
      {
        id: 'task-2',
        content: 'Helper extraction is underway',
        status: 'in_progress',
        description: 'Helper extraction is underway'
      },
      {
        id: 'task-3',
        content: 'Add grouped task panel',
        status: 'completed',
        subject: 'Add grouped task panel',
        description: 'Render grouped sections in the right panel'
      }
    ])
  })

  test('supports TaskCreate and TaskUpdate without a TodoWrite snapshot', () => {
    const messages: TimelineMessage[] = [
      message('create', 'assistant', 'task_create', {
        taskId: 'task-1',
        subject: 'Create reducer helpers',
        status: 'pending'
      }),
      message('update', 'assistant', 'TaskUpdate', {
        taskId: 'task-1',
        status: 'done',
        activeForm: 'Reducer helpers implemented'
      })
    ]

    expect(extractMissionTasks(messages)).toEqual([
      {
        id: 'task-1',
        content: 'Reducer helpers implemented',
        status: 'completed',
        subject: 'Create reducer helpers',
        activeForm: 'Reducer helpers implemented'
      }
    ])
  })

  test('upserts duplicate TaskCreate entries by id instead of duplicating tasks', () => {
    const messages: TimelineMessage[] = [
      message('create-1', 'assistant', 'TaskCreate', {
        taskId: 'task-1',
        subject: 'Investigate task duplication'
      }),
      message('create-2', 'assistant', 'task_create', {
        taskId: 'task-1',
        description: 'Keep the same task id while adding details'
      })
    ]

    expect(extractMissionTasks(messages)).toEqual([
      {
        id: 'task-1',
        content: 'Investigate task duplication',
        status: 'pending',
        subject: 'Investigate task duplication',
        description: 'Keep the same task id while adding details'
      }
    ])
  })

  test('continues to support update_plan fallback fields', () => {
    const messages: TimelineMessage[] = [
      message('plan', 'assistant', 'update_plan', {
        todos: [
          { subject: 'Subject fallback', status: 'pending' },
          { activeForm: 'Active form fallback' }
        ]
      })
    ]

    expect(extractMissionTasks(messages)).toEqual([
      { id: 'todo-0', content: 'Subject fallback', status: 'pending', subject: 'Subject fallback' },
      {
        id: 'todo-1',
        content: 'Active form fallback',
        status: 'pending',
        activeForm: 'Active form fallback'
      }
    ])
  })

  test('ignores non-assistant and non-task tool parts', () => {
    const messages: TimelineMessage[] = [
      message('user-tool', 'user', 'TodoWrite', {
        todos: [{ id: 'user-task', content: 'Ignore user role', status: 'pending' }]
      }),
      message('write', 'assistant', 'Write', {
        todos: [{ id: 'write-task', content: 'Ignore write tool', status: 'pending' }]
      })
    ]

    expect(extractMissionTasks(messages)).toEqual([])
  })

  test('returns only the latest round tasks when multiple rounds exist', () => {
    const messages: TimelineMessage[] = [
      userMessage('user-1', 'First prompt'),
      message('round-1', 'assistant', 'TodoWrite', {
        todos: [
          { id: 'task-old-1', content: 'Old task 1', status: 'completed' },
          { id: 'task-old-2', content: 'Old task 2', status: 'pending' }
        ]
      }),
      userMessage('user-2', 'Second prompt'),
      message('round-2', 'assistant', 'TodoWrite', {
        todos: [
          { id: 'task-new-1', content: 'Inspect session tasks', status: 'in_progress' },
          { id: 'task-new-2', content: 'Update UI', status: 'pending' }
        ]
      })
    ]

    const result = extractMissionTasks(messages)
    expect(result.map((t) => t.id)).toEqual(['task-new-1', 'task-new-2'])
    expect(result.map((t) => t.content)).not.toContain('Old task')
  })

  test('falls back to earlier round if latest round has no tasks', () => {
    const messages: TimelineMessage[] = [
      userMessage('user-1', 'First prompt'),
      message('round-1', 'assistant', 'TodoWrite', {
        todos: [{ id: 'task-1', content: 'Read the README', status: 'pending' }]
      }),
      userMessage('user-2', 'Second prompt'),
      message('round-2', 'assistant', 'Write', {
        file: 'src/main/index.ts'
      })
    ]

    const result = extractMissionTasks(messages)
    expect(result.map((t) => t.id)).toEqual(['task-1'])
  })

  test('falls back to full session scan if no round has tasks', () => {
    const messages: TimelineMessage[] = [
      userMessage('user-1', 'First prompt'),
      message('round-1', 'assistant', 'Bash', { command: 'ls' }),
      userMessage('user-2', 'Second prompt'),
      message('round-2', 'assistant', 'Read', { file: 'package.json' }),
      message('fallback', 'assistant', 'TodoWrite', {
        todos: [{ id: 'fallback-task', content: 'Fallback task', status: 'pending' }]
      })
    ]

    const result = extractMissionTasks(messages)
    expect(result.map((t) => t.id)).toEqual(['fallback-task'])
  })
})

describe('sortSessionTasks', () => {
  test('orders in progress before pending before completed while keeping stable ties', () => {
    const tasks: SessionTask[] = [
      { id: 'task-1', content: 'Completed task', status: 'completed' },
      { id: 'task-2', content: 'Pending task', status: 'pending' },
      { id: 'task-3', content: 'Working task', status: 'in_progress' },
      { id: 'task-4', content: 'High priority pending', status: 'pending', priority: 'high' }
    ]

    expect(sortSessionTasks(tasks).map((task) => task.id)).toEqual([
      'task-3',
      'task-4',
      'task-2',
      'task-1'
    ])
  })
})

describe('getSessionTaskDisplayTitle', () => {
  test('returns Chinese display title for English task content', () => {
    const task: SessionTask = {
      id: 'task-1',
      content: 'Inspect session task implementation',
      status: 'pending'
    }
    expect(getSessionTaskDisplayTitle(task)).toBe('查看会话任务实现')
  })

  test('returns Chinese display title for task with subject', () => {
    const task: SessionTask = {
      id: 'task-2',
      content: 'Implement task panel',
      subject: 'Implement task panel',
      status: 'pending'
    }
    expect(getSessionTaskDisplayTitle(task)).toBe('实现任务面板')
  })

  test('returns Chinese for task with Chinese content directly', () => {
    const task: SessionTask = {
      id: 'task-3',
      content: '查看右侧任务列表',
      status: 'pending'
    }
    expect(getSessionTaskDisplayTitle(task)).toBe('查看右侧任务列表')
  })

  test('returns fallback label for task with empty content', () => {
    const task: SessionTask = {
      id: 'task-4',
      content: '',
      status: 'pending'
    }
    expect(getSessionTaskDisplayTitle(task)).toBe('任务')
    expect(getSessionTaskDisplayTitle(task, 2)).toBe('任务 3')
  })

  test('keeps short Chinese content without truncation', () => {
    const task: SessionTask = {
      id: 'task-5',
      content: '查看会话任务实现并更新相关UI组件以及测试用例',
      status: 'pending'
    }
    const result = getSessionTaskDisplayTitle(task)
    expect(result).toBe('查看会话任务实现并更新相关UI组件以及测试用例')
    expect(result.endsWith('…')).toBe(false)
  })

  test('derives Chinese verbs from common English patterns', () => {
    expect(getSessionTaskDisplayTitle({ id: '1', content: 'Fix authentication bug', status: 'pending' })).toBe('修复认证问题')
    expect(getSessionTaskDisplayTitle({ id: '2', content: 'Test the new API', status: 'pending' })).toBe('验证新 API')
    expect(getSessionTaskDisplayTitle({ id: '3', content: 'Add task panel', status: 'pending' })).toBe('实现任务面板')
    expect(getSessionTaskDisplayTitle({ id: '4', content: 'Analyze codebase structure', status: 'pending' })).toBe('分析代码库结构')
  })
})
