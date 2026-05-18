import React from 'react'
import { CheckCircle2, Target, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentSessionGoalState } from '@shared/types/agent-protocol'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/useI18n'

interface GoalStatusCardProps {
  goal: AgentSessionGoalState
  onDismiss?: () => void
}

type TFunction = ReturnType<typeof useI18n>['t']

function getGoalTitle(goal: AgentSessionGoalState, t: TFunction): string {
  if (goal.objective.trim()) return goal.objective.trim()
  return t('sessionHq.cards.goal.defaultTitle')
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

function getGoalDetails(goal: AgentSessionGoalState, t: TFunction): string | null {
  const details: string[] = []
  if (typeof goal.tokensUsed === 'number') {
    const used = formatCompactNumber(goal.tokensUsed)
    if (typeof goal.tokenBudget === 'number') {
      details.push(
        `${used} / ${formatCompactNumber(goal.tokenBudget)} ${t('sessionHq.cards.goal.tokens')}`
      )
    } else {
      details.push(`${used} ${t('sessionHq.cards.goal.tokens')}`)
    }
  }
  if (typeof goal.timeUsedSeconds === 'number') {
    details.push(formatDuration(goal.timeUsedSeconds))
  }
  return details.length > 0 ? details.join(' · ') : null
}

function getGoalStatus(goal: AgentSessionGoalState, t: TFunction): string {
  const status = goal.status
  const normalized = status.trim().toLowerCase()
  if (normalized === 'active') return t('sessionHq.cards.goal.active')
  if (normalized === 'completed') return t('sessionHq.cards.goal.completed')
  if (status.trim()) return status.trim()
  return t('sessionHq.cards.goal.active')
}

function isCompletedGoal(goal: AgentSessionGoalState): boolean {
  return goal.status.trim().toLowerCase() === 'completed'
}

export function GoalStatusCard({ goal, onDismiss }: GoalStatusCardProps): React.JSX.Element {
  const { t } = useI18n()
  const details = getGoalDetails(goal, t)
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
              {getGoalTitle(goal, t)}
            </div>
            <span
              className={cn(
                'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-normal',
                completed ? 'bg-emerald-500/10 text-emerald-500' : 'bg-celadon/10 text-celadon'
              )}
            >
              {getGoalStatus(goal, t)}
            </span>
            {completed && onDismiss && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-5 w-5 shrink-0 rounded-full p-0 text-muted-foreground hover:text-foreground"
                aria-label={t('sessionHq.cards.goal.dismissCompleted')}
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
                {t('sessionHq.cards.goal.criteria')}
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
