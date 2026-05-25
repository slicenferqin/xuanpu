import { isTodoWriteTool } from '@/components/sessions/tools/todo-utils'
import type { TodoItem } from '@/components/sessions/tools/todo-utils'
import type { TimelineMessage } from '@shared/lib/timeline-types'

export type SessionTaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'error'

export interface SessionTask {
  id: string
  content: string
  status: SessionTaskStatus
  subject?: string
  description?: string
  activeForm?: string
  priority?: TodoItem['priority']
}

type SortableTaskLike = {
  id?: string
  status?: string
  priority?: string
}

type SessionTaskSource = Pick<
  SessionTask,
  'content' | 'subject' | 'description' | 'activeForm' | 'status' | 'priority'
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function containsCjk(value: string): boolean {
  return /[㐀-鿿]/.test(value)
}

function humanizeEnglishTaskTarget(value: string): string {
  const lowered = compactWhitespace(value)
    .toLowerCase()
    .replace(/^[a-z]+ing\s+/, '')
    .replace(/^(to\s+)?(read|inspect|check|review|look\s+through|look\s+at)\s+/, '')
    .replace(/^(to\s+)?(update|change|adjust|refactor|move)\s+/, '')
    .replace(/^(to\s+)?(test|verify|validate)\s+/, '')
    .replace(/^(to\s+)?(implement|build|create|add|render|show|display)\s+/, '')
    .replace(/^(to\s+)?(fix|debug|resolve)\s+/, '')
    .replace(/^(to\s+)?(analyze|analyse|investigate|understand|explore)\s+/, '')
    .replace(/^(to\s+)?(optimize|optimise|improve|polish)\s+/, '')
    .replace(/^(to\s+)?extract\s+/, '')
    .replace(/^(the|a|an|current|existing|latest)\s+/, '')
    .replace(/\b(current|existing|latest)\b/g, '')
    .replace(/[_.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (lowered.includes('session task implementation')) return '会话任务实现'
  if (lowered.includes('codebase structure')) return '代码库结构'
  if (lowered.includes('authentication bug')) return '认证问题'
  if (lowered.includes('new api') || lowered.includes('api')) return '新 API'
  if (lowered.includes('task panel') || lowered.includes('todo panel')) return '任务面板'
  if (lowered.includes('context panel')) return '右侧面板'
  if (lowered.includes('timeline')) return '时间线'
  if (lowered.includes('task list')) return '任务列表'
  if (lowered.includes('task snapshot')) return '任务快照'
  if (lowered.includes('task')) return '任务'
  if (lowered.includes('implementation')) return '实现'
  if (lowered.includes('helper')) return '辅助逻辑'
  if (lowered.includes('round')) return '轮次逻辑'
  if (lowered.includes('session')) return '会话逻辑'
  if (lowered.includes('ui') || lowered.includes('ux')) return '界面'
  if (lowered.includes('test')) return '测试'
  if (lowered.includes('style')) return '样式'
  if (lowered.includes('prompt')) return '提示词'
  return '相关内容'
}

function chooseChineseTaskVerb(value: string): string {
  const lowered = compactWhitespace(value).toLowerCase()

  if (
    /(inspect|read|review|check|look\s+through|look\s+at|audit|scan|browse)/.test(lowered)
  ) {
    return '查看'
  }
  if (/(update|change|adjust|refactor|move|rename|rewrite)/.test(lowered)) {
    return '更新'
  }
  if (/(test|verify|validate|confirm)/.test(lowered)) {
    return '验证'
  }
  if (/(implement|build|create|add|render|show|display)/.test(lowered)) {
    return '实现'
  }
  if (/(fix|debug|resolve|repair)/.test(lowered)) {
    return '修复'
  }
  if (/(analyze|analyse|investigate|understand|explore|research)/.test(lowered)) {
    return '分析'
  }
  if (/(optimize|optimise|improve|polish|tune)/.test(lowered)) {
    return '优化'
  }
  if (/extract/.test(lowered)) {
    return '提取'
  }
  return '处理'
}

function getTaskSourceText(task: SessionTaskSource): string {
  return compactWhitespace(task.subject || task.content || task.activeForm || task.description || '')
}

export function getSessionTaskDisplayTitle(
  task: SessionTaskSource,
  index?: number
): string {
  const source = getTaskSourceText(task)
  if (!source) {
    return typeof index === 'number' ? `任务 ${index + 1}` : '任务'
  }

  if (containsCjk(source)) {
    return source.length > 32 ? `${source.slice(0, 32)}…` : source
  }

  const verb = chooseChineseTaskVerb(source)
  const target = humanizeEnglishTaskTarget(source)
  return `${verb}${target}`
}

export function getSessionTaskRawDetail(task: SessionTaskSource, displayTitle?: string): string | undefined {
  const detailCandidates = [task.description, task.content, task.subject, task.activeForm]
    .filter((value): value is string => typeof value === 'string' && compactWhitespace(value).length > 0)
    .map((value) => compactWhitespace(value))

  const normalizedDisplayTitle = displayTitle ? compactWhitespace(displayTitle) : ''
  return detailCandidates.find((candidate) => candidate !== normalizedDisplayTitle)
}

export function normalizeSessionTaskStatus(value: unknown): SessionTaskStatus {
  switch (value) {
    case 'in_progress':
    case 'pending':
    case 'completed':
    case 'cancelled':
    case 'error':
      return value
    case 'in-progress':
      return 'in_progress'
    case 'complete':
    case 'done':
      return 'completed'
    case 'canceled':
      return 'cancelled'
    case 'blocked':
      return 'error'
    default:
      return 'pending'
  }
}

export function normalizeSessionTaskPriority(value: unknown): TodoItem['priority'] | undefined {
  switch (value) {
    case 'high':
    case 'medium':
    case 'low':
      return value
    default:
      return undefined
  }
}

export function getSessionTaskContent(input: Record<string, unknown>): string {
  if (typeof input.content === 'string' && input.content.trim().length > 0) {
    return input.content.trim()
  }
  if (typeof input.subject === 'string' && input.subject.trim().length > 0) {
    return input.subject.trim()
  }
  if (typeof input.activeForm === 'string' && input.activeForm.trim().length > 0) {
    return input.activeForm.trim()
  }
  if (typeof input.description === 'string' && input.description.trim().length > 0) {
    return input.description.trim()
  }
  return ''
}

function getSessionTaskId(input: Record<string, unknown>, fallback: string): string {
  const rawId = input.taskId ?? input.id
  if (typeof rawId === 'string' && rawId.trim().length > 0) {
    return rawId.trim()
  }
  return fallback
}

function taskFromRecord(input: Record<string, unknown>, fallbackId: string): SessionTask | null {
  const content = getSessionTaskContent(input)
  const status = normalizeSessionTaskStatus(input.status)
  const subject = typeof input.subject === 'string' && input.subject.trim() ? input.subject.trim() : undefined
  const description =
    typeof input.description === 'string' && input.description.trim()
      ? input.description.trim()
      : undefined
  const activeForm =
    typeof input.activeForm === 'string' && input.activeForm.trim() ? input.activeForm.trim() : undefined

  if (!content && !subject && !description && !activeForm) {
    return null
  }

  return {
    id: getSessionTaskId(input, fallbackId),
    content,
    status,
    ...(subject ? { subject } : {}),
    ...(description ? { description } : {}),
    ...(activeForm ? { activeForm } : {}),
    ...(normalizeSessionTaskPriority(input.priority)
      ? { priority: normalizeSessionTaskPriority(input.priority) }
      : {})
  }
}

function mergeSessionTask(existing: SessionTask | undefined, incoming: SessionTask): SessionTask {
  return {
    id: incoming.id || existing?.id || 'task',
    content: incoming.content || existing?.content || incoming.subject || existing?.subject || '',
    status: incoming.status ?? existing?.status ?? 'pending',
    subject: incoming.subject ?? existing?.subject,
    description: incoming.description ?? existing?.description,
    activeForm: incoming.activeForm ?? existing?.activeForm,
    priority: incoming.priority ?? existing?.priority
  }
}

function applyTodoSnapshot(current: SessionTask[], input: unknown): SessionTask[] {
  if (!isRecord(input) || !Array.isArray(input.todos)) {
    return current
  }

  return input.todos.flatMap((todo, index) => {
    if (!isRecord(todo)) return []
    const task = taskFromRecord(todo, `todo-${index}`)
    return task ? [task] : []
  })
}

function upsertSessionTask(current: SessionTask[], task: SessionTask): SessionTask[] {
  const index = current.findIndex((existing) => existing.id === task.id)
  if (index === -1) {
    return [...current, task]
  }

  const next = [...current]
  next[index] = mergeSessionTask(next[index], task)
  return next
}

function patchSessionTask(current: SessionTask[], task: SessionTask): SessionTask[] {
  return upsertSessionTask(current, task)
}

export function applySessionTaskToolEvent(
  current: SessionTask[],
  toolName: string | undefined,
  input: unknown,
  toolUseId?: string
): SessionTask[] {
  const lowerToolName = toolName?.toLowerCase() ?? ''

  if (isTodoWriteTool(lowerToolName)) {
    return applyTodoSnapshot(current, input)
  }

  if (lowerToolName === 'taskcreate' || lowerToolName === 'task_create') {
    if (!isRecord(input)) return current
    // toolUseId 是 stable 的（callID 在整个 tool 生命周期里不变），用它当 fallback
    // 才能保证流式期间多次 message.part.updated 触发 reducer 时 upsert 命中同一行，
    // 否则会走 `task-${current.length + 1}` 这种位置 fallback，每次 +1 都会被
    // 当作新任务，导致右侧任务列表重复（且后续 TaskUpdate 找不到 id 没法更新状态）。
    const fallbackId =
      typeof toolUseId === 'string' && toolUseId.length > 0
        ? toolUseId
        : `task-${current.length + 1}`
    const task = taskFromRecord(input, fallbackId)
    if (!task) return current

    const existing = current.find((candidate) => candidate.id === task.id)
    if (
      existing &&
      typeof input.content !== 'string' &&
      typeof input.subject !== 'string' &&
      typeof input.activeForm !== 'string'
    ) {
      return upsertSessionTask(current, {
        ...task,
        content: existing.content,
        subject: task.subject ?? existing.subject,
        activeForm: task.activeForm ?? existing.activeForm
      })
    }

    return upsertSessionTask(current, task)
  }

  if (lowerToolName === 'taskupdate' || lowerToolName === 'task_update') {
    if (!isRecord(input)) return current
    const taskId = getSessionTaskId(input, toolUseId ?? '')
    if (!taskId) return current
    const existing = current.find((task) => task.id === taskId)
    const content = getSessionTaskContent(input) || existing?.content || existing?.subject || ''
    const task: SessionTask = {
      id: taskId,
      content,
      status: normalizeSessionTaskStatus(input.status ?? existing?.status),
      ...(typeof input.subject === 'string' && input.subject.trim()
        ? { subject: input.subject.trim() }
        : existing?.subject
          ? { subject: existing.subject }
          : {}),
      ...(typeof input.description === 'string' && input.description.trim()
        ? { description: input.description.trim() }
        : existing?.description
          ? { description: existing.description }
          : {}),
      ...(typeof input.activeForm === 'string' && input.activeForm.trim()
        ? { activeForm: input.activeForm.trim() }
        : existing?.activeForm
          ? { activeForm: existing.activeForm }
          : {}),
      ...(normalizeSessionTaskPriority(input.priority) ?? existing?.priority
        ? { priority: normalizeSessionTaskPriority(input.priority) ?? existing?.priority }
        : {})
    }
    if (!task.content && !task.subject && !task.description && !task.activeForm) {
      return current
    }
    return patchSessionTask(current, task)
  }

  return current
}

function extractRoundTasks(messages: TimelineMessage[]): SessionTask[] {
  let tasks: SessionTask[] = []

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue

    for (const part of msg.parts ?? []) {
      if (part.type !== 'tool_use' || !part.toolUse) continue
      tasks = applySessionTaskToolEvent(
        tasks,
        part.toolUse.name,
        part.toolUse.input,
        part.toolUse.id
      )
    }
  }

  return tasks
}

export function extractMissionTasks(messages: TimelineMessage[]): SessionTask[] {
  let currentRound: TimelineMessage[] = []
  const rounds: TimelineMessage[][] = []

  for (const message of messages) {
    if (message.role === 'user') {
      if (currentRound.length > 0) {
        rounds.push(currentRound)
      }
      currentRound = [message]
      continue
    }

    if (currentRound.length > 0) {
      currentRound.push(message)
    }
  }

  if (currentRound.length > 0) {
    rounds.push(currentRound)
  }

  for (let index = rounds.length - 1; index >= 0; index--) {
    const tasks = extractRoundTasks(rounds[index])
    if (tasks.length > 0) {
      return tasks
    }
  }

  return extractRoundTasks(messages)
}

function getStatusRank(status: string | undefined): number {
  switch (status) {
    case 'in_progress':
    case 'in-progress':
      return 0
    case 'pending':
      return 1
    case 'completed':
    case 'done':
      return 2
    case 'cancelled':
    case 'canceled':
      return 3
    case 'error':
    case 'blocked':
      return 4
    default:
      return 1
  }
}

function getPriorityRank(priority: string | undefined): number {
  switch (priority) {
    case 'high':
      return 0
    case 'medium':
      return 1
    case 'low':
      return 2
    default:
      return 1
  }
}

export function sortSessionTaskLikeItems<T extends SortableTaskLike>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const statusDelta = getStatusRank(a.item.status) - getStatusRank(b.item.status)
      if (statusDelta !== 0) return statusDelta

      const priorityDelta = getPriorityRank(a.item.priority) - getPriorityRank(b.item.priority)
      if (priorityDelta !== 0) return priorityDelta

      return a.index - b.index
    })
    .map(({ item }) => item)
}

export function sortSessionTasks(tasks: SessionTask[]): SessionTask[] {
  return sortSessionTaskLikeItems(tasks)
}

export function getSessionTaskCounts(tasks: Array<{ status: string }>): {
  completed: number
  inProgress: number
  pending: number
  cancelled: number
  error: number
} {
  let completed = 0
  let inProgress = 0
  let pending = 0
  let cancelled = 0
  let error = 0

  for (const task of tasks) {
    const status = normalizeSessionTaskStatus(task.status)
    if (status === 'completed') completed++
    else if (status === 'in_progress') inProgress++
    else if (status === 'cancelled') cancelled++
    else if (status === 'error') error++
    else pending++
  }

  return { completed, inProgress, pending, cancelled, error }
}
