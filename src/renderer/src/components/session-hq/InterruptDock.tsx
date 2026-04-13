/**
 * InterruptDock — Phase 4
 *
 * Unified HITL container that renders the first pending interrupt from the
 * session's interrupt queue. Supports: question, permission, command_approval, plan.
 *
 * The interrupt queue is managed by useSessionRuntimeStore and populated by
 * the EventBridge. This component is a pure display layer.
 */

import React from 'react'
import { QuestionPrompt } from '../sessions/QuestionPrompt'
import { PermissionPrompt } from '../sessions/PermissionPrompt'
import { CommandApprovalPrompt } from '../sessions/CommandApprovalPrompt'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { usePermissionStore } from '@/stores/usePermissionStore'
import { useCommandApprovalStore } from '@/stores/useCommandApprovalStore'
import type { InterruptItem } from '@/stores/useSessionRuntimeStore'

export interface InterruptDockProps {
  sessionId: string
  interrupt: InterruptItem | null
  worktreePath: string | null
}

export function InterruptDock({
  sessionId,
  interrupt,
  worktreePath
}: InterruptDockProps): React.JSX.Element | null {
  if (!interrupt) return null

  // Render the appropriate prompt component based on interrupt type.
  // The legacy stores are still the action dispatchers (Phase 1 backward compat).
  switch (interrupt.type) {
    case 'question': {
      const request = useQuestionStore.getState().getActiveQuestion(sessionId)
      if (!request) return null
      return (
        <div className="border-t border-border bg-background px-4 py-3">
          <QuestionPrompt
            request={request}
            onReply={(requestId, answers) => {
              window.agentOps.questionReply(requestId, answers, worktreePath ?? undefined)
              useQuestionStore.getState().removeQuestion(sessionId, requestId)
            }}
            onReject={(requestId) => {
              window.agentOps.questionReject(requestId, worktreePath ?? undefined)
              useQuestionStore.getState().removeQuestion(sessionId, requestId)
            }}
          />
        </div>
      )
    }

    case 'permission': {
      const request = usePermissionStore.getState().getActivePermission(sessionId)
      if (!request) return null
      return (
        <div className="border-t border-border bg-background px-4 py-3">
          <PermissionPrompt
            request={request}
            onReply={(requestId, reply, message) => {
              window.agentOps.permissionReply(requestId, reply, worktreePath ?? undefined, message)
              usePermissionStore.getState().removePermission(sessionId, requestId)
            }}
          />
        </div>
      )
    }

    case 'command_approval': {
      const request = useCommandApprovalStore.getState().getActiveApproval(sessionId)
      if (!request) return null
      return (
        <div className="border-t border-border bg-background px-4 py-3">
          <CommandApprovalPrompt
            request={request}
            onReply={(requestId, approved, remember, pattern, patterns) => {
              window.agentOps.commandApprovalReply(
                requestId,
                approved,
                remember,
                pattern,
                worktreePath ?? undefined,
                patterns
              )
              useCommandApprovalStore.getState().removeApproval(sessionId, requestId)
            }}
          />
        </div>
      )
    }

    case 'plan':
      // Plan interrupts are rendered inline in the message thread (via ToolCard)
      // not in the dock. This placeholder acknowledges the type but doesn't render.
      return null

    default:
      return null
  }
}
