export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
}

export interface TodoInput {
  todos: TodoItem[]
}

export type TodoToolStatus = 'pending' | 'running' | 'success' | 'error'

export interface TodoTrackerSnapshot {
  todos: TodoItem[]
  toolStatus: TodoToolStatus
}

export function isTodoWriteTool(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.includes('todowrite') || lower.includes('todo_write') || lower === 'update_plan'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeTodoStatus(value: unknown): TodoItem['status'] | null {
  switch (value) {
    case 'pending':
    case 'in_progress':
    case 'completed':
    case 'cancelled':
      return value
    case 'in-progress':
      return 'in_progress'
    case 'complete':
    case 'done':
      return 'completed'
    case 'canceled':
      return 'cancelled'
    default:
      return null
  }
}

function normalizeTodoPriority(value: unknown): TodoItem['priority'] {
  switch (value) {
    case 'high':
    case 'medium':
    case 'low':
      return value
    default:
      return 'medium'
  }
}

export function parseTodoItems(input: unknown): TodoItem[] {
  if (!isRecord(input) || !('todos' in input)) return []

  const candidate = (input as TodoInput).todos
  if (!Array.isArray(candidate)) return []

  return candidate.flatMap((item, index) => {
    if (!isRecord(item)) return []

    const content =
      typeof item.content === 'string'
        ? item.content.trim()
        : typeof item.activeForm === 'string'
          ? item.activeForm.trim()
          : ''
    const status = normalizeTodoStatus(item.status)

    if (!content || !status) return []

    return [
      {
        id:
          typeof item.id === 'string' && item.id.trim().length > 0
            ? item.id
            : `todo-${index}-${content}`,
        content,
        status,
        priority: normalizeTodoPriority(item.priority)
      }
    ]
  })
}

export function getTodoCounts(todos: TodoItem[]): {
  completed: number
  inProgress: number
  pending: number
  cancelled: number
} {
  let completed = 0
  let inProgress = 0
  let pending = 0
  let cancelled = 0

  for (const todo of todos) {
    if (todo.status === 'completed') completed++
    else if (todo.status === 'in_progress') inProgress++
    else if (todo.status === 'cancelled') cancelled++
    else pending++
  }

  return { completed, inProgress, pending, cancelled }
}

export function shouldShowTodoTracker(snapshot: TodoTrackerSnapshot | null): boolean {
  if (!snapshot || snapshot.todos.length === 0) return false

  const counts = getTodoCounts(snapshot.todos)
  const unresolvedCount = counts.pending + counts.inProgress

  if (unresolvedCount > 0) return true

  return snapshot.toolStatus === 'running' || snapshot.toolStatus === 'pending'
}
