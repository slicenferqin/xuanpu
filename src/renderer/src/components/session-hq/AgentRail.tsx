/**
 * AgentRail — Phase 4
 *
 * Side panel showing agent activity: running tools, interrupt queue,
 * unread count. Collapses when there's no interesting state.
 */

import React from 'react'
import { cn } from '@/lib/utils'
import type { SessionRuntimeState, InterruptItem } from '@/stores/useSessionRuntimeStore'
import { Wrench, AlertCircle, MessageCircle, CheckCircle } from 'lucide-react'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AgentRailProps {
  sessionId: string
  lifecycle: SessionRuntimeState['lifecycle']
  interruptQueue: InterruptItem[]
  unreadCount: number
  commandsAvailable: boolean
  /** Collapsed when there's nothing to show */
  collapsed?: boolean
}

// ---------------------------------------------------------------------------
// Queue item renderer
// ---------------------------------------------------------------------------

function InterruptQueueItem({ item }: { item: InterruptItem }): React.JSX.Element {
  const iconMap = {
    question: <MessageCircle className="h-3.5 w-3.5 text-blue-400" />,
    permission: <AlertCircle className="h-3.5 w-3.5 text-yellow-400" />,
    command_approval: <AlertCircle className="h-3.5 w-3.5 text-orange-400" />,
    plan: <CheckCircle className="h-3.5 w-3.5 text-celadon" />
  }

  const labelMap = {
    question: 'Question pending',
    permission: 'Permission needed',
    command_approval: 'Command approval',
    plan: 'Plan approval'
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs rounded-md bg-muted/50">
      {iconMap[item.type]}
      <span className="truncate">{labelMap[item.type]}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main rail
// ---------------------------------------------------------------------------

export function AgentRail({
  sessionId,
  lifecycle,
  interruptQueue,
  unreadCount,
  commandsAvailable,
  collapsed = false
}: AgentRailProps): React.JSX.Element | null {
  // Don't render the rail when there's nothing to show
  const hasContent =
    interruptQueue.length > 0 ||
    unreadCount > 0 ||
    lifecycle === 'busy' ||
    lifecycle === 'retry'

  if (collapsed || !hasContent) return null

  return (
    <div
      className={cn(
        'w-[240px] border-l border-border flex flex-col shrink-0',
        'bg-background/50 overflow-y-auto'
      )}
    >
      {/* Status section */}
      {(lifecycle === 'busy' || lifecycle === 'retry') && (
        <div className="px-3 py-3 border-b border-border">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Wrench className="h-3.5 w-3.5 animate-spin" />
            <span>{lifecycle === 'busy' ? 'Working...' : 'Retrying...'}</span>
          </div>
        </div>
      )}

      {/* Interrupt queue */}
      {interruptQueue.length > 0 && (
        <div className="px-3 py-3 space-y-2">
          <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
            Pending ({interruptQueue.length})
          </div>
          {interruptQueue.map((item) => (
            <InterruptQueueItem key={item.id} item={item} />
          ))}
        </div>
      )}

      {/* Unread count */}
      {unreadCount > 0 && (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          {unreadCount} unread {unreadCount === 1 ? 'message' : 'messages'}
        </div>
      )}
    </div>
  )
}
