import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  ChevronsUp,
  Circle,
  CircleCheck,
  CircleDot,
  CircleX,
  ListTodo
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'
import { getTodoCounts, type TodoItem, type TodoToolStatus } from '@/lib/todo-utils'
import { sortSessionTaskLikeItems } from '@/lib/session-tasks'

interface SessionTaskTrackerProps {
  todos: TodoItem[]
  toolStatus: TodoToolStatus
  compact?: boolean
}

const COMPLETION_VISIBILITY_MS = 1200

function isResolvedTodo(todo: TodoItem): boolean {
  return todo.status === 'completed' || todo.status === 'cancelled'
}

function StatusIcon({ status }: { status: TodoItem['status'] }) {
  switch (status) {
    case 'completed':
      return <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
    case 'in_progress':
      return <CircleDot className="h-3.5 w-3.5 shrink-0 text-sky-500" />
    case 'cancelled':
      return <CircleX className="h-3.5 w-3.5 shrink-0 text-muted-foreground/45" />
    default:
      return <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/45" />
  }
}

function PriorityIcon({ priority }: { priority: TodoItem['priority'] }) {
  switch (priority) {
    case 'high':
      return <ChevronsUp className="h-3.5 w-3.5 shrink-0 text-rose-500/85" />
    case 'medium':
      return <ChevronUp className="h-3.5 w-3.5 shrink-0 text-amber-500/85" />
    case 'low':
      return <ChevronDown className="h-3.5 w-3.5 shrink-0 text-sky-500/85" />
    default:
      return null
  }
}

