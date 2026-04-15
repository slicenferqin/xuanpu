/**
 * FileWriteCard — Renders a file write/edit action with line change counts.
 */

import React from 'react'
import { ActionCard } from './ActionCard'
import { Check, X, Loader2 } from 'lucide-react'
import type { ToolUseInfo } from '@shared/lib/timeline-types'

interface FileWriteCardProps {
  toolUse: ToolUseInfo
}

function computeLineDiff(toolUse: ToolUseInfo): { added: number; removed: number } | null {
  const input = toolUse.input ?? {}
  const name = toolUse.name?.toLowerCase() ?? ''

  if (name === 'edit' || name === 'editfile' || name === 'edit_file') {
    const oldStr = (input.old_string as string) ?? ''
    const newStr = (input.new_string as string) ?? ''
    if (!oldStr && !newStr) return null
    const oldLines = oldStr ? oldStr.split('\n').length : 0
    const newLines = newStr ? newStr.split('\n').length : 0
    return {
      added: Math.max(0, newLines - oldLines + (oldLines === 0 ? 0 : 0)),
      removed: Math.max(0, oldLines - newLines + (newLines === 0 ? 0 : 0))
    }
  }

  if (name === 'write' || name === 'writefile' || name === 'write_file') {
    const content = (input.content as string) ?? ''
    if (!content) return null
    const lines = content.split('\n').length
    return { added: lines, removed: 0 }
  }

  return null
}

export function FileWriteCard({ toolUse }: FileWriteCardProps): React.JSX.Element {
  const filePath = (toolUse.input?.file_path as string) ?? (toolUse.input?.path as string) ?? ''
  const isEdit = toolUse.name === 'Edit' || toolUse.name === 'edit'
  const isRunning = toolUse.status === 'running' || toolUse.status === 'pending'
  const isError = toolUse.status === 'error'
  const diff = computeLineDiff(toolUse)

  return (
    <ActionCard
      headerLeft={
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-foreground shrink-0">
            {isEdit ? 'Edit' : 'Write File'}
          </span>
          <span className="font-mono text-xs text-blue-500 bg-blue-500/10 px-1.5 py-0.5 rounded truncate">
            {filePath}
          </span>
        </div>
      }
      headerRight={
        <div className="flex items-center gap-1.5">
          {isRunning && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {toolUse.status === 'success' && <Check className="h-3.5 w-3.5 text-celadon" />}
          {isError && <X className="h-3.5 w-3.5 text-red-500" />}
          {diff && toolUse.status === 'success' && (
            <div className="flex gap-1.5 font-mono text-xs font-semibold">
              {diff.added > 0 && (
                <span className="text-celadon">+{diff.added}</span>
              )}
              {diff.removed > 0 && (
                <span className="text-red-400">-{diff.removed}</span>
              )}
              {diff.added === 0 && diff.removed === 0 && (
                <span className="text-muted-foreground">~0</span>
              )}
            </div>
          )}
          {isRunning && <span>Writing...</span>}
          {isError && <span>Error</span>}
        </div>
      }
      defaultExpanded={isError}
    >
      {toolUse.error && (
        <pre className="whitespace-pre-wrap break-all font-mono text-xs text-red-400 max-h-[200px] overflow-y-auto">
          {toolUse.error}
        </pre>
      )}
    </ActionCard>
  )
}
