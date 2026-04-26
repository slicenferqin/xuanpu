/**
 * TodoCard — Renders task list operations (TodoWrite, TaskCreate, TaskUpdate, etc.)
 *
 * Supports two modes:
 *   1. toolUse mode — renders from a single tool_use (normal timeline rendering)
 *   2. tasks mode — renders from an aggregated task list (final card after MissionControl)
 */

import React from 'react'
import { ActionCard } from './ActionCard'
import { CheckCircle2, Circle, Loader2, AlertCircle } from 'lucide-react'
import type { ToolUseInfo } from '@shared/lib/timeline-types'

interface TodoCardPropsToolUse {
  toolUse: ToolUseInfo
  tasks?: never
}

interface TodoCardPropsTasks {
  toolUse?: never
  /** Aggregated task list — used for the final card after MissionControl fades */
  tasks: Array<{ id: string; content: string; status: string }>
}

type TodoCardProps = TodoCardPropsToolUse | TodoCardPropsTasks

interface TodoItem {
  id?: string
  /** claude-code shape */
  content?: string
  subject?: string
  description?: string
  activeForm?: string
  /** codex turn/plan/updated shape — same semantic as content */
  step?: string
  status?: string
  priority?: string
}

function parseItems(toolUse: ToolUseInfo): TodoItem[] {
  const input = toolUse.input ?? {}

  // TodoWrite sends { todos: [...] }
  if (Array.isArray(input.todos)) {
    return input.todos as TodoItem[]
  }

  // TaskCreate sends { subject, description, ... }
  if (input.subject) {
    return [input as TodoItem]
  }

  // Try to parse from output (the result may contain the task list)
  if (toolUse.output) {
    try {
      const parsed = JSON.parse(toolUse.output)
      if (Array.isArray(parsed)) return parsed as TodoItem[]
      if (parsed?.todos && Array.isArray(parsed.todos)) return parsed.todos as TodoItem[]
    } catch {
      // not JSON — ignore
    }
  }

  return []
}

function StatusIcon({ status }: { status?: string }): React.JSX.Element {
  switch (status) {
    case 'completed':
    case 'done':
      return <CheckCircle2 className="h-3.5 w-3.5 text-celadon shrink-0" />
    case 'in_progress':
    case 'in-progress':
      return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />
    case 'error':
    case 'blocked':
      return <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
    default:
      return <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
  }
}

function TaskRow({ item, index }: { item: TodoItem; index: number }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <StatusIcon status={item.status} />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-foreground">
          {item.step ?? item.content ?? item.subject ?? item.activeForm ?? item.description ?? `Task ${index + 1}`}
        </div>
        {(item.subject || item.content || item.step) && item.description && (
          <div className="text-xs text-muted-foreground mt-0.5 truncate">
            {item.description}
          </div>
        )}
      </div>
    </div>
  )
}

export function TodoCard(props: TodoCardProps): React.JSX.Element {
  // --- Aggregated tasks mode ---
  if (props.tasks) {
    const allDone = props.tasks.every((t) => t.status === 'completed')
    return (
      <ActionCard
        accentClass="border-celadon/30"
        headerClass="border-b-celadon/20 text-celadon"
        headerLeft={<span className="font-semibold">Task List</span>}
        headerRight={allDone ? 'Done' : 'In progress'}
        defaultExpanded
        collapsible={props.tasks.length > 5}
      >
        <div className="flex flex-col gap-1">
          {props.tasks.map((task, i) => (
            <TaskRow
              key={task.id}
              index={i}
              item={{ id: task.id, content: task.content, status: task.status }}
            />
          ))}
        </div>
      </ActionCard>
    )
  }

  // --- Tool use mode ---
  const { toolUse } = props
  const items = parseItems(toolUse)
  const lowerToolName = toolUse.name.toLowerCase()
  const toolLabel =
    toolUse.name === 'TodoWrite'
      ? 'Task List'
      : lowerToolName === 'update_plan'
        ? 'Plan Update'
        : toolUse.name

  return (
    <ActionCard
      accentClass="border-green-500/30"
      headerClass="border-b-green-500/20 text-green-700 dark:text-green-400"
      headerLeft={<span className="font-semibold">{toolLabel}</span>}
      headerRight={
        toolUse.status === 'running' ? 'Running...'
          : toolUse.status === 'success' ? 'Done'
          : toolUse.status
      }
      defaultExpanded
      collapsible={items.length > 5}
    >
      {items.length > 0 ? (
        <div className="flex flex-col gap-1">
          {items.map((item, i) => (
            <TaskRow key={item.id ?? i} item={item} index={i} />
          ))}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">
          {toolUse.output ? toolUse.output.slice(0, 200) : 'No tasks'}
        </div>
      )}
    </ActionCard>
  )
}
