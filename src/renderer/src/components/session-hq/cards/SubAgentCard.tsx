/**
 * SubAgentCard — Renders a delegated sub-agent action with collapsible child operations.
 */

import React, { useState, useMemo } from 'react'
import { ActionCard } from './ActionCard'
import { ChevronDown, Terminal, FileSearch, FileEdit, Search, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { StreamingPart } from '@shared/lib/timeline-types'

interface SubAgentCardProps {
  subtask: NonNullable<StreamingPart['subtask']>
  childParts?: StreamingPart[]
}

/** Compact single-line row for a child tool call */
function CompactToolRow({ part }: { part: StreamingPart }): React.JSX.Element | null {
  if (part.type === 'text' && part.text) {
    const preview = part.text.length > 120 ? part.text.slice(0, 120) + '...' : part.text
    return (
      <div className="flex items-start gap-2 py-0.5 text-[11px] text-muted-foreground/70">
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30 mt-1.5 shrink-0" />
        <span className="italic truncate">{preview}</span>
      </div>
    )
  }

  if (part.type === 'tool_use' && part.toolUse) {
    const name = part.toolUse.name?.toLowerCase() ?? ''
    const { icon: Icon, color } = getToolMeta(name)
    const label = getToolLabel(name, part.toolUse.input)
    const status = part.toolUse.status

    return (
      <div className="flex items-center gap-2 py-0.5 text-[11px]">
        <Icon className={cn('w-3 h-3 shrink-0', color)} />
        <span className="text-muted-foreground truncate flex-1">{label}</span>
        {status === 'running' && <Loader2 className="w-3 h-3 text-muted-foreground/50 animate-spin shrink-0" />}
        {status === 'success' && <CheckCircle2 className="w-3 h-3 text-celadon shrink-0" />}
        {status === 'error' && <XCircle className="w-3 h-3 text-destructive shrink-0" />}
      </div>
    )
  }

  return null
}

function getToolMeta(name: string): { icon: typeof Terminal; color: string } {
  if (name === 'bash' || name === 'execute_command') {
    return { icon: Terminal, color: 'text-muted-foreground/60' }
  }
  if (name === 'read' || name === 'readfile' || name === 'read_file') {
    return { icon: FileSearch, color: 'text-muted-foreground/60' }
  }
  if (name === 'write' || name === 'edit' || name === 'writefile' || name === 'write_file' || name === 'editfile' || name === 'edit_file') {
    return { icon: FileEdit, color: 'text-muted-foreground/60' }
  }
  if (name === 'grep' || name === 'glob' || name === 'search' || name === 'codebase_search') {
    return { icon: Search, color: 'text-muted-foreground/60' }
  }
  return { icon: Terminal, color: 'text-muted-foreground/40' }
}

function getToolLabel(name: string, input?: Record<string, unknown>): string {
  const displayName = name.charAt(0).toUpperCase() + name.slice(1)
  if (!input) return displayName

  // Show a brief parameter hint
  if (name === 'bash' || name === 'execute_command') {
    const cmd = (input.command as string) ?? ''
    return cmd ? `${cmd.slice(0, 80)}${cmd.length > 80 ? '...' : ''}` : displayName
  }
  if (name === 'read' || name === 'readfile' || name === 'read_file') {
    const path = (input.file_path as string) ?? (input.path as string) ?? ''
    return path ? `Read ${path.split('/').pop()}` : displayName
  }
  if (name === 'grep' || name === 'glob' || name === 'search' || name === 'codebase_search') {
    const pattern = (input.pattern as string) ?? (input.query as string) ?? ''
    return pattern ? `Search: ${pattern.slice(0, 60)}` : displayName
  }
  if (name === 'write' || name === 'edit' || name === 'writefile' || name === 'write_file' || name === 'editfile' || name === 'edit_file') {
    const path = (input.file_path as string) ?? (input.path as string) ?? ''
    return path ? `Edit ${path.split('/').pop()}` : displayName
  }
  return displayName
}

export function SubAgentCard({ subtask, childParts = [] }: SubAgentCardProps): React.JSX.Element {
  const isRunning = subtask.status === 'running'

  // Merge subtask.parts (from legacy/subtask-type) with childParts (from streaming routing)
  const allParts = useMemo(() => {
    const combined = [...(subtask.parts ?? []), ...childParts]
    // Filter out reasoning parts — not useful to show nested
    return combined.filter((p) => p.type !== 'reasoning')
  }, [subtask.parts, childParts])

  const toolCount = allParts.filter((p) => p.type === 'tool_use').length

  // Keep nested actions closed until the user explicitly opens them.
  const [expanded, setExpanded] = useState(false)

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
        <div className="flex items-center gap-2">
          {toolCount > 0 && (
            <span className="text-[10px] text-muted-foreground/60 tabular-nums">
              {toolCount} action{toolCount !== 1 ? 's' : ''}
            </span>
          )}
          {isRunning && (
            <div className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" />
          )}
          <span className={isRunning ? 'text-purple-500' : undefined}>
            {isRunning ? 'running' : subtask.status}
          </span>
        </div>
      }
      defaultExpanded={false}
    >
      {subtask.description && (
        <div className="text-sm text-muted-foreground">
          {subtask.description}
        </div>
      )}

      {allParts.length > 0 && (
        <div className="mt-2 border-t border-border/30 pt-2">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-[11px] text-muted-foreground/60 hover:text-muted-foreground cursor-pointer select-none flex items-center gap-1 transition-colors"
          >
            <ChevronDown className={cn('h-3 w-3 transition-transform duration-200', expanded && 'rotate-180')} />
            {expanded ? 'Hide' : 'Show'} {toolCount > 0 ? `${toolCount} action${toolCount !== 1 ? 's' : ''}` : `${allParts.length} item${allParts.length !== 1 ? 's' : ''}`}
          </button>

          {expanded && (
            <div className="mt-1.5 space-y-0.5">
              {allParts.map((p, i) => (
                <CompactToolRow key={`child-${i}`} part={p} />
              ))}
            </div>
          )}
        </div>
      )}
    </ActionCard>
  )
}
