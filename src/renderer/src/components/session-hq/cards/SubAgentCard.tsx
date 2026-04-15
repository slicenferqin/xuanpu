/**
 * SubAgentCard — Renders a delegated sub-agent action.
 */

import React from 'react'
import { ActionCard } from './ActionCard'
import type { StreamingPart } from '@shared/lib/timeline-types'

interface SubAgentCardProps {
  subtask: NonNullable<StreamingPart['subtask']>
}

export function SubAgentCard({ subtask }: SubAgentCardProps): React.JSX.Element {
  const isRunning = subtask.status === 'running'

  return (
    <ActionCard
      className="bg-muted/50 border-dashed"
      headerLeft={
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded bg-foreground text-background flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
            </svg>
          </div>
          <span className="font-semibold text-foreground">
            Delegated to {subtask.agent || 'Agent'}
          </span>
        </div>
      }
      headerRight={
        <div className="flex items-center gap-1.5">
          {isRunning && (
            <div className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" />
          )}
          <span className={isRunning ? 'text-purple-500' : undefined}>
            {isRunning ? 'Running...' : subtask.status}
          </span>
        </div>
      }
      defaultExpanded={isRunning}
    >
      {subtask.description && (
        <div className="text-sm text-muted-foreground">
          {subtask.description}
        </div>
      )}
    </ActionCard>
  )
}
