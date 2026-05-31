/**
 * TodoCard — Renders task list operations (TodoWrite, TaskCreate, TaskUpdate, etc.)
 *
 * Supports two modes:
 *   1. toolUse mode — renders from a single tool_use (normal timeline rendering)
 *   2. tasks mode — renders from an aggregated task list (right context panel)
 */

import React from 'react'
import { ActionCard } from './ActionCard'
import { CheckCircle2, Circle, Loader2, AlertCircle } from 'lucide-react'
import type { ToolUseInfo } from '@shared/lib/timeline-types'
import { useI18n } from '@/i18n/useI18n'
import {
  getSessionTaskCounts,
  getSessionTaskDisplayTitle,
  getSessionTaskRawDetail,
  normalizeSessionTaskStatus,
  sortSessionTasks,
  type SessionTask
} from '@/lib/session-tasks'

interface TodoCardPropsToolUse {
  toolUse: ToolUseInfo
  tasks?: never
}

interface TodoCardPropsTasks {
  toolUse?: never
  /** Aggregated task list — used by the right context panel and optional timeline summaries */
  tasks: SessionTask[]
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
  const { t } = useI18n()

  return (
    <div className="flex items-center gap-2 py-0.5">
      <StatusIcon status={item.status} />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-foreground leading-5 break-words">
          {item.step ??
            item.content ??
            item.subject ??
            item.activeForm ??
            item.description ??
            t('sessionHq.cards.todo.taskFallback', { index: index + 1 })}
        </div>
        {(item.subject || item.content || item.step) && item.description && (
          <div className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">
            {item.description}
          </div>
        )}
      </div>
    </div>
  )
}

function TaskSection({
  title,
  items,
  startIndex = 0,
  muted = false
}: {
  title: string
  items: SessionTask[]
  startIndex?: number
  muted?: boolean
}): React.JSX.Element | null {
  if (items.length === 0) return null

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/85">
          {title}
        </div>
        <div className="text-[10px] font-mono text-muted-foreground/75">{items.length}</div>
      </div>
      <div className="space-y-1.5">
        {items.map((item, index) => {
          const displayTitle = getSessionTaskDisplayTitle(item, startIndex + index)
          const detail = getSessionTaskRawDetail(item, displayTitle)
          return (
            <div key={item.id ?? `${title}-${index}`} className={muted ? 'opacity-75' : ''}>
              <div className="flex items-start gap-2 py-0.5">
                <StatusIcon status={item.status} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm leading-5 text-foreground break-words">{displayTitle}</div>
                  {detail && (
                    <div className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">
                      {detail}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export function TodoCard(props: TodoCardProps): React.JSX.Element {
  const { t } = useI18n()

  // --- Aggregated tasks mode ---
  if (props.tasks) {
    const orderedTasks = sortSessionTasks(props.tasks)
    const counts = getSessionTaskCounts(orderedTasks)
    const completedCount = counts.completed
    const allDone = orderedTasks.length > 0 && completedCount === orderedTasks.length
    const inProgressItems = orderedTasks.filter(
      (task) => normalizeSessionTaskStatus(task.status) === 'in_progress'
    )
    const pendingItems = orderedTasks.filter(
      (task) => normalizeSessionTaskStatus(task.status) === 'pending'
    )
    const completedItems = orderedTasks.filter(
      (task) => normalizeSessionTaskStatus(task.status) === 'completed'
    )
    const trailingItems = orderedTasks.filter((task) => {
      const status = normalizeSessionTaskStatus(task.status)
      return status === 'cancelled' || status === 'error'
    })

    return (
      <div className="overflow-hidden rounded-[12px] border border-border/55 bg-background/78">
        <div className="border-b border-border/45 px-3.5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">{t('sessionHq.cards.todo.title')}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {t('toolCard.summary.completed', {
                  completed: completedCount,
                  total: orderedTasks.length
                })}
              </div>
            </div>
            <div className="shrink-0 rounded-full bg-background/70 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {allDone ? t('sessionHq.cards.todo.done') : t('sessionHq.cards.todo.inProgress')}
            </div>
          </div>
        </div>
        <div className="max-h-[min(60vh,36rem)] overflow-y-auto px-3.5 py-3">
          <div className="space-y-4">
            <TaskSection title="进行中" items={inProgressItems} />
            <TaskSection title="待处理" items={pendingItems} startIndex={inProgressItems.length} />
            <TaskSection
              title="已完成"
              items={completedItems}
              startIndex={inProgressItems.length + pendingItems.length}
              muted
            />
            <TaskSection
              title="已取消 / 异常"
              items={trailingItems}
              startIndex={inProgressItems.length + pendingItems.length + completedItems.length}
              muted
            />
          </div>
        </div>
      </div>
    )
  }

  // --- Tool use mode ---
  const { toolUse } = props
  const items = parseItems(toolUse)
  const lowerToolName = toolUse.name.toLowerCase()
  const toolLabel =
    toolUse.name === 'TodoWrite'
      ? t('sessionHq.cards.todo.title')
      : lowerToolName === 'update_plan'
        ? t('sessionHq.cards.todo.planUpdate')
        : toolUse.name

  return (
    <ActionCard
      accentClass="border-green-500/30"
      headerClass="border-b-green-500/20 text-green-700 dark:text-green-400"
      headerLeft={<span className="font-semibold">{toolLabel}</span>}
      headerRight={
        toolUse.status === 'running'
          ? t('sessionHq.cards.todo.running')
          : toolUse.status === 'success'
            ? t('sessionHq.cards.todo.done')
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
          {toolUse.output ? toolUse.output.slice(0, 200) : t('sessionHq.cards.todo.noTasks')}
        </div>
      )}
    </ActionCard>
  )
}
