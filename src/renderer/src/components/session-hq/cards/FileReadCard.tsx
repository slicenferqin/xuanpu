/**
 * FileReadCard — Renders a file read action.
 */

import React from 'react'
import { ActionCard } from './ActionCard'
import type { ToolUseInfo } from '@shared/lib/timeline-types'

interface FileReadCardProps {
  toolUse: ToolUseInfo
}

export function FileReadCard({ toolUse }: FileReadCardProps): React.JSX.Element {
  const filePath = (toolUse.input?.file_path as string) ?? (toolUse.input?.path as string) ?? ''
  const limit = toolUse.input?.limit as number | undefined

  return (
    <ActionCard
      headerLeft={
        <div className="flex items-center gap-2">
          <span className="font-semibold text-foreground">Read File</span>
          <span className="font-mono text-xs text-blue-500 bg-blue-500/10 px-1.5 py-0.5 rounded">
            {filePath}
          </span>
        </div>
      }
      headerRight={limit ? `${limit} lines` : undefined}
    />
  )
}
