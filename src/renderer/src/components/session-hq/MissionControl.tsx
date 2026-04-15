/**
 * MissionControl — Sticky floating task progress panel.
 *
 * Positioned outside the scroll container, between SessionHeader and
 * AgentTimeline. Shows the user's triggering question + task progress bar.
 * Appears when TodoWrite fires (even during streaming), fades out 2s after
 * all tasks complete.
 *
 * Design reference: ~/demo4.html `.mission-panel`
 */

import React, { useState, useMemo } from 'react'
import { cn } from '@/lib/utils'
import {
  ChevronDown,
  CircleCheck,
  CircleDot,
  Circle,
  AlertCircle,
  Loader2,
  User
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MissionTask {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'error'
}

export interface MissionControlProps {
  tasks: MissionTask[]
  triggerQuestion: string | null
  visible: boolean
  allComplete: boolean
  isStreaming: boolean
}

// ---------------------------------------------------------------------------
// Task status icon
// ---------------------------------------------------------------------------

function TaskStatusIcon({ status }: { status: MissionTask['status'] }): React.JSX.Element {
  switch (status) {
    case 'completed':
      return <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
    case 'in_progress':
      return <CircleDot className="h-3.5 w-3.5 shrink-0 text-blue-500 animate-pulse" />
    case 'error':
      return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
    default:
      return <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MissionControl({
  tasks,
  triggerQuestion,
  visible,
  allComplete,
  isStreaming
}: MissionControlProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const [leaving, setLeaving] = useState(false)

  // Handle exit animation
  React.useEffect(() => {
    if (!visible && tasks.length > 0 && !leaving) {
      setLeaving(true)
    }
    if (visible && leaving) {
      setLeaving(false)
    }
  }, [visible, tasks.length, leaving])

  // Derived stats
  const completedCount = useMemo(
    () => tasks.filter((t) => t.status === 'completed').length,
    [tasks]
  )
  const totalCount = tasks.length
  const progressPercent = totalCount > 0
    ? Math.round((completedCount / totalCount) * 100)
    : 0
  const activeTask = useMemo(
    () => tasks.find((t) => t.status === 'in_progress'),
    [tasks]
  )

  // Don't render when not visible and not animating out
  if (!visible && !leaving) return null
  if (tasks.length === 0 && !leaving) return null

  return (
    <div
      className={cn(
        'border-b border-border/50 bg-card/80 backdrop-blur-[16px]',
        'px-6 py-3.5 z-[15] shrink-0',
        'shadow-[0_4px_20px_-10px_rgba(0,0,0,0.05)]',
        'flex flex-col gap-2.5',
        leaving
          ? 'animate-out fade-out slide-out-to-top-2 duration-200 fill-mode-forwards'
          : 'animate-in fade-in slide-in-from-top-2 duration-300'
      )}
      onAnimationEnd={() => {
        if (leaving) setLeaving(false)
      }}
    >
      {/* Trigger question */}
      {triggerQuestion && (
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-md bg-foreground/10 shrink-0">
            <User className="h-3 w-3 text-foreground/70" />
          </div>
          <span className="text-sm text-foreground/80 leading-relaxed line-clamp-2">
            {triggerQuestion}
          </span>
        </div>
      )}

      {/* Progress status bar */}
      <div
        className={cn(
          'flex items-center gap-3 rounded-[10px] border border-border/60',
          'bg-muted/30 px-3.5 py-2.5 cursor-pointer select-none',
          'hover:border-border transition-colors'
        )}
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Status icon */}
        {allComplete ? (
          <CircleCheck className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
        ) : isStreaming ? (
          <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />
        ) : (
          <CircleDot className="h-3.5 w-3.5 text-blue-500 animate-pulse shrink-0" />
        )}

        {/* Current task / summary */}
        <span className="text-sm font-medium text-foreground truncate flex-1">
          {allComplete
            ? 'All tasks completed'
            : activeTask
              ? activeTask.content
              : `${completedCount}/${totalCount} tasks`}
        </span>

        {/* Progress track */}
        <div className="w-20 h-1.5 bg-border/60 rounded-full overflow-hidden shrink-0">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500',
              allComplete ? 'bg-emerald-500' : 'bg-blue-500'
            )}
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        {/* Count */}
        <span className="text-xs text-muted-foreground font-mono shrink-0">
          {completedCount}/{totalCount}
        </span>

        {/* Expand chevron */}
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 shrink-0',
            !expanded && '-rotate-90'
          )}
        />
      </div>

      {/* Expanded task list */}
      {expanded && (
        <div className="flex flex-col gap-1 pl-5">
          {tasks.map((task) => (
            <div key={task.id} className="flex items-center gap-2.5 py-0.5">
              <TaskStatusIcon status={task.status} />
              <span
                className={cn(
                  'text-xs font-mono',
                  task.status === 'completed'
                    ? 'text-muted-foreground line-through'
                    : task.status === 'in_progress'
                      ? 'text-foreground font-medium'
                      : task.status === 'error'
                        ? 'text-red-500'
                        : 'text-muted-foreground'
                )}
              >
                {task.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
