import { describe, expect, test } from 'vitest'
import {
  isTodoWriteTool,
  parseTodoItems,
  shouldShowTodoTracker
} from '@/components/sessions/tools/todo-utils'

describe('todo utils', () => {
  test('recognizes TodoWrite tool names', () => {
    expect(isTodoWriteTool('TodoWrite')).toBe(true)
    expect(isTodoWriteTool('mcp_todowrite')).toBe(true)
    expect(isTodoWriteTool('todo_write')).toBe(true)
    expect(isTodoWriteTool('update_plan')).toBe(true)
    expect(isTodoWriteTool('Write')).toBe(false)
  })

  test('parses todo items from tool input', () => {
    const todos = parseTodoItems({
      todos: [
        {
          id: '1',
          content: 'Refactor file tree',
          status: 'in_progress',
          priority: 'high'
        }
      ]
    })

    expect(todos).toHaveLength(1)
    expect(todos[0]?.content).toBe('Refactor file tree')
  })

  test('parses claude TodoWrite payloads without id or priority', () => {
    const todos = parseTodoItems({
      todos: [
        {
          content: '探索项目结构，定位文件树组件和图标相关代码',
          status: 'in_progress',
          activeForm: '探索项目结构，定位文件树组件和图标相关代码'
        },
        {
          content: '优化文件树图标样式（颜色、大小、间距等）',
          status: 'pending',
          activeForm: '优化文件树图标样式（颜色、大小、间距等）'
        }
      ]
    })

    expect(todos).toHaveLength(2)
    expect(todos[0]).toMatchObject({
      content: '探索项目结构，定位文件树组件和图标相关代码',
      status: 'in_progress',
      priority: 'medium'
    })
    expect(todos[0]?.id).toContain('todo-0-')
    expect(todos[1]).toMatchObject({
      content: '优化文件树图标样式（颜色、大小、间距等）',
      status: 'pending',
      priority: 'medium'
    })
  })

  test('shows tracker only while there are unresolved tasks', () => {
    expect(
      shouldShowTodoTracker({
        toolStatus: 'running',
        todos: [
          {
            id: '1',
            content: 'Active task',
            status: 'in_progress',
            priority: 'medium'
          }
        ]
      })
    ).toBe(true)

    expect(
      shouldShowTodoTracker({
        toolStatus: 'success',
        todos: [
          {
            id: '1',
            content: 'Done task',
            status: 'completed',
            priority: 'medium'
          }
        ]
      })
    ).toBe(false)
  })
})
