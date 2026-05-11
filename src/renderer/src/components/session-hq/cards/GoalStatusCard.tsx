import React from 'react'
import { Target } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentSessionGoalState } from '@shared/types/agent-protocol'

interface GoalStatusCardProps {
  goal: AgentSessionGoalState
}

function getGoalTitle(goal: AgentSessionGoalState): string {
  if (goal.objective.trim()) return goal.objective.trim()
  return 'Session goal'
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

export function GoalStatusCard({ goal }: GoalStatusCardProps): React.JSX.Element {
  const details = getGoalDetails(goal)

  return (
    <div
      className={cn(
        'rounded-lg border border-celadon/30 bg-card/80 px-3.5 py-3',
        'shadow-sm shadow-black/5'
      )}
      data-testid="goal-status-card"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-celadon/15 text-celadon">
          <Target className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-sm font-semibold text-foreground">
              {getGoalTitle(goal)}
            </div>
            <span className="shrink-0 rounded-md bg-celadon/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-normal text-celadon">
              {getGoalStatus(goal)}
            </span>
          </div>
          {details && (
            <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {details}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
