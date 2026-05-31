import { useCallback } from 'react'
import { toast } from 'sonner'
import type { TimelineMessage } from '@shared/lib/timeline-types'
import { buildPlanImplementationPrompt } from '@/lib/proposedPlan'
import { executeSendAction } from '@/lib/session-send-actions'
import { lastSendMode } from '@/lib/message-send-times'
import {
  createOptimisticUserMessage,
  type OptimisticTimelineMessagesController
} from '@/hooks/useOptimisticTimelineMessages'
import {
  useSessionStore,
  type PendingPlan,
  type PendingPromptOptions
} from '@/stores/useSessionStore'
import {
  useSessionRuntimeStore,
  type PendingMessageModelSnapshot,
  type PendingMessagePromptOptions
} from '@/stores/useSessionRuntimeStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'

type Translate = (key: string, params?: Record<string, string | number | boolean>) => string
type ResetLiveOverlay = (nextIsStreaming: boolean) => void
type TransitionToolStatus = (
  toolUseID: string,
  status: 'success' | 'error' | 'rejected',
  error?: string
) => void

interface UseSessionPlanActionsOptions {
  sessionId: string
  worktreePath: string | null
  runtimeSessionId: string | null
  agentSdk: string | null
  pendingPlan: PendingPlan | null
  connectionId: string | null
  worktreeId: string | null
  projectId?: string | null
  goalMode: boolean
  successCriteria: string
  requestModel?: PendingMessageModelSnapshot | null
  promptOptions?: PendingMessagePromptOptions
  optimisticTimeline: OptimisticTimelineMessagesController
  resetLiveOverlay: ResetLiveOverlay
  transitionToolStatus: TransitionToolStatus
  refresh: () => Promise<TimelineMessage[]>
  t: Translate
}

interface UseSessionPlanActionsResult {
  handlePlanImplement: () => Promise<void>
  handlePlanHandoff: () => Promise<void>
  handlePlanReject: () => Promise<void>
}

