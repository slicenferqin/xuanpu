/**
 * SearchCard — Renders a grep/glob/search action.
 */

import React from 'react'
import { ActionCard } from './ActionCard'
import type { ToolUseInfo } from '@shared/lib/timeline-types'

interface SearchCardProps {
  toolUse: ToolUseInfo
}

export function SearchCard({ toolUse }: SearchCardProps): React.JSX.Element {
  const pattern = (toolUse.input?.pattern as string) ?? (toolUse.input?.query as string) ?? ''
  const path = (toolUse.input?.path as string) ?? ''
  const resultCount = toolUse.output
    ? toolUse.output.split('\n').filter((l) => l.trim()).length
    : undefined

  return (
    <ActionCard
      headerLeft={
        <div className="flex items-center gap-2">
          <span className="font-semibold text-foreground">Codebase Search</span>
          <span className="font-mono text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full border border-border">
            {toolUse.name}
          </span>
        </div>
      }
      headerRight={resultCount ? `${resultCount} results` : undefined}
    >
      <div className="font-mono text-xs">
        <span className="text-blue-500">Query:</span>{' '}
        <span className="text-foreground">{pattern}</span>
        {path && (
          <>
            {' '}
            <span className="text-muted-foreground">in</span>{' '}
            <span className="text-foreground">{path}</span>
          </>
        )}
      </div>
    </ActionCard>
  )
}
