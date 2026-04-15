/**
 * BashCard — Renders a terminal command execution action.
 */

import React from 'react'
import { ActionCard } from './ActionCard'
import { Check, X, Loader2 } from 'lucide-react'
import type { ToolUseInfo } from '@shared/lib/timeline-types'

interface BashCardProps {
  toolUse: ToolUseInfo
}

export function BashCard({ toolUse }: BashCardProps): React.JSX.Element {
  const command = (toolUse.input?.command as string) ?? ''
  const isSuccess = toolUse.status === 'success'
  const isError = toolUse.status === 'error'
  const isRunning = toolUse.status === 'running' || toolUse.status === 'pending'

  return (
    <ActionCard
      headerLeft={
        <div className="flex items-center gap-2 font-mono text-xs min-w-0">
          <span className="text-celadon font-semibold shrink-0">$_</span>
          <span className="truncate text-foreground">{command}</span>
        </div>
      }
      headerRight={
        <div className="flex items-center gap-1.5">
          {isSuccess && <Check className="h-3.5 w-3.5 text-celadon" />}
          {isError && <X className="h-3.5 w-3.5 text-red-500" />}
          {isRunning && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          <span>{isRunning ? 'Running...' : isError ? 'Error' : 'Exit 0'}</span>
        </div>
      }
      defaultExpanded={isError}
    >
      {toolUse.output && (
        <pre className="whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground max-h-[200px] overflow-y-auto">
          {toolUse.output.length > 2000
            ? toolUse.output.slice(0, 2000) + '\n... (truncated)'
            : toolUse.output}
        </pre>
      )}
      {toolUse.error && (
        <pre className="whitespace-pre-wrap break-all font-mono text-xs text-red-400 max-h-[200px] overflow-y-auto">
          {toolUse.error}
        </pre>
      )}
    </ActionCard>
  )
}
