/**
 * useAgentEventBridge — Phase 1
 *
 * Root-level hook mounted **once** in AppLayout.  It is the sole subscriber to
 * `window.agentOps.onStream` and dispatches every agent event to:
 *
 * 1. **useSessionRuntimeStore** — lifecycle, interrupt queue, activity tracking.
 * 2. **Per-session callbacks** — so active SessionView can receive streaming
 *    content (message.part.updated etc.) without its own IPC subscription.
 * 3. **Legacy HITL stores** — useQuestionStore, usePermissionStore,
 *    useCommandApprovalStore, plus useSessionStore.pendingPlans — for backward
 *    compatibility until Phase 4 replaces the old UI.
 * 4. **Auxiliary stores** — useContextStore (tokens), useWorktreeStatusStore
 *    (badges), useRecentStore (activity tracking), useUsageStore.
 *
 * This replaces the dual-subscription pattern where both useAgentGlobalListener
 * and SessionView consumed `onStream` events.
 */

import { useEffect, useRef } from 'react'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useQuestionStore } from '@/stores/useQuestionStore'
import { usePermissionStore } from '@/stores/usePermissionStore'
import { useCommandApprovalStore } from '@/stores/useCommandApprovalStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useContextStore } from '@/stores/useContextStore'
import { useRecentStore } from '@/stores/useRecentStore'
import { useUsageStore, resolveUsageProvider } from '@/stores'
import {
  useSessionRuntimeStore,
  acceptSessionEvent,
  syncStreamingBufferGuardState,
  writeEventToStreamingBuffer
} from '@/stores/useSessionRuntimeStore'
import {
  extractTokens,
  extractCost,
  extractCostEventKey,
  extractModelRef,
  extractModelUsage
} from '@/lib/token-utils'
import { applySessionContextUsage } from '@/lib/context-usage'
import { COMPLETION_WORDS } from '@/lib/format-utils'
import { messageSendTimes } from '@/lib/message-send-times'
import { checkAutoApprove } from '@/lib/permissionUtils'
import { toast } from 'sonner'
import type { CanonicalAgentEvent } from '@shared/types/agent-protocol'

// ---------------------------------------------------------------------------
// Helpers (moved from useAgentGlobalListener verbatim)
// ---------------------------------------------------------------------------

interface PromptDispatchContext {
  worktreePath: string
  opencodeSessionId: string
}

function resolvePromptDispatchContextFromStores(sessionId: string): PromptDispatchContext | null {
  const sessionState = useSessionStore.getState()

  for (const [worktreeId, sessions] of sessionState.sessionsByWorktree) {
    const session = sessions.find((s) => s.id === sessionId)
    if (!session?.opencode_session_id) continue

    const worktreesByProject = useWorktreeStore.getState().worktreesByProject
    for (const worktrees of worktreesByProject.values()) {
      const worktree = worktrees.find((w) => w.id === worktreeId)
      if (worktree?.path) {
        return {
          worktreePath: worktree.path,
          opencodeSessionId: session.opencode_session_id
        }
      }
    }
  }

  for (const [_connectionId, sessions] of sessionState.sessionsByConnection) {
    const session = sessions.find((s) => s.id === sessionId)
    if (!session?.opencode_session_id) continue

    const connection = useConnectionStore
      .getState()
      .connections.find((item) => item.id === _connectionId)
    if (connection?.path) {
      return {
        worktreePath: connection.path,
        opencodeSessionId: session.opencode_session_id
      }
    }
  }

  return null
}

