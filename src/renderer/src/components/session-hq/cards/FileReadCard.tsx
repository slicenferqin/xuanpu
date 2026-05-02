/**
 * FileReadCard — Renders a file read action.
 */

import React from 'react'
import { ActionCard } from './ActionCard'
import type { ToolUseInfo } from '@shared/lib/timeline-types'

interface FileReadCardProps {
  toolUse: ToolUseInfo
}

function resolveReadFilePath(toolUse: ToolUseInfo): string {
  const input = (toolUse.input ?? {}) as Record<string, unknown>
  const direct =
    (input.filePath || input.file_path || input.path || input.displayName || input.filename ||
      '') as string
  if (direct) return direct
  const paths = input.paths
  if (Array.isArray(paths) && typeof paths[0] === 'string') return paths[0]
  return ''
}

/**
 * Resolve the "N lines" hint for the card header.
 *
 * Priority:
 * 1. `input.limit` — explicit caller-supplied chunking (e.g. claude-code Read).
 * 2. Output text line count — OpenCode's read tool doesn't echo `limit` in its
 *    input, so we count rendered lines from the tool output once it has been
 *    captured. The output starts with a `<path>...` header line, so we subtract
 *    1 to keep the count aligned with the file's line span.
 * 3. Otherwise, undefined — header right slot stays empty during pending state.
 */
function resolveReadLineCount(toolUse: ToolUseInfo): number | undefined {
  const input = (toolUse.input ?? {}) as Record<string, unknown>
  const limit = input.limit
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    return limit
  }

  const output = toolUse.output
  if (typeof output !== 'string' || output.length === 0) return undefined

  const totalLines = output.split('\n').length
  // Strip the leading `<path>...</path>` header line OpenCode adds; underflow
  // keeps the value sensible when the tool returned a tiny snippet without it.
  const adjusted = output.startsWith('<path>') ? Math.max(totalLines - 1, 0) : totalLines
  return adjusted > 0 ? adjusted : undefined
}

export function FileReadCard({ toolUse }: FileReadCardProps): React.JSX.Element {
  const filePath = resolveReadFilePath(toolUse)
  const lineCount = resolveReadLineCount(toolUse)

  return (
    <ActionCard
      headerLeft={
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-foreground shrink-0">Read File</span>
          <span className="font-mono text-xs text-blue-500 bg-blue-500/10 px-1.5 py-0.5 rounded truncate min-w-0">
            {filePath}
          </span>
        </div>
      }
      headerRight={lineCount ? `${lineCount} lines` : undefined}
    />
  )
}