export function SessionTaskTracker({
  todos,
  toolStatus,
  compact = false
}: SessionTaskTrackerProps): React.JSX.Element | null {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const [recentlyCompletedIds, setRecentlyCompletedIds] = useState<string[]>([])
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const previousStatusesRef = useRef<Map<string, TodoItem['status']>>(new Map())
  const previousRectsRef = useRef<Map<string, DOMRect>>(new Map())
  const completionTimersRef = useRef<Map<string, number>>(new Map())
  const completionAnimationQueueRef = useRef<Set<string>>(new Set())
  const hasMeasuredLayoutRef = useRef(false)
  const { completed, inProgress, pending, cancelled } = getTodoCounts(todos)

  const progressPercent = Math.round((completed / todos.length) * 100)

  const orderedTodos = useMemo(() => sortSessionTaskLikeItems(todos), [todos])

  useEffect(() => {
    setExpanded(false)
  }, [compact])

  useEffect(() => {
    const previousStatuses = previousStatusesRef.current
    const activeIds = new Set(todos.map((todo) => todo.id))

    setRecentlyCompletedIds((currentIds) => currentIds.filter((id) => activeIds.has(id)))

    for (const [id, timer] of completionTimersRef.current.entries()) {
      if (!activeIds.has(id)) {
        window.clearTimeout(timer)
        completionTimersRef.current.delete(id)
        completionAnimationQueueRef.current.delete(id)
      }
    }

    for (const todo of todos) {
      const previousStatus = previousStatuses.get(todo.id)
      const didJustResolve =
        previousStatus !== undefined &&
        previousStatus !== todo.status &&
        !isResolvedTodo({ ...todo, status: previousStatus }) &&
        isResolvedTodo(todo)

      if (!didJustResolve) continue

      completionAnimationQueueRef.current.add(todo.id)
      setRecentlyCompletedIds((currentIds) =>
        currentIds.includes(todo.id) ? currentIds : [...currentIds, todo.id]
      )

      const existingTimer = completionTimersRef.current.get(todo.id)
      if (existingTimer) {
        window.clearTimeout(existingTimer)
      }

      const timer = window.setTimeout(() => {
        setRecentlyCompletedIds((currentIds) => currentIds.filter((id) => id !== todo.id))
        completionTimersRef.current.delete(todo.id)
        completionAnimationQueueRef.current.delete(todo.id)
      }, COMPLETION_VISIBILITY_MS)

      completionTimersRef.current.set(todo.id, timer)
    }

    previousStatusesRef.current = new Map(todos.map((todo) => [todo.id, todo.status]))
  }, [todos])

  useEffect(() => {
    const timers = completionTimersRef.current
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer)
      }
      timers.clear()
    }
  }, [])

  const unresolvedTodos = useMemo(
    () => orderedTodos.filter((todo) => !isResolvedTodo(todo)),
    [orderedTodos]
  )

  const transientResolvedTodos = useMemo(() => {
    if (expanded) return []
    return orderedTodos.filter(
      (todo) => isResolvedTodo(todo) && recentlyCompletedIds.includes(todo.id)
    )
  }, [expanded, orderedTodos, recentlyCompletedIds])

  const visibleTodos = useMemo(() => {
    if (expanded) return orderedTodos

    const compactTodos = unresolvedTodos.slice(0, 3)
    const compactIds = new Set(compactTodos.map((todo) => todo.id))
    const trailingResolvedTodos = transientResolvedTodos
      .filter((todo) => !compactIds.has(todo.id))
      .slice(0, 1)

    return [...compactTodos, ...trailingResolvedTodos]
  }, [expanded, orderedTodos, transientResolvedTodos, unresolvedTodos])

  useLayoutEffect(() => {
    const nextRects = new Map<string, DOMRect>()

    for (const todo of visibleTodos) {
      const element = itemRefs.current.get(todo.id)
      if (!element) continue

      const nextRect = element.getBoundingClientRect()
      nextRects.set(todo.id, nextRect)

      if (hasMeasuredLayoutRef.current) {
        const previousRect = previousRectsRef.current.get(todo.id)

        if (previousRect && typeof element.animate === 'function') {
          const deltaY = previousRect.top - nextRect.top
          if (Math.abs(deltaY) > 1) {
            element.animate(
              [{ transform: `translateY(${deltaY}px)` }, { transform: 'translateY(0)' }],
              {
                duration: 260,
                easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
              }
            )
          }
        } else if (typeof element.animate === 'function') {
          element.animate(
            [
              { opacity: 0, transform: 'translateY(8px) scale(0.985)' },
              { opacity: 1, transform: 'translateY(0) scale(1)' }
            ],
            {
              duration: 220,
              easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
            }
          )
        }
      }

      if (completionAnimationQueueRef.current.has(todo.id) && typeof element.animate === 'function') {
        completionAnimationQueueRef.current.delete(todo.id)
        element.animate(
          [
            { transform: 'scale(1)', boxShadow: '0 0 0 rgba(16, 185, 129, 0)' },
            { transform: 'scale(1.012)', boxShadow: '0 10px 24px rgba(16, 185, 129, 0.14)' },
            { transform: 'scale(1)', boxShadow: '0 0 0 rgba(16, 185, 129, 0)' }
          ],
          {
            duration: 420,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
          }
        )
      }
    }

    previousRectsRef.current = nextRects
    hasMeasuredLayoutRef.current = true
  }, [visibleTodos])

  const hiddenCount = orderedTodos.filter(
    (todo) => !visibleTodos.some((visibleTodo) => visibleTodo.id === todo.id)
  ).length

  if (todos.length === 0) return null

  const headerToneClass =
    toolStatus === 'error'
      ? 'border-destructive/25 bg-destructive/5'
      : toolStatus === 'running' || toolStatus === 'pending'
        ? 'border-primary/18 bg-primary/4'
        : 'border-border/70 bg-card/92'

  const statusSummary =
    inProgress > 0
      ? t('toolCard.summary.active', { count: inProgress })
      : pending > 0
        ? t('sessionTaskTracker.pending', { count: pending })
        : cancelled > 0
          ? t('sessionTaskTracker.cancelled', { count: cancelled })
          : t('sessionTaskTracker.allDone')

  const trackerBody = (
    <>
      <div className="px-4 pb-2">
        <div className="h-1.5 overflow-hidden rounded-full bg-muted/75">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary/70 via-primary to-sky-500/70 transition-[width] duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      <div className={cn('px-3 pb-3', expanded ? 'max-h-60 overflow-y-auto' : '')}>
        <div className="space-y-1">
          {visibleTodos.map((todo, index) => (
            <div
              key={todo.id}
              ref={(node) => {
                if (node) itemRefs.current.set(todo.id, node)
                else itemRefs.current.delete(todo.id)
              }}
              className={cn(
                'flex items-center gap-2 rounded-xl px-2.5 py-2 text-sm will-change-transform transition-[background-color,box-shadow,opacity,transform] duration-300 ease-out',
                todo.status === 'in_progress'
                  ? 'bg-sky-500/10 ring-1 ring-sky-500/14'
                  : todo.status === 'completed'
                    ? 'bg-emerald-500/6'
                    : 'bg-background/55',
                recentlyCompletedIds.includes(todo.id) &&
                  todo.status === 'completed' &&
                  'ring-1 ring-emerald-500/18 shadow-[0_4px_14px_rgba(16,185,129,0.06)]',
                recentlyCompletedIds.includes(todo.id) &&
                  todo.status === 'cancelled' &&
                  'ring-1 ring-muted-foreground/12 shadow-[0_4px_14px_rgba(15,23,42,0.03)]',
                !expanded && index === 0 && todo.status === 'in_progress' && 'shadow-sm'
              )}
            >
              <StatusIcon status={todo.status} />
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-foreground/92 transition-colors duration-300',
                  (todo.status === 'completed' || todo.status === 'cancelled') &&
                    'text-muted-foreground/65 line-through'
                )}
                title={todo.content}
              >
                {todo.content}
              </span>
              <PriorityIcon priority={todo.priority} />
            </div>
          ))}
          {!expanded && hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="flex w-full items-center justify-center rounded-xl border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
            >
              {t('sessionTaskTracker.more', { count: hiddenCount })}
            </button>
          )}
        </div>
      </div>
    </>
  )

  if (compact) {
    return (
      <div className="relative" data-testid="session-task-tracker-compact">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className={cn(
            'flex w-full min-w-[220px] items-center gap-3 rounded-2xl border px-3 py-2.5 text-left shadow-[0_5px_16px_rgba(15,23,42,0.04)] backdrop-blur-sm transition-[border-color,box-shadow,background-color] duration-200 hover:border-border hover:bg-card',
            headerToneClass
          )}
          aria-expanded={expanded}
          aria-label={expanded ? t('sessionTaskTracker.collapse') : t('sessionTaskTracker.expand')}
          title={expanded ? t('sessionTaskTracker.collapse') : t('sessionTaskTracker.expand')}
        >
          <span className="inline-flex size-8 items-center justify-center rounded-xl bg-primary/8 text-primary">
            <ListTodo className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold text-foreground">
              {t('toolCard.summary.completed', { completed, total: todos.length })}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">{statusSummary}</div>
          </div>
          {inProgress > 0 && (
            <span className="rounded-full bg-sky-500/12 px-2 py-1 text-[11px] font-medium text-sky-600 dark:text-sky-300">
              {t('toolCard.summary.active', { count: inProgress })}
            </span>
          )}
          {expanded ? (
            <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
        </button>

        {expanded && (
          <div className="absolute right-0 top-full z-20 mt-2 w-[340px] max-w-[calc(100vw-2rem)]">
            <div
              className={cn(
                'rounded-2xl border shadow-[0_10px_26px_rgba(15,23,42,0.07)] backdrop-blur-sm',
                headerToneClass
              )}
            >
              <div className="flex items-center gap-2 px-4 pb-3 pt-3">
                <span className="inline-flex size-7 items-center justify-center rounded-xl bg-primary/8 text-primary">
                  <ListTodo className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground">
                    {t('sessionTaskTracker.title', { total: todos.length, completed })}
                  </div>
                  <div className="text-xs text-muted-foreground">{statusSummary}</div>
                </div>
              </div>
              {trackerBody}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'rounded-2xl border shadow-[0_6px_18px_rgba(15,23,42,0.04)] backdrop-blur-sm',
        headerToneClass
      )}
      data-testid="session-task-tracker"
    >
      <div className="flex items-center gap-2 px-4 pb-3 pt-3">
        <span className="inline-flex size-7 items-center justify-center rounded-xl bg-primary/8 text-primary">
          <ListTodo className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">
            {t('sessionTaskTracker.title', { total: todos.length, completed })}
          </div>
          {expanded && <div className="text-xs text-muted-foreground">{statusSummary}</div>}
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs">
          {expanded && (
            <span className="rounded-full bg-background/80 px-2 py-1 font-medium text-muted-foreground">
              {t('toolCard.summary.completed', { completed, total: todos.length })}
            </span>
          )}
          {expanded && inProgress > 0 && (
            <span className="rounded-full bg-sky-500/12 px-2 py-1 text-[11px] font-medium text-sky-600 dark:text-sky-300">
              {t('toolCard.summary.active', { count: inProgress })}
            </span>
          )}
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-background/70 hover:text-foreground"
            aria-label={
              expanded ? t('sessionTaskTracker.collapse') : t('sessionTaskTracker.expand')
            }
            title={expanded ? t('sessionTaskTracker.collapse') : t('sessionTaskTracker.expand')}
          >
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
      </div>
      {expanded && trackerBody}
    </div>
  )
}
