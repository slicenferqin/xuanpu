import { isTodoWriteTool } from '@/lib/todo-utils'

export type TimelineCardType =
  | 'user-message'
  | 'system'
  | 'task-notification'
  | 'thinking'
  | 'bash'
  | 'file-read'
  | 'file-write'
  | 'search'
  | 'sub-agent'
  | 'plan'
  | 'ask-user'
  | 'todo'
  | 'tool-call'
  | 'text'

export function isBashToolName(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower === 'bash' ||
    lower === 'execute_command' ||
    lower.includes('bash') ||
    lower.includes('shell') ||
    lower.includes('exec')
  )
}

export function getTimelineCardTypeFromToolName(name: string | undefined): TimelineCardType {
  const toolName = name?.toLowerCase() ?? ''

  if (isBashToolName(toolName)) {
    return 'bash'
  }

  if (toolName === 'read' || toolName === 'readfile' || toolName === 'read_file') {
    return 'file-read'
  }

  if (
    toolName === 'write' ||
    toolName === 'edit' ||
    toolName === 'writefile' ||
    toolName === 'write_file' ||
    toolName === 'editfile' ||
    toolName === 'edit_file'
  ) {
    return 'file-write'
  }

  if (
    toolName === 'grep' ||
    toolName === 'glob' ||
    toolName === 'search' ||
    toolName === 'codebase_search'
  ) {
    return 'search'
  }

  if (toolName === 'agent' || toolName === 'subagent' || toolName === 'dispatch_agent') {
    return 'sub-agent'
  }

  if (toolName === 'exitplanmode' || toolName === 'exit_plan_mode') {
    return 'plan'
  }

  if (toolName === 'askuserquestion' || toolName === 'ask_user') {
    return 'ask-user'
  }

  if (
    isTodoWriteTool(toolName) ||
    toolName === 'taskcreate' ||
    toolName === 'task_create' ||
    toolName === 'taskupdate' ||
    toolName === 'task_update' ||
    toolName === 'todoread' ||
    toolName === 'todo_read' ||
    toolName === 'tasklist' ||
    toolName === 'task_list'
  ) {
    return 'todo'
  }

  return 'tool-call'
}