export function useSessionPlanActions({
  sessionId,
  worktreePath,
  runtimeSessionId,
  agentSdk,
  pendingPlan,
  connectionId,
  worktreeId,
  projectId,
  goalMode,
  successCriteria,
  requestModel,
  promptOptions,
  optimisticTimeline,
  resetLiveOverlay,
  transitionToolStatus,
  refresh,
  t
}: UseSessionPlanActionsOptions): UseSessionPlanActionsResult {
  const handlePlanImplement = useCallback(async () => {
    if (!worktreePath || !runtimeSessionId || !pendingPlan) return

    const pendingBeforeAction = pendingPlan
    const isClaudeCode = agentSdk === 'claude-code'
    useSessionStore.getState().clearPendingPlan(sessionId)
    useSessionRuntimeStore.getState().removeInterrupt(sessionId, pendingBeforeAction.requestId)
    useWorktreeStatusStore.getState().clearSessionStatus(sessionId)

    try {
      // Always call planApprove to persist plan.resolved activity.
      // For claude-code this also unblocks the SDK; for xuanpu-agent/codex
      // it persists a plan.resolved activity so the durable timeline flips
      // from "Requires Approval" to approved on next read.
      const result = await window.agentOps.planApprove(
        worktreePath,
        sessionId,
        pendingBeforeAction.requestId
      )
      // Only claude-code needs to handle approve failure (SDK unblock)
      if (isClaudeCode && !result.success) {
        toast.error(`Plan approve failed: ${result.error ?? 'Unknown error'}`)
        if (!(result.error ?? '').toLowerCase().includes('no pending plan')) {
          useSessionStore.getState().setPendingPlan(sessionId, pendingBeforeAction)
          useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'plan_ready')
        }
        return
      }

      if (pendingBeforeAction.toolUseID) {
        transitionToolStatus(pendingBeforeAction.toolUseID, 'success')
      }

      await useSessionStore.getState().setSessionMode(sessionId, 'build')
      lastSendMode.set(sessionId, 'build')

      // Insert user message optimistically only after approval succeeds so we
      // don't show a fake implementation request when the backend is still blocked.
      const implementPrompt = isClaudeCode
        ? 'Implement this plan'
        : agentSdk === 'codex'
          ? 'Implement the plan.'
          : buildPlanImplementationPrompt(pendingBeforeAction.planContent)

      if (isClaudeCode) {
        // Claude resumes within the SAME prompt cycle after approval (no new
        // turn is started). Keep the overlay so the user sees continuous progress.
        useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
        return
      }

      resetLiveOverlay(true)

      optimisticTimeline.appendOptimisticUserMessage(
        createOptimisticUserMessage({ content: implementPrompt })
      )

      // Force build mode for implement — do not reuse stale promptOptions from
      // the closure which may still contain { mode: 'plan' } from the plan phase.
      const implementOptions: PendingMessagePromptOptions | undefined = { mode: 'build' }

      await executeSendAction('send', implementPrompt, [], {
        worktreePath,
        sessionId: runtimeSessionId,
        queueSessionId: sessionId,
        runtimeId: agentSdk ?? undefined,
        model: requestModel,
        promptOptions: implementOptions,
        prompt: (wp, sid, c) => window.agentOps.prompt(wp, sid, c, requestModel, implementOptions),
        abort: (wp, sid) => window.agentOps.abort(wp, sid),
        queueMessage: (sid, msg) => useSessionRuntimeStore.getState().queueMessage(sid, msg)
      })
    } catch (err) {
      console.error('[SessionShell] plan implement failed:', err)
      toast.error(`Plan approve error: ${err instanceof Error ? err.message : String(err)}`)
      useSessionStore.getState().setPendingPlan(sessionId, pendingBeforeAction)
      useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'plan_ready')
      resetLiveOverlay(false)
    }
  }, [
    worktreePath,
    runtimeSessionId,
    pendingPlan,
    agentSdk,
    sessionId,
    optimisticTimeline,
    resetLiveOverlay,
    transitionToolStatus,
    requestModel
  ])

  const handlePlanHandoff = useCallback(async () => {
    if (!pendingPlan) return

    const planContent = pendingPlan.planContent.trim()
    if (!planContent) {
      toast.error(t('sessionView.toasts.noAssistantPlanToHandoff'))
      return
    }

    const sourceAgentSdk = agentSdk
    const handoffPrompt = `Implement the following plan\n${planContent}`
    const pendingOptions: PendingPromptOptions | undefined =
      (sourceAgentSdk === 'codex' || sourceAgentSdk === 'claude-code') && goalMode
        ? {
            goalMode: true,
            ...(successCriteria.trim() ? { successCriteria: successCriteria.trim() } : {})
          }
        : undefined

    const sessionStore = useSessionStore.getState()

    try {
      let result:
        | Awaited<ReturnType<typeof sessionStore.createConnectionSession>>
        | Awaited<ReturnType<typeof sessionStore.createSession>>

      if (connectionId) {
        result = await sessionStore.createConnectionSession(
          connectionId,
          sourceAgentSdk ?? undefined,
          'build'
        )
      } else {
        if (!worktreeId || !projectId) {
          toast.error(t('sessionView.toasts.startHandoffSessionError'))
          return
        }

        result = await sessionStore.createSession(
          worktreeId,
          projectId,
          sourceAgentSdk ?? undefined,
          'build'
        )
      }

      if (!result.success || !result.session) {
        toast.error(result.error ?? t('sessionView.toasts.createHandoffSessionError'))
        return
      }

      await sessionStore.setSessionMode(result.session.id, 'build')
      sessionStore.setPendingMessage(result.session.id, handoffPrompt, pendingOptions)

      if (connectionId) {
        sessionStore.setActiveConnectionSession(result.session.id)
      } else {
        sessionStore.setActiveSession(result.session.id)
      }

      useSessionStore.getState().clearPendingPlan(sessionId)
      useSessionRuntimeStore.getState().removeInterrupt(sessionId, pendingPlan.requestId)
      useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
    } catch (err) {
      console.error('[SessionShell] plan handoff failed:', err)
      toast.error(
        err instanceof Error ? err.message : t('sessionView.toasts.startHandoffSessionError')
      )
    }
  }, [
    pendingPlan,
    agentSdk,
    goalMode,
    successCriteria,
    connectionId,
    worktreeId,
    projectId,
    sessionId,
    t
  ])

  const handlePlanReject = useCallback(async () => {
    if (!pendingPlan) return
    const pendingBeforeAction = pendingPlan

    // Clear local state first so the plan card disappears immediately and
    // the user can keep typing without being trapped in feedback mode.
    useSessionStore.getState().clearPendingPlan(sessionId)
    useSessionRuntimeStore.getState().removeInterrupt(sessionId, pendingBeforeAction.requestId)
    useWorktreeStatusStore.getState().clearSessionStatus(sessionId)

    // Flip the tool card status to 'rejected' immediately so the durable
    // PlanCard shows "Rejected" instead of falling through to "Approved".
    if (pendingBeforeAction.toolUseID) {
      transitionToolStatus(pendingBeforeAction.toolUseID, 'rejected')
    }

    if (!worktreePath) return

    // Always call the reject IPC — for claude-code it unblocks the SDK; for
    // codex it's a no-op on the runtime side but persists a `plan.resolved`
    // activity in SQLite, which is what flips the durable plan card from
    // "Requires Approval" to resolved on next read.
    try {
      await window.agentOps.planReject(
        worktreePath,
        sessionId,
        'Plan rejected by user',
        pendingBeforeAction.requestId
      )
      await refresh()
    } catch (err) {
      const isClaudeCode = agentSdk === 'claude-code'
      if (isClaudeCode) {
        toast.error(`Plan reject failed: ${err instanceof Error ? err.message : String(err)}`)
        useSessionStore.getState().setPendingPlan(sessionId, pendingBeforeAction)
        useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'plan_ready')
      } else {
        console.warn('[SessionShell] codex plan reject persistence failed:', err)
      }
    }
  }, [pendingPlan, agentSdk, sessionId, worktreePath, refresh, transitionToolStatus])

  return {
    handlePlanImplement,
    handlePlanHandoff,
    handlePlanReject
  }
}
