/**
 * PlanCard — Renders an execution plan that requires user approval.
 * Uses MarkdownRenderer for rich content, collapses after approval/rejection.
 */

import React from 'react'
import { ActionCard } from './ActionCard'
import { MarkdownRenderer } from '../../sessions/MarkdownRenderer'

interface PlanCardProps {
  content: string
  onApprove?: () => void
  onReject?: () => void
  /** Whether the plan is pending approval */
  isPending?: boolean
}

export function PlanCard({
  content,
  onApprove,
  onReject,
  isPending = false
}: PlanCardProps): React.JSX.Element {
  return (
    <ActionCard
      accentClass="border-purple-500 shadow-purple-500/10"
      headerClass="bg-purple-500/10 text-purple-600 dark:text-purple-400 border-b-purple-500/20"
      headerLeft={
        <span className="font-semibold">Proposed Execution Plan</span>
      }
      headerRight={isPending ? 'Requires Approval' : 'Approved'}
      defaultExpanded={isPending}
      collapsible
    >
      <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed">
        <MarkdownRenderer content={content} />
      </div>

      {isPending && (onApprove || onReject) && (
        <div className="flex justify-end gap-2 pt-3 mt-3 border-t border-border">
          {onReject && (
            <button
              onClick={onReject}
              className="px-4 py-1.5 rounded-md border border-border text-sm font-medium hover:bg-muted transition-colors"
            >
              Reject / Modify
            </button>
          )}
          {onApprove && (
            <button
              onClick={onApprove}
              className="px-4 py-1.5 rounded-md bg-blue-500 text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Approve & Start
            </button>
          )}
        </div>
      )}
    </ActionCard>
  )
}