async function resolvePromptDispatchContext(
  sessionId: string
): Promise<PromptDispatchContext | null> {
  const storeContext = resolvePromptDispatchContextFromStores(sessionId)

  if (!window.db?.session?.get) {
    return storeContext
  }

  try {
    const dbSession = (await window.db.session.get(sessionId)) as {
      worktree_id?: string | null
      connection_id?: string | null
      opencode_session_id?: string | null
    } | null

    const dbOpcSessionId = dbSession?.opencode_session_id ?? null
    if (!dbOpcSessionId) {
      return storeContext
    }

    if (dbSession?.worktree_id && window.db?.worktree?.get) {
      const dbWorktree = (await window.db.worktree.get(dbSession.worktree_id)) as {
        path?: string | null
      } | null
      if (dbWorktree?.path) {
        return {
          worktreePath: dbWorktree.path,
          opencodeSessionId: dbOpcSessionId
        }
      }
    }

    if (dbSession?.connection_id && window.connectionOps?.get) {
      const connectionResult = await window.connectionOps.get(dbSession.connection_id)
      if (connectionResult.success && connectionResult.connection?.path) {
        return {
          worktreePath: connectionResult.connection.path,
          opencodeSessionId: dbOpcSessionId
        }
      }
    }

    if (storeContext) {
      return { ...storeContext, opencodeSessionId: dbOpcSessionId }
    }
  } catch {
    // DB lookup failed — fall through to store context
  }

  return storeContext
}

function markBackgroundSessionCompleted(sessionId: string): void {
  const sendTime = messageSendTimes.get(sessionId)
  const durationMs = sendTime ? Date.now() - sendTime : 0
  const word = COMPLETION_WORDS[Math.floor(Math.random() * COMPLETION_WORDS.length)]
  useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'completed', { word, durationMs })

  const now = Date.now()
  const sessions = useSessionStore.getState().sessionsByWorktree
  let found = false
  for (const [worktreeId, wSessions] of sessions) {
    if (wSessions.some((s) => s.id === sessionId)) {
      useWorktreeStatusStore.getState().setLastMessageTime(worktreeId, now)
      useRecentStore.getState().addWorktreeToRecent(worktreeId)
      found = true
      break
    }
  }

  const connectionSessions = useSessionStore.getState().sessionsByConnection
  for (const [connectionId, cSessions] of connectionSessions) {
    if (cSessions.some((s) => s.id === sessionId)) {
      useRecentStore.getState().addConnectionToRecent(connectionId)
      break
    }
  }

  if (!found) {
    const connSessions = useSessionStore.getState().sessionsByConnection
    for (const [connectionId, cSessions] of connSessions) {
      if (cSessions.some((s) => s.id === sessionId)) {
        const connection = useConnectionStore
          .getState()
          .connections.find((c) => c.id === connectionId)
        if (connection) {
          for (const member of connection.members) {
            useWorktreeStatusStore.getState().setLastMessageTime(member.worktree_id, now)
          }
        }
        break
      }
    }
  }
}

function trackRecentActivity(sessionId: string): void {
  const wSessions = useSessionStore.getState().sessionsByWorktree
  for (const [worktreeId, sessions] of wSessions) {
    if (sessions.some((s) => s.id === sessionId)) {
      useRecentStore.getState().addWorktreeToRecent(worktreeId)
      break
    }
  }
  const cSessions = useSessionStore.getState().sessionsByConnection
  for (const [connectionId, sessions] of cSessions) {
    if (sessions.some((s) => s.id === sessionId)) {
      useRecentStore.getState().addConnectionToRecent(connectionId)
      break
    }
  }
}

function getSessionFallbackProviderId(sessionId: string): string | undefined {
  const sessionState = useSessionStore.getState() as {
    getSessionById?: (id: string) => {
      model_provider_id?: string | null
      agent_sdk?: string | null
    } | null
  }
  const session =
    typeof sessionState.getSessionById === 'function'
      ? sessionState.getSessionById(sessionId)
      : null
  if (!session) return undefined

  if (session.model_provider_id) {
    return session.model_provider_id
  }

  if (session.agent_sdk === 'claude-code') return 'anthropic'
  if (session.agent_sdk === 'codex') return 'codex'

  return undefined
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentEventBridge(): void {
  const backgroundFollowUpDispatchingRef = useRef<Set<string>>(new Set())
  const deferredIdleWhileDispatchingRef = useRef<Set<string>>(new Set())

  // Branch auto-rename (non-stream channel)
  useEffect(() => {
    const unsubscribe = window.worktreeOps?.onBranchRenamed
      ? window.worktreeOps.onBranchRenamed((data) => {
          const { worktreeId, newBranch } = data
          useWorktreeStore.getState().updateWorktreeBranch(worktreeId, newBranch)
        })
      : () => {}
    return unsubscribe
  }, [])

  // Main event subscription — THE sole onStream subscriber
  useEffect(() => {
    const runtime = useSessionRuntimeStore.getState()

    const unsubscribe = window.agentOps?.onStream
      ? window.agentOps.onStream((event: CanonicalAgentEvent) => {
          const sessionId = event.sessionId
          const activeId = useSessionStore.getState().activeSessionId

          const guard = acceptSessionEvent(event)
          if (!guard.accepted) {
            return
          }

          syncStreamingBufferGuardState(sessionId, guard.state, {
            resetOverlay: guard.advancedRun,
            notify: 'none'
          })
          writeEventToStreamingBuffer(sessionId, event, { activeSessionId: activeId })

          // Always dispatch to per-session callbacks (SessionView streaming)
          runtime.dispatchToSession(sessionId, event)

          // Always touch activity
          runtime.touchActivity(sessionId)

          // ----- Model limits -----
          if (event.type === 'session.model_limits') {
            const models = event.data?.models as
              | Array<{ modelID: string; providerID: string; contextLimit: number }>
              | undefined
            if (models) {
              for (const m of models) {
                if (m.contextLimit > 0) {
                  useContextStore.getState().setModelLimit(m.modelID, m.contextLimit, m.providerID)
                  useContextStore.getState().setModelLimit(m.modelID, m.contextLimit)
                }
              }
            }
            return
          }

          // ----- Context usage (Codex) -----
          if (event.type === 'session.context_usage') {
            applySessionContextUsage(sessionId, event.data)
            return
          }

          // ----- Context compaction -----
          if (event.type === 'session.compaction_started') {
            useContextStore.getState().setSessionContextRefreshing(sessionId, true)
            return
          }

          if (event.type === 'session.context_compacted') {
            useContextStore.getState().setSessionContextRefreshing(sessionId, true)
            return
          }

          // ----- Commands available -----
          if (event.type === 'session.commands_available') {
            runtime.setCommandsAvailable(sessionId, true)
            return
          }

          // ----- message.updated (background title sync + token tracking) -----
          if (event.type === 'message.updated' && sessionId !== activeId) {
            if (event.childSessionId) return

            const sessionTitle =
              (event.data as Record<string, unknown>)?.info?.title ||
              (event.data as Record<string, unknown>)?.title
            const isOpenCodeDefault = /^New session\s*-?\s*\d{4}-\d{2}-\d{2}/i.test(
              (sessionTitle as string) || ''
            )
            if (sessionTitle && !isOpenCodeDefault) {
              useSessionStore.getState().updateSessionName(sessionId, sessionTitle as string)
            }

            const info = (event.data as Record<string, unknown>)?.info as
              | Record<string, unknown>
              | undefined
            if ((info?.time as Record<string, unknown>)?.completed) {
              const data = event.data as Record<string, unknown> | undefined
              if (data) {
                const tokens = extractTokens(data)
                if (tokens) {
                  const modelRef =
                    extractModelRef(data, getSessionFallbackProviderId(sessionId)) ?? undefined
                  useContextStore.getState().setSessionTokens(sessionId, tokens, modelRef)
                }
                const cost = extractCost(data)
                if (cost > 0) {
                  const costKey = extractCostEventKey(data)
                  if (costKey) {
                    useContextStore.getState().addSessionCostOnce(sessionId, costKey, cost)
                  } else {
                    useContextStore.getState().addSessionCost(sessionId, cost)
                  }
                }
                const modelUsageEntries = extractModelUsage(data)
                if (modelUsageEntries) {
                  for (const entry of modelUsageEntries) {
                    if (entry.contextWindow > 0) {
                      useContextStore.getState().setModelLimit(entry.modelName, entry.contextWindow)
                    }
                  }
                }
              }
            }
            return
          }

          // ----- session.updated (background title sync) -----
          if (event.type === 'session.updated' && sessionId !== activeId) {
            const sessionTitle =
              (event.data as Record<string, unknown>)?.info?.title ||
              (event.data as Record<string, unknown>)?.title
            const isOpenCodeDefault = /^New session\s*-?\s*\d{4}-\d{2}-\d{2}/i.test(
              (sessionTitle as string) || ''
            )
            if (sessionTitle && !isOpenCodeDefault) {
              useSessionStore.getState().updateSessionName(sessionId, sessionTitle as string)
            }
            return
          }

          // ----- question.asked -----
          if (event.type === 'question.asked') {
            const request = event.data
            if (request?.id && request?.questions) {
              // Legacy store (backward compat)
              useQuestionStore.getState().addQuestion(sessionId, request)
              // Runtime store interrupt queue
              runtime.pushInterrupt(sessionId, {
                type: 'question',
                id: request.id,
                sessionId,
                data: request
              })
              if (sessionId !== activeId) {
                useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'answering')
              }
            }
            return
          }

          // ----- question.replied / question.rejected -----
          if (event.type === 'question.replied' || event.type === 'question.rejected') {
            const requestId = event.data?.requestID || event.data?.requestId || event.data?.id
            if (requestId) {
              useQuestionStore.getState().removeQuestion(sessionId, requestId)
              runtime.removeInterrupt(sessionId, requestId)
            }
            return
          }

          // ----- permission.asked -----
          if (event.type === 'permission.asked') {
            const request = event.data
            if (request?.id && request?.permission) {
              const { commandFilter } = useSettingsStore.getState()
              const isAutoApprovable =
                !commandFilter.enabled ||
                checkAutoApprove(
                  request as Parameters<typeof checkAutoApprove>[0],
                  commandFilter.allowlist
                )

              if (isAutoApprovable) {
                if (sessionId !== activeId) {
                  window.agentOps
                    .permissionReply(request.id, 'once', undefined)
                    .catch((err: unknown) => {
                      console.warn('Auto-approve permissionReply (background) failed:', err)
                    })
                }
                // Active session: SessionView handles auto-approve with worktreePath
                return
              }
              // Not auto-approvable: add to stores
              usePermissionStore.getState().addPermission(sessionId, request)
              runtime.pushInterrupt(sessionId, {
                type: 'permission',
                id: request.id,
                sessionId,
                data: request
              })
              if (sessionId !== activeId) {
                useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'permission')
              }
            }
            return
          }

          // ----- permission.replied -----
          if (event.type === 'permission.replied') {
            const requestId = event.data?.requestID || event.data?.requestId || event.data?.id
            if (requestId) {
              usePermissionStore.getState().removePermission(sessionId, requestId)
              runtime.removeInterrupt(sessionId, requestId)
              if (sessionId !== activeId) {
                const remaining = usePermissionStore.getState().pendingBySession.get(sessionId)
                if (!remaining || remaining.length === 0) {
                  const mode = useSessionStore.getState().getSessionMode(sessionId)
                  useWorktreeStatusStore
                    .getState()
                    .setSessionStatus(sessionId, mode === 'plan' ? 'planning' : 'working')
                }
              }
            }
            return
          }

          // ----- command.approval_needed -----
          if (event.type === 'command.approval_needed') {
            const request = event.data
            if (request?.id && request?.toolName) {
              const { commandFilter } = useSettingsStore.getState()

              if (!commandFilter.enabled) {
                if (sessionId !== activeId) {
                  window.agentOps.commandApprovalReply(request.id, true).catch((err: unknown) => {
                    console.warn('Auto-approve commandApprovalReply (background) failed:', err)
                  })
                }
                return
              }
              useCommandApprovalStore.getState().addApproval(sessionId, request)
              runtime.pushInterrupt(sessionId, {
                type: 'command_approval',
                id: request.id,
                sessionId,
                data: request
              })
              if (sessionId !== activeId) {
                useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'command_approval')
              }
            }
            return
          }

          // ----- command.approval_replied -----
          if (event.type === 'command.approval_replied') {
            const requestId = event.data?.requestID || event.data?.requestId || event.data?.id
            if (requestId) {
              useCommandApprovalStore.getState().removeApproval(sessionId, requestId)
              runtime.removeInterrupt(sessionId, requestId)
              if (sessionId !== activeId) {
                const remaining = useCommandApprovalStore.getState().getApprovals(sessionId)
                if (remaining.length === 0) {
                  const mode = useSessionStore.getState().getSessionMode(sessionId)
                  useWorktreeStatusStore
                    .getState()
                    .setSessionStatus(sessionId, mode === 'plan' ? 'planning' : 'working')
                }
              }
            }
            return
          }

          // ----- command.approval_problem -----
          if (event.type === 'command.approval_problem') {
            const data = event.data as
              | {
                  requestId?: string
                  commandStr?: string
                  reason?: string
                  suggestion?: string
                }
              | undefined
            if (data) {
              console.warn('[EventBridge] Command approval problem:', {
                sessionId,
                reason: data.reason,
                command: data.commandStr
              })
              toast.warning('Command approval timed out', {
                description: data.suggestion || 'Add a matching pattern in Settings > Security.',
                duration: 10_000,
                action: {
                  label: 'Open Settings',
                  onClick: () => {
                    useSettingsStore.getState().openSettings('security')
                  }
                }
              })
              if (data.requestId) {
                useCommandApprovalStore.getState().removeApproval(sessionId, data.requestId)
                runtime.removeInterrupt(sessionId, data.requestId)
              }
            }
            return
          }

          // ----- plan.ready -----
          if (event.type === 'plan.ready') {
            const data = event.data as
              | { id?: string; requestId?: string; plan?: string; toolUseID?: string }
              | undefined
            const requestId = data?.id || data?.requestId
            if (requestId) {
              useSessionStore.getState().setPendingPlan(sessionId, {
                requestId,
                planContent: data?.plan ?? '',
                toolUseID: data?.toolUseID ?? ''
              })
              runtime.pushInterrupt(sessionId, {
                type: 'plan',
                id: requestId,
                sessionId,
                data: { requestId, planContent: data?.plan ?? '', toolUseID: data?.toolUseID ?? '' }
              })
              useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'plan_ready')
            }
            return
          }

          // ----- plan.resolved -----
          if (event.type === 'plan.resolved') {
            const data = event.data as { requestId?: string; id?: string } | undefined
            const requestId = data?.requestId || data?.id
            useSessionStore.getState().clearPendingPlan(sessionId)
            if (requestId) {
              runtime.removeInterrupt(sessionId, requestId)
            }
            const current = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
            if (current?.status === 'plan_ready') {
              useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
            }
            return
          }

          // ----- session.materialized (P1-6 CR fix: handle for background sessions) -----
          if (event.type === 'session.materialized') {
            const newId = (event.data as Record<string, unknown>)?.newSessionId as
              | string
              | undefined
            if (newId) {
              useSessionStore.getState().setOpenCodeSessionId(sessionId, newId)
            }
            // Also dispatch to per-session callbacks (SessionShell uses this)
            return
          }

          // ----- session.error -----
          // Phase 1.4.8: when the backend emits a session.error (e.g.
          // MessageAbortedError after Stop), force the UI lifecycle back to
          // 'idle' so the ComposerBar Stop icon flips to Send. Some abort
          // paths land error first and idle later (or never) — without this
          // shortcut the Stop button can stay red indefinitely.
          if (event.type === 'session.error') {
            runtime.setLifecycle(sessionId, 'idle')
            runtime.setRetryInfo(sessionId, null)
            return
          }

          // ----- session.status (the main lifecycle signal) -----
          if (event.type !== 'session.status') return

          const status =
            (event as Record<string, unknown>).statusPayload ||
            (event.data as Record<string, unknown>)?.status
          if (!status) return

          const statusType = (status as { type: string }).type

          // --- busy ---
          if (statusType === 'busy') {
            runtime.setLifecycle(sessionId, 'busy')

            // Don't overwrite plan_ready or command_approval badges
            if (useSessionStore.getState().getPendingPlan(sessionId)) return
            const currentStatus = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
            if (currentStatus?.status === 'command_approval') return

            if (sessionId !== activeId) {
              const currentMode = useSessionStore.getState().getSessionMode(sessionId)
              useWorktreeStatusStore
                .getState()
                .setSessionStatus(sessionId, currentMode === 'plan' ? 'planning' : 'working')
            }

            trackRecentActivity(sessionId)
            return
          }

          // --- retry ---
          if (statusType === 'retry') {
            runtime.setLifecycle(sessionId, 'retry')
            runtime.setRetryInfo(sessionId, {
              attempt: (status as { attempt?: number }).attempt ?? 0,
              message: (status as { message?: string }).message,
              next: (status as { next?: number }).next
            })
            return
          }

          // --- idle ---
          if (statusType !== 'idle') return

          runtime.setLifecycle(sessionId, 'idle')
          runtime.setRetryInfo(sessionId, null)

          // Usage tracking on idle
          if (useSettingsStore.getState().showUsageIndicator) {
            const sessionState = useSessionStore.getState()
            let idleSession: {
              agent_sdk?: string | null
              model_provider_id?: string | null
              model_id?: string | null
            } | null = null
            for (const sessions of sessionState.sessionsByWorktree.values()) {
              const found = sessions.find((s) => s.id === sessionId)
              if (found) {
                idleSession = found
                break
              }
            }
            if (!idleSession) {
              for (const sessions of sessionState.sessionsByConnection.values()) {
                const found = sessions.find((s) => s.id === sessionId)
                if (found) {
                  idleSession = found
                  break
                }
              }
            }
            if (idleSession) {
              const provider = resolveUsageProvider(idleSession)
              useUsageStore.getState().fetchUsageForProvider(provider)
            } else {
              useUsageStore.getState().fetchUsage()
            }
          }

          // Don't overwrite plan_ready or command_approval
          if (useSessionStore.getState().getPendingPlan(sessionId)) return
          const statusForIdle = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
          if (statusForIdle?.status === 'command_approval') return

          // Active session lifecycle is handled by SessionView (until Phase 3)
          if (sessionId === activeId) return

          // --- Background follow-up dispatch ---
          const dispatchBackgroundFollowUp = (message: string): void => {
            backgroundFollowUpDispatchingRef.current.add(sessionId)

            void (async () => {
              let dispatchSucceeded = false
              try {
                const context = await resolvePromptDispatchContext(sessionId)
                if (!context || !window.agentOps?.prompt) {
                  useSessionStore.getState().requeueFollowUpMessageFront(sessionId, message)
                  markBackgroundSessionCompleted(sessionId)
                  return
                }

                if (context.opencodeSessionId.startsWith('pending::')) {
                  useSessionStore.getState().requeueFollowUpMessageFront(sessionId, message)
                  markBackgroundSessionCompleted(sessionId)
                  return
                }

                const mode = useSessionStore.getState().getSessionMode(sessionId)
                useWorktreeStatusStore
                  .getState()
                  .setSessionStatus(sessionId, mode === 'plan' ? 'planning' : 'working')

                const result = await window.agentOps.prompt(
                  context.worktreePath,
                  context.opencodeSessionId,
                  [{ type: 'text', text: message }],
                  undefined,
                  { mode }
                )

                if (!result.success) {
                  useSessionStore.getState().requeueFollowUpMessageFront(sessionId, message)
                  markBackgroundSessionCompleted(sessionId)
                  return
                }

                dispatchSucceeded = true
              } catch {
                useSessionStore.getState().requeueFollowUpMessageFront(sessionId, message)
                markBackgroundSessionCompleted(sessionId)
              } finally {
                backgroundFollowUpDispatchingRef.current.delete(sessionId)
              }

              if (!deferredIdleWhileDispatchingRef.current.has(sessionId)) {
                return
              }

              deferredIdleWhileDispatchingRef.current.delete(sessionId)

              if (!dispatchSucceeded) return

              if (useSessionStore.getState().getPendingPlan(sessionId)) return
              const followUpStatus = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
              if (followUpStatus?.status === 'command_approval') return

              const nextFollowUp = useSessionStore.getState().dequeueFollowUpMessage(sessionId)
              if (nextFollowUp) {
                dispatchBackgroundFollowUp(nextFollowUp)
                return
              }

              markBackgroundSessionCompleted(sessionId)
            })()
          }

          if (backgroundFollowUpDispatchingRef.current.has(sessionId)) {
            deferredIdleWhileDispatchingRef.current.add(sessionId)
            return
          }

          const followUp = useSessionStore.getState().dequeueFollowUpMessage(sessionId)
          if (followUp) {
            dispatchBackgroundFollowUp(followUp)
            return
          }

          markBackgroundSessionCompleted(sessionId)
        })
      : () => {}

    return unsubscribe
  }, [])
}
