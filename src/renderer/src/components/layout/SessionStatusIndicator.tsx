/**
 * SessionStatusIndicator — Phase 6
 *
 * Compact pill in the session tab bar showing aggregate status across
 * all sessions: in-progress count, unread count, pending approval count.
 *
 * Subscribes to `useSessionRuntimeStore` for live data.
 * Clicking the indicator jumps to the first session with activity.
 */

import React, { useMemo, useCallback } from 'react'
import { Activity, MessageCircle, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSessionRuntimeStore } from '@/stores/useSessionRuntimeStore'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StatusCounts {
  inProgress: number
  unread: number
  pendingApprovals: number
  /** First sessionId with notable activity (for jump-to-session) */
  firstActiveSessionId: string | null
}

// ---------------------------------------------------------------------------
// Selector — derives aggregate status from runtime store
// ---------------------------------------------------------------------------

function useGlobalSessionStatus(): StatusCounts {
  const sessions = useSessionRuntimeStore((s) => s.sessions)
  const interruptQueues = useSessionRuntimeStore((s) => s.interruptQueues)

  return useMemo(() => {
    let inProgress = 0
    let unread = 0
    let firstActiveSessionId: string | null = null

    for (const [sessionId, state] of sessions) {
      if (state.inProgress) {
        inProgress++
        if (!firstActiveSessionId) firstActiveSessionId = sessionId
      }
      if (state.unreadCount > 0) {
        unread += state.unreadCount
        if (!firstActiveSessionId) firstActiveSessionId = sessionId
      }
    }

    let pendingApprovals = 0
    for (const [sessionId, queue] of interruptQueues) {
      const approvals = queue.filter(
        (item) => item.type === 'permission' || item.type === 'command_approval'
      )
      pendingApprovals += approvals.length
      if (approvals.length > 0 && !firstActiveSessionId) {
        firstActiveSessionId = sessionId
      }
    }

    return { inProgress, unread, pendingApprovals, firstActiveSessionId }
  }, [sessions, interruptQueues])
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusChip({
  icon: Icon,
  count,
  label,
  colorClass
}: {
  icon: React.ComponentType<{ className?: string }>
  count: number
  label: string
  colorClass: string
}): React.JSX.Element | null {
  if (count === 0) return null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[10px] font-medium',
        colorClass
      )}
      title={`${count} ${label}`}
    >
      <Icon className="h-3 w-3" />
      {count}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface SessionStatusIndicatorProps {
  /** Called when the user clicks the indicator to jump to a session */
  onJumpToSession?: (sessionId: string) => void
  className?: string
}

export function SessionStatusIndicator({
  onJumpToSession,
  className
}: SessionStatusIndicatorProps): React.JSX.Element | null {
  const { inProgress, unread, pendingApprovals, firstActiveSessionId } =
    useGlobalSessionStatus()

  const handleClick = useCallback(() => {
    if (firstActiveSessionId && onJumpToSession) {
      onJumpToSession(firstActiveSessionId)
    }
  }, [firstActiveSessionId, onJumpToSession])

  // Nothing to show
  if (inProgress === 0 && unread === 0 && pendingApprovals === 0) {
    return null
  }

  return (
    <button
      onClick={handleClick}
      disabled={!firstActiveSessionId || !onJumpToSession}
      className={cn(
        'inline-flex items-center gap-2 px-2 py-1 rounded-md shrink-0',
        'text-muted-foreground hover:bg-accent/50 transition-colors',
        'disabled:cursor-default disabled:hover:bg-transparent',
        className
      )}
      data-testid="session-status-indicator"
    >
      <StatusChip
        icon={Activity}
        count={inProgress}
        label="in progress"
        colorClass="text-green-500"
      />
      <StatusChip
        icon={MessageCircle}
        count={unread}
        label="unread"
        colorClass="text-blue-400"
      />
      <StatusChip
        icon={ShieldAlert}
        count={pendingApprovals}
        label="pending approvals"
        colorClass="text-amber-400"
      />
    </button>
  )
}