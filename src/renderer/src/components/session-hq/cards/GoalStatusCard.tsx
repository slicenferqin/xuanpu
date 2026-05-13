import React from 'react'
import { CheckCircle2, Target, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentSessionGoalState } from '@shared/types/agent-protocol'
import { Button } from '@/components/ui/button'

interface GoalStatusCardProps {
  goal: AgentSessionGoalState
  onDismiss?: () => void
}

function getGoalTitle(goal: AgentSessionGoalState): string {
  if (goal.objective.trim()) return goal.objective.trim()
  return 'Session goal'
}

function getSuccessCriteria(goal: AgentSessionGoalState): string | null {
  const criteria = goal.successCriteria?.trim()
  return criteria ? criteria : null
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const compact = (scaled: number, suffix: string) =>
    `${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}${suffix}`
  if (Math.abs(value) >= 1_000_000) return compact(value / 1_000_000, 'M')
  if (Math.abs(value) >= 1_000) return compact(value / 1_000, 'K')
  return String(Math.round(value))
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s'
  const wholeSeconds = Math.round(seconds)
  const minutes = Math.floor(wholeSeconds / 60)
  const remainingSeconds = wholeSeconds % 60
  if (minutes <= 0) return `${remainingSeconds}s`
  if (remainingSeconds === 0) return `${minutes}m`
  return `${minutes}m ${remainingSeconds}s`
}

function getGoalDetails(goal: AgentSessionGoalState): string | null {
  const details: string[] = []
  if (typeof goal.tokensUsed === 'number') {
    const used = formatCompactNumber(goal.tokensUsed)
    if (typeof goal.tokenBudget === 'number') {
      details.push(`${used} / ${formatCompactNumber(goal.tokenBudget)} tokens`)
    } else {
      details.push(`${used} tokens`)
    }
  }
  if (typeof goal.timeUsedSeconds === 'number') {
    details.push(formatDuration(goal.timeUsedSeconds))
  }
  return details.length > 0 ? details.join(' · ') : null
}

function getGoalStatus(goal: AgentSessionGoalState): string {
  const status = goal.status
  if (status.trim()) return status.trim()
  return 'Active'
}

function isCompletedGoal(goal: AgentSessionGoalState): boolean {
  return goal.status.trim().toLowerCase() === 'completed'
}

export function GoalStatusCard({ goal, onDismiss }: GoalStatusCardProps): React.JSX.Element {
  const details = getGoalDetails(goal)
  const successCriteria = getSuccessCriteria(goal)
  const completed = isCompletedGoal(goal)
  const Icon = completed ? CheckCircle2 : Target

  return (
    <div
      className={cn(
        'rounded-lg border bg-card/95 px-3.5 py-3',
        completed ? 'border-emerald-500/35' : 'border-celadon/30',
        'shadow-sm shadow-black/5 backdrop-blur'
      )}
      data-testid="goal-status-card"
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
            completed ? 'bg-emerald-500/15 text-emerald-500' : 'bg-celadon/15 text-celadon'
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
              {getGoalTitle(goal)}
            </div>
            <span
              className={cn(
                'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-normal',
                completed ? 'bg-emerald-500/10 text-emerald-500' : 'bg-celadon/10 text-celadon'
              )}
            >
              {getGoalStatus(goal)}
            </span>
            {completed && onDismiss && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-5 w-5 shrink-0 rounded-full p-0 text-muted-foreground hover:text-foreground"
                aria-label="Dismiss completed goal"
                data-testid="goal-dismiss-button"
                onClick={onDismiss}
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
          {details && (
            <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {details}
            </div>
          )}
          {successCriteria && (
            <div className="mt-2 border-t border-border/50 pt-2">
              <div className="text-[10px] font-medium uppercase tracking-normal text-muted-foreground">
                Criteria
              </div>
              <div
                className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground"
                data-testid="goal-success-criteria"
              >
                {successCriteria}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
