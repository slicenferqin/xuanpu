import { describe, expect, test } from 'vitest'
import { extractMissionTasks } from '@/lib/session-tasks'
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

describe('extractMissionTasks', () => {
  test('extracts tasks from the latest assistant TodoWrite snapshot', () => {
    const messages: TimelineMessage[] = [
      message('old', 'assistant', 'TodoWrite', {
        todos: [{ id: 'old-1', content: 'Old task', status: 'completed' }]
      }),
      message('latest', 'assistant', 'mcp_todowrite', {
        todos: [
          { id: 'task-1', content: 'Read current implementation', status: 'completed' },
          { id: 'task-2', content: 'Extract helper', status: 'in_progress' }
        ]
      })
    ]

    expect(extractMissionTasks(messages)).toEqual([
      { id: 'task-1', content: 'Read current implementation', status: 'completed' },
      { id: 'task-2', content: 'Extract helper', status: 'in_progress' }
    ])
  })

  test('supports update_plan and existing fallback fields', () => {
    const messages: TimelineMessage[] = [
      message('plan', 'assistant', 'update_plan', {
        todos: [
          { subject: 'Subject fallback', status: 'pending' },
          { activeForm: 'Active form fallback' }
        ]
      })
    ]

    expect(extractMissionTasks(messages)).toEqual([
      { id: 'todo-0', content: 'Subject fallback', status: 'pending' },
      { id: 'todo-1', content: 'Active form fallback', status: 'pending' }
    ])
  })

  test('ignores non-assistant and non-TodoWrite tool parts', () => {
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

  test('continues scanning when the latest TodoWrite has no todos array', () => {
    const messages: TimelineMessage[] = [
      message('valid', 'assistant', 'todo_write', {
        todos: [{ id: 'valid-task', content: 'Use older valid snapshot', status: 'completed' }]
      }),
      message('invalid', 'assistant', 'TodoWrite', {
        todos: null
      })
    ]

    expect(extractMissionTasks(messages)).toEqual([
      { id: 'valid-task', content: 'Use older valid snapshot', status: 'completed' }
    ])
  })
})
