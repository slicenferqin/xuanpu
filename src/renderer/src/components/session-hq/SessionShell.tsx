/**
 * SessionShell — Phase 6 (Timeline UI)
 *
 * Composition root for the new session UI. Wires together hooks and
 * passes data to child components:
 *
 *   AgentTimeline    — vertical timeline of agent actions
 *   InterruptDock    — first pending HITL prompt
 *   ComposerBar      — glassmorphism floating input (Phase 5 state machine)
 *
 * Data sources:
 *   Durable layer  → useTimeline hook (IPC getTimeline)
 *   Runtime layer  → useSessionRuntimeStore (lifecycle, interrupts, pending)
 *   View layer     → component-local state (streaming, etc.)
 */

import React, {
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
  useSyncExternalStore
} from 'react'
import { AgentTimeline } from './AgentTimeline'
import type { ThreadStatusRowData } from './ThreadStatusRow'
import { InterruptDock } from './InterruptDock'
import { ComposerBar } from './ComposerBar'
import { FieldContextDebug } from '@/components/sessions/FieldContextDebug'
import { MemoryPanel } from '@/components/sessions/MemoryPanel'
import { ContextBudgetDebugger } from '@/components/sessions/ContextBudgetDebugger'
import { ForkFromMessageConfirmDialog } from './ForkFromMessageConfirmDialog'
import { PlanReadyImplementFab } from '../sessions/PlanReadyImplementFab'
import { ScrollToBottomFab } from '../sessions/ScrollToBottomFab'
import { useSessionRuntimeStore } from '@/stores/useSessionRuntimeStore'
import { useSessionStore, type PendingPromptOptions } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores'
import { useContextStore } from '@/stores/useContextStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useDiffCommentStore } from '@/stores/useDiffCommentStore'
import { useSettingsStore, resolveModelForSdk } from '@/stores/useSettingsStore'
import { Loader2, MessageSquare, X } from 'lucide-react'
import type { TimelineMessage } from '@shared/lib/timeline-types'
import type { Attachment } from '../sessions/AttachmentPreview'
import type { MessagePart } from '@shared/types/opencode'
import type { DiffComment } from '@shared/types/git'
import { buildMessageParts } from '@/lib/file-attachment-utils'
import type { CanonicalAgentEvent } from '@shared/types/agent-protocol'
import type { StreamingPart as SharedStreamingPart } from '@shared/lib/timeline-types'
import {
  getStreamingBuffer,
  getStreamingBufferSnapshot,
  subscribeToStreamingBuffer,
  updateStreamingBuffer
} from '@/stores/useSessionRuntimeStore'
import {
  executeSendAction,
  createPendingDrainController,
  type ComposerAction
} from '@/lib/session-send-actions'
import { buildPlanImplementationPrompt } from '@/lib/proposedPlan'
import {
  extractTokens,
  extractCost,
  extractCostEventKey,
  extractModelRef,
  extractModelUsage
} from '@/lib/token-utils'
import { applySessionContextUsage } from '@/lib/context-usage'
import { mapRawTranscriptToTimeline } from '@shared/lib/timeline-mappers'
import { lastSendMode, messageSendTimes } from '@/lib/message-send-times'
import { refreshSessionLastMessageAt } from '@/lib/session-last-message'
import {
  applySessionTaskToolEvent,
  extractMissionTasks,
  type SessionTask
} from '@/lib/session-tasks'
import {
  getMessageDisplayContent,
  getUserMessageForkCutoff,
  restoreMessageModePrefix
} from '@/lib/message-actions'
import { useI18n } from '@/i18n/useI18n'
import { useSessionSmartScroll } from '@/hooks/useSessionSmartScroll'
import { toast } from 'sonner'

function attachmentToMessagePart(attachment: Attachment): MessagePart | null {
  if (attachment.kind !== 'data') return null
  return {
    type: 'file',
    mime: attachment.mime,
    url: attachment.dataUrl,
    filename: attachment.name
  }
}

function attachmentsToMessageParts(attachments: Attachment[]): MessagePart[] {
  return attachments
    .map(attachmentToMessagePart)
    .filter((part): part is MessagePart => part != null)
}

function cacheMessageAttachments(
  cache: Map<string, MessagePart[]>,
  message: TimelineMessage
): void {
  if (message.role !== 'user') return
  if (!message.content.trim()) return
  if (!message.attachments || message.attachments.length === 0) return
  cache.set(message.content.trim(), message.attachments)
}

function escapeContextAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function buildLocalDiffCommentContext(comments: DiffComment[]): string {
  if (comments.length === 0) return ''
  return (
    comments
      .map((comment) => {
        const compareBranch = comment.compareBranch
          ? ` compareBranch="${escapeContextAttribute(comment.compareBranch)}"`
          : ''
        return `<diff-comment file="${escapeContextAttribute(comment.filePath)}" line="${comment.lineNumber}" side="${comment.side}" staged="${comment.staged}" resolved="${comment.resolved}"${compareBranch}>\n${comment.body}\n</diff-comment>`
      })
      .join('\n\n') + '\n\n'
  )
}

function findRoundSection(container: HTMLElement, roundId: string): HTMLElement | null {
  const sections = Array.from(container.querySelectorAll<HTMLElement>('[data-round-id]'))
  return sections.find((section) => section.dataset.roundId === roundId) ?? null
}

function getContainerRelativeTop(container: HTMLElement, target: HTMLElement): number {
  const containerRect = container.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  return container.scrollTop + targetRect.top - containerRect.top
}

function DiffCommentAttachments(): React.JSX.Element | null {
  const { t } = useI18n()
  const attachedComments = useDiffCommentStore((s) => s.attachedComments)
  const removeAttachment = useDiffCommentStore((s) => s.removeAttachment)
  const clearAttachments = useDiffCommentStore((s) => s.clearAttachments)

  if (attachedComments.length === 0) return null

  return (
    <div className="px-4 pt-3 pb-0">
      <div className="flex flex-wrap gap-2">
        {attachedComments.map((comment) => {
          const fileName = comment.filePath.split('/').pop() ?? comment.filePath
          return (
            <div
              key={comment.id}
              className="group relative flex min-w-[180px] max-w-[320px] flex-col gap-1 rounded-md border border-border/70 bg-background/75 px-3 py-2 text-xs"
            >
              <div className="flex items-center gap-2">
                <MessageSquare className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {fileName}
                </span>
                <button
                  type="button"
                  onClick={() => removeAttachment(comment.id)}
                  className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                  aria-label={t('diffComments.removeAttachment')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {comment.filePath}:{comment.lineNumber}
              </span>
              <span className="line-clamp-2 text-muted-foreground">{comment.body}</span>
            </div>
          )
        })}
        {attachedComments.length > 1 && (
          <button
            type="button"
            onClick={clearAttachments}
            className="self-center rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {t('diffComments.clearAttachments')}
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// useTimeline hook — fetches durable timeline from main process
// ---------------------------------------------------------------------------

function useTimeline(
  sessionId: string,
  options?: {
    worktreePath?: string | null
    opencodeSessionId?: string | null
    agentSdk?: string | null
  }
) {
  const worktreePath = options?.worktreePath
  const opencodeSessionId = options?.opencodeSessionId
  const agentSdk = options?.agentSdk
  // Restore optimistic messages from buffer on mount so they survive tab switches
  const initBuffer = getStreamingBuffer(sessionId)
  const [messages, setMessages] = useState<TimelineMessage[]>(
    () => (initBuffer?.optimisticMessages as TimelineMessage[] | undefined) ?? []
  )
  const [loading, setLoading] = useState(true)
  // Cache user-message attachments so they survive transcript refreshes.
  // Backend-loaded messages don't carry attachment data (images are base64-encoded
  // locally), so we preserve them by matching on normalised content.
  const attachmentCacheRef = useRef(new Map<string, MessagePart[]>())
  // Track optimistic (not-yet-persisted) user messages so they can be
  // merged back after a refresh and saved to the streaming buffer.
  const optimisticRef = useRef<TimelineMessage[]>(
    (initBuffer?.optimisticMessages as TimelineMessage[] | undefined) ?? []
  )

  const refresh = useCallback(async (): Promise<TimelineMessage[]> => {
    if (!window.agentOps?.getTimeline) {
      setLoading(false)
      return []
    }
    try {
      const result = await window.agentOps.getTimeline(sessionId)
      let durableMessages = result.messages

      const hasRenderableAssistant = durableMessages.some(
        (msg) =>
          msg.role === 'assistant' &&
          ((typeof msg.content === 'string' && msg.content.trim().length > 0) ||
            (Array.isArray(msg.parts) && msg.parts.length > 0))
      )

      const canFallbackToSdkMessages =
        Boolean(window.agentOps?.getMessages) &&
        typeof worktreePath === 'string' &&
        worktreePath.length > 0 &&
        typeof opencodeSessionId === 'string' &&
        opencodeSessionId.length > 0 &&
        agentSdk !== 'codex' &&
        agentSdk !== 'terminal'

      if (!hasRenderableAssistant && canFallbackToSdkMessages) {
        try {
          const transcript = await window.agentOps.getMessages(worktreePath!, opencodeSessionId!)
          if (
            transcript.success &&
            Array.isArray(transcript.messages) &&
            transcript.messages.length > 0
          ) {
            const fallbackMessages = mapRawTranscriptToTimeline(transcript.messages)
            const fallbackHasAssistant = fallbackMessages.some(
              (msg) =>
                msg.role === 'assistant' &&
                ((typeof msg.content === 'string' && msg.content.trim().length > 0) ||
                  (Array.isArray(msg.parts) && msg.parts.length > 0))
            )
            if (fallbackHasAssistant) {
              durableMessages = fallbackMessages
            }
          }
        } catch (err) {
          console.warn('[SessionShell] getMessages fallback failed:', err)
        }
      }

      // Restore cached attachments onto refreshed messages
      const cache = attachmentCacheRef.current
      const restored =
        cache.size > 0
          ? durableMessages.map((msg) => {
              if (msg.role === 'user' && !msg.attachments) {
                const stored = cache.get(msg.content.trim())
                if (stored) return { ...msg, attachments: stored }
              }
              return msg
            })
          : durableMessages

      // Merge back optimistic messages not yet present in DB results.
      // Match by content — once the DB contains a user message with the same
      // trimmed text, the optimistic copy is no longer needed.
      const dbContents = new Set(
        restored.filter((m) => m.role === 'user').map((m) => m.content.trim())
      )
      const stillPending = optimisticRef.current.filter((om) => !dbContents.has(om.content.trim()))
      optimisticRef.current = stillPending
      // Merge by timestamp so optimistic user messages appear before any
      // assistant response that already landed in the DB, not tacked onto the end.
      const merged =
        stillPending.length > 0
          ? [...restored, ...stillPending].sort((a, b) => {
              const ta = Date.parse(a.timestamp)
              const tb = Date.parse(b.timestamp)
              if (Number.isNaN(ta) || Number.isNaN(tb)) return 0
              return ta - tb
            })
          : restored
      setMessages(merged)
      return merged
    } catch (err) {
      console.warn('[SessionShell] getTimeline failed:', err)
      return []
    } finally {
      setLoading(false)
    }
  }, [sessionId, worktreePath, opencodeSessionId, agentSdk])

  useEffect(() => {
    setLoading(true)
    // Don't clear messages here — refresh() overwrites them once IPC returns.
    // Clearing early causes a flash-of-empty and loses optimistic messages
    // when SessionShell remounts (e.g. tab switch).
    attachmentCacheRef.current.clear()
    for (const msg of optimisticRef.current) {
      cacheMessageAttachments(attachmentCacheRef.current, msg)
    }
    refresh()
  }, [sessionId, refresh])

  // Optimistic insert — append a local user message before the server confirms
  const appendOptimistic = useCallback((msg: TimelineMessage) => {
    // Cache attachments keyed by normalised content for restoreUserAttachments
    cacheMessageAttachments(attachmentCacheRef.current, msg)
    // Track optimistic messages so they survive tab switches via streaming buffer
    optimisticRef.current = [...optimisticRef.current, msg]
    setMessages((prev) => [...prev, msg])
  }, [])

  return { messages, setMessages, loading, refresh, appendOptimistic, optimisticRef }
}

// ---------------------------------------------------------------------------
// useSessionRuntime selector — session-scoped runtime state
// ---------------------------------------------------------------------------

function useSessionRuntime(sessionId: string) {
  const lifecycle = useSessionRuntimeStore((s) => s.getSession(sessionId).lifecycle)
  const interruptQueue = useSessionRuntimeStore((s) => s.getInterruptQueue(sessionId))
  const pendingCount = useSessionRuntimeStore((s) => s.getPendingCount(sessionId))

  return { lifecycle, interruptQueue, pendingCount }
}

function useStreamingMirror(sessionId: string) {
  return useSyncExternalStore(
    useCallback((cb) => subscribeToStreamingBuffer(sessionId, cb), [sessionId]),
    useCallback(() => getStreamingBufferSnapshot(sessionId), [sessionId]),
    useCallback(() => getStreamingBufferSnapshot(sessionId), [sessionId])
  )
}

function waitForSessionIdleAfterAbort(sessionId: string, timeoutMs = 2500): Promise<void> {
  const isReady = (): boolean => {
    const lifecycle = useSessionRuntimeStore.getState().getSession(sessionId).lifecycle
    return lifecycle === 'idle' || lifecycle === 'error'
  }

  if (isReady()) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof window.setTimeout> | null = null
    let unsubscribe: (() => void) | null = null

    const settle = (): void => {
      if (settled) return
      settled = true
      unsubscribe?.()
      if (timer !== null) window.clearTimeout(timer)
      resolve()
    }

    unsubscribe = useSessionRuntimeStore.subscribe(() => {
      if (isReady()) settle()
    })

    // Close the small race where the idle transition lands between the first
    // read and subscription registration.
    if (isReady()) {
      settle()
      return
    }

    // Deadlock guard only: the normal path resolves on the lifecycle event.
    timer = window.setTimeout(settle, timeoutMs)
  })
}

// ---------------------------------------------------------------------------
// SessionShell
// ---------------------------------------------------------------------------

export interface SessionShellProps {
  sessionId: string
}

type RendererPromptOptions = {
  mode?: 'build' | 'plan'
  goalMode?: boolean
  successCriteria?: string
}

export function SessionShell({ sessionId }: SessionShellProps): React.JSX.Element {
  const { t } = useI18n()
  // --- Data sources ---
  const sessionRecord = useSessionStore((state) => {
    for (const sessions of state.sessionsByWorktree.values()) {
      if (!Array.isArray(sessions)) continue
      const found = sessions.find((s) => s.id === sessionId)
      if (found) return found
    }
    for (const sessions of state.sessionsByConnection.values()) {
      if (!Array.isArray(sessions)) continue
      const found = sessions.find((s) => s.id === sessionId)
      if (found) return found
    }
    return null
  })

  const worktreeId = sessionRecord?.worktree_id
  const connectionId = sessionRecord?.connection_id ?? null

  // Resolve working directory path synchronously from worktree store (worktree sessions)
  const worktreePathFromStore = useWorktreeStore((s) => {
    if (!worktreeId) return null
    for (const worktrees of s.worktreesByProject.values()) {
      const match = worktrees.find((w) => w.id === worktreeId)
      if (match) return match.path
    }
    return null
  })

  // For connection sessions, resolve path asynchronously via IPC
  const [resolvedPath, setResolvedPath] = useState<string | null>(worktreePathFromStore)
  useEffect(() => {
    if (worktreePathFromStore) {
      setResolvedPath(worktreePathFromStore)
      return
    }
    if (!connectionId) return

    let cancelled = false
    window.connectionOps
      .get(connectionId)
      .then((result) => {
        if (!cancelled && result.success && result.connection?.path) {
          setResolvedPath(result.connection.path)
        }
      })
      .catch((err) => {
        console.error('[SessionShell:path] IPC error', err)
      })
    return () => {
      cancelled = true
    }
  }, [worktreePathFromStore, connectionId])

  const worktreePath = resolvedPath
  const opcSessionId = sessionRecord?.opencode_session_id ?? null
  const agentSdk = sessionRecord?.agent_sdk ?? null

  // We need droidSessionId before useTimeline so that, after connect/reconnect,
  // the SDK transcript fallback can hydrate prior history even when the
  // session record's opencode_session_id is still null on first mount.
  const [droidSessionId, setDroidSessionId] = useState<string | null>(
    sessionRecord?.opencode_session_id ?? null
  )

  const {
    messages: timelineMessages,
    setMessages,
    loading,
    refresh,
    appendOptimistic,
    optimisticRef
  } = useTimeline(sessionId, {
    worktreePath,
    // After connect/reconnect we know the live OpenCode session id even if
    // sessionRecord.opencode_session_id is still null on first mount, so
    // fall back to droidSessionId so the SDK transcript fallback path can
    // hydrate prior history before the first turn finishes.
    opencodeSessionId: opcSessionId ?? droidSessionId,
    agentSdk
  })
  const { lifecycle, interruptQueue, pendingCount } = useSessionRuntime(sessionId)

  useEffect(() => {
    void useSessionRuntimeStore.getState().hydratePendingMessages(sessionId)
  }, [sessionId])

  // --- Connect or reconnect to agent runtime on mount ---

  // --- Plan mode ---
  const mode = useSessionStore((s) => s.modeBySession?.get(sessionId) ?? 'build')
  const pendingPlan = useSessionStore((s) => s.pendingPlans?.get(sessionId) ?? null)
  const [goalMode, setGoalMode] = useState(false)
  const [successCriteria, setSuccessCriteria] = useState('')
  const supportsSessionGoalMode = agentSdk === 'codex' || agentSdk === 'claude-code'
  // Claude Code's ExitPlanMode tool_use.input.plan is usually empty — the SDK
  // writes the plan to disk and we read it during canUseTool, then ship it via
  // plan.ready. Expose it by tool_use id so PlanCard can render the real text.
  const planContentByToolUseId = useMemo(() => {
    const map = new Map<string, string>()
    if (pendingPlan?.toolUseID && pendingPlan.planContent) {
      map.set(pendingPlan.toolUseID, pendingPlan.planContent)
    }
    return map
  }, [pendingPlan?.toolUseID, pendingPlan?.planContent])
  const toggleMode = useCallback(() => {
    useSessionStore.getState().toggleSessionMode(sessionId)
  }, [sessionId])
  const toggleGoalMode = useCallback(() => {
    setGoalMode((current) => !current)
  }, [])

  useEffect(() => {
    setGoalMode(false)
    setSuccessCriteria('')
  }, [sessionId])

  // --- Persisted usage summary (survives restart) ---
  const refreshUsageSummary = useCallback(async (): Promise<void> => {
    if (!window.usageAnalyticsOps?.fetchSessionSummary) {
      return
    }

    try {
      const result = await window.usageAnalyticsOps.fetchSessionSummary(sessionId)
      if (!result.success || !result.data) {
        return
      }

      const data = result.data
      const store = useContextStore.getState()
      if ((store.costBySession[sessionId] ?? 0) < data.total_cost) {
        store.setSessionCost(sessionId, data.total_cost)
      }
    } catch {
      // Non-fatal — live context store remains the source of truth while active.
    }
  }, [sessionId])

  useEffect(() => {
    refreshUsageSummary().catch(() => {})
  }, [refreshUsageSummary])

  // Hydrate context-window tokens from the last persisted assistant message
  // when the timeline first loads / session switches. Runtime events will
  // overwrite this with the exact current snapshot once a new turn fires —
  // but without this hydration, opening an old session shows 0% context until
  // the next message is sent.
  useEffect(() => {
    if (timelineMessages.length === 0) return
    // Find the most recent assistant message with any real usage numbers.
    let usageMsg: TimelineMessage | undefined
    for (let i = timelineMessages.length - 1; i >= 0; i--) {
      const msg = timelineMessages[i]
      if (msg.role !== 'assistant' || !msg.usage) continue
      const u = msg.usage
      if ((u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0) > 0) {
        usageMsg = msg
        break
      }
    }
    if (!usageMsg?.usage) return
    const store = useContextStore.getState()
    // Don't clobber an already-set runtime snapshot with a stale DB value.
    const existing = store.tokensBySession[sessionId]
    const existingTotal =
      (existing?.input ?? 0) +
      (existing?.output ?? 0) +
      (existing?.cacheRead ?? 0) +
      (existing?.cacheWrite ?? 0)
    if (existingTotal > 0) return
    store.setSessionTokens(
      sessionId,
      {
        input: usageMsg.usage.input ?? 0,
        output: usageMsg.usage.output ?? 0,
        reasoning: usageMsg.usage.reasoning ?? 0,
        cacheRead: usageMsg.usage.cacheRead ?? 0,
        cacheWrite: usageMsg.usage.cacheWrite ?? 0
      },
      usageMsg.modelRef
    )
  }, [sessionId, timelineMessages])

  // --- Model resolution ---
  const resolvedModel = useSettingsStore((s) => (agentSdk ? resolveModelForSdk(agentSdk, s) : null))
  const requestModel = useMemo(() => {
    if (sessionRecord?.model_provider_id && sessionRecord.model_id) {
      return {
        providerID: sessionRecord.model_provider_id,
        modelID: sessionRecord.model_id,
        ...(resolvedModel &&
        resolvedModel.providerID === sessionRecord.model_provider_id &&
        resolvedModel.modelID === sessionRecord.model_id &&
        resolvedModel.variant
          ? { variant: resolvedModel.variant }
          : {})
      }
    }

    return resolvedModel ?? undefined
  }, [resolvedModel, sessionRecord?.model_provider_id, sessionRecord?.model_id])
  // Build prompt options once so every send path (first prompt / queued drain /
  // follow-up / proposed-plan implement) sees the same runtime-specific flags.
  const promptOptions = useMemo<RendererPromptOptions | undefined>(() => {
    if (supportsSessionGoalMode) {
      return { goalMode, successCriteria }
    }
    if (agentSdk === 'opencode') {
      return { mode }
    }
    return undefined
  }, [agentSdk, goalMode, mode, successCriteria, supportsSessionGoalMode])
  const buildPendingPromptOptions = useCallback(
    (options?: PendingPromptOptions): RendererPromptOptions | undefined => {
      if (supportsSessionGoalMode) {
        return {
          goalMode: options?.goalMode ?? promptOptions?.goalMode ?? false,
          successCriteria: options?.successCriteria ?? promptOptions?.successCriteria ?? ''
        }
      }

      if (agentSdk === 'opencode') {
        return { mode: options?.mode ?? mode }
      }

      return undefined
    },
    [agentSdk, mode, promptOptions, supportsSessionGoalMode]
  )
  const currentProviderId = requestModel?.providerID ?? ''
  const skipForkFromMessageConfirm = useSettingsStore((s) => s.skipForkFromMessageConfirm)

  // --- Live streaming mirror (module-level runtime truth) ---
  const streamingMirror = useStreamingMirror(sessionId)
  const streamingContent = streamingMirror.streamingContent
  const isStreaming = streamingMirror.isStreaming
  const runStartedAt = streamingMirror.runStartedAt ?? null
  const compactionState = streamingMirror.compactionState ?? null
  const streamingParts = streamingMirror.parts
  const mirrorVersion = streamingMirror.mirrorVersion
  const childPartsMap = streamingMirror.childParts
  const timelineBottomAreaRef = useRef<HTMLDivElement>(null)
  const composerBarRef = useRef<HTMLDivElement>(null)
  const pendingDrainController = useMemo(() => createPendingDrainController(), [])

  // Incremented when session.commands_available fires — triggers ComposerBar re-fetch
  const [commandsVersion, setCommandsVersion] = useState(0)
  const [supportsSteer, setSupportsSteer] = useState(agentSdk === 'codex')
  const preferSteerWhenBusy = agentSdk === 'codex'
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState('')
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null)
  const [pendingForkMessageId, setPendingForkMessageId] = useState<string | null>(null)
  const [forkConfirmDismissChecked, setForkConfirmDismissChecked] = useState(false)
  const [activeRoundId, setActiveRoundId] = useState<string | null>(null)
  const [clearScreenActive, setClearScreenActive] = useState(false)
  const pendingTurnTopScrollRef = useRef<string | null>(null)

  const requestTurnTopScroll = useCallback((roundId: string) => {
    pendingTurnTopScrollRef.current = roundId
    setClearScreenActive(true)
    setActiveRoundId(roundId)
  }, [])

  useEffect(() => {
    pendingTurnTopScrollRef.current = null
    setClearScreenActive(false)
  }, [sessionId])

  useEffect(() => {
    const lastUserMessage = [...timelineMessages]
      .reverse()
      .find((message) => message.role === 'user')
    if (lastUserMessage) {
      setActiveRoundId((current) => current ?? lastUserMessage.id)
    } else {
      setActiveRoundId(null)
    }
  }, [timelineMessages])

  const drainQueuedMessage = useCallback(async (): Promise<boolean> => {
    if (!worktreePath || !droidSessionId) return false

    try {
      const drained = await pendingDrainController.drainNextPending(
        sessionId,
        droidSessionId,
        (sid) => useSessionRuntimeStore.getState().claimNextPendingMessage(sid),
        async (wp, sid, message) => {
          let messageParts: MessagePart[] | undefined
          if (message.attachments.length > 0) {
            messageParts = await buildMessageParts(
              message.attachments as Attachment[],
              message.content
            )
          }
          return window.agentOps.prompt(
            wp,
            sid,
            messageParts ?? message.content,
            message.model ?? requestModel,
            message.promptOptions ?? promptOptions
          )
        },
        worktreePath,
        (sid, message) => useSessionRuntimeStore.getState().restorePendingMessage(sid, message.id),
        (sid, message) => useSessionRuntimeStore.getState().completePendingMessage(sid, message.id)
      )
      if (drained) void refreshSessionLastMessageAt(sessionId)
      return drained
    } catch (err) {
      console.error('[SessionShell] drainNextPending failed:', err)
      return false
    }
  }, [droidSessionId, pendingDrainController, promptOptions, requestModel, sessionId, worktreePath])

  useEffect(() => {
    if (lifecycle !== 'idle' || pendingCount === 0) return
    void drainQueuedMessage()
  }, [drainQueuedMessage, lifecycle, pendingCount])

  const syncOptimisticMessagesToMirror = useCallback(() => {
    updateStreamingBuffer(
      sessionId,
      (current) => ({
        ...current,
        optimisticMessages:
          optimisticRef.current.length > 0 ? [...optimisticRef.current] : undefined
      }),
      { notify: 'immediate' }
    )
  }, [sessionId, optimisticRef])

  useEffect(() => {
    if (!droidSessionId || !window.agentOps?.capabilities) {
      setSupportsSteer(agentSdk === 'codex')
      return
    }

    let cancelled = false

    window.agentOps
      .capabilities(droidSessionId)
      .then((result) => {
        if (cancelled) return
        setSupportsSteer(Boolean(result.success && result.capabilities?.supportsSteer))
      })
      .catch(() => {
        if (!cancelled) {
          setSupportsSteer(agentSdk === 'codex')
        }
      })

    return () => {
      cancelled = true
    }
  }, [agentSdk, droidSessionId])

  const resetLiveOverlay = useCallback(
    (nextIsStreaming: boolean) => {
      updateStreamingBuffer(
        sessionId,
        (current) => ({
          ...current,
          parts: [],
          childParts: new Map<string, SharedStreamingPart[]>(),
          streamingContent: '',
          isStreaming: nextIsStreaming,
          runStartedAt: undefined,
          compactionState: null
        }),
        { notify: 'immediate' }
      )
    },
    [sessionId]
  )

  // --- Mission task state (shared with the right-side context panel) ---
  const missionTasksRef = useRef<SessionTask[]>([])
  const timelineMessagesRef = useRef<TimelineMessage[]>([])
  const lastTaskRoundIdRef = useRef<string | null>(null)

  useEffect(() => {
    timelineMessagesRef.current = timelineMessages
  }, [timelineMessages])

  const setSharedMissionTasks = useCallback(
    (tasks: SessionTask[]) => {
      missionTasksRef.current = tasks
      useSessionRuntimeStore.getState().setSessionTasks(sessionId, tasks)
    },
    [sessionId]
  )

  const latestUserMessageId = useMemo(() => {
    for (let i = timelineMessages.length - 1; i >= 0; i--) {
      if (timelineMessages[i].role === 'user') return timelineMessages[i].id
    }
    return null
  }, [timelineMessages])

  useEffect(() => {
    if (lastTaskRoundIdRef.current !== latestUserMessageId) {
      lastTaskRoundIdRef.current = latestUserMessageId
      setSharedMissionTasks([])
    }
  }, [latestUserMessageId, setSharedMissionTasks])

  useEffect(() => {
    missionTasksRef.current = useSessionRuntimeStore.getState().getSessionTasks(sessionId)
  }, [sessionId])

  const hasDurableCompactionMessage = useMemo(
    () =>
      timelineMessages.some((message) =>
        (message.parts ?? []).some((part) => part.type === 'compaction')
      ),
    [timelineMessages]
  )

  const inflightCompactionRow = useMemo<ThreadStatusRowData | null>(() => {
    if (!compactionState) return null
    if (compactionState.phase === 'completed' && hasDurableCompactionMessage) return null
    return {
      id: `compaction-${sessionId}`,
      kind: compactionState.phase === 'running' ? 'compacting' : 'compacted',
      timestamp: compactionState.timestamp,
      ephemeral: true
    }
  }, [compactionState, hasDurableCompactionMessage, sessionId])

  const ephemeralStatusRows = useMemo<ThreadStatusRowData[]>(() => {
    const rows: ThreadStatusRowData[] = []

    if (runStartedAt && (lifecycle === 'busy' || lifecycle === 'materializing')) {
      rows.push({
        id: `running-${sessionId}`,
        kind: 'running',
        timestamp: runStartedAt,
        startedAt: runStartedAt,
        ephemeral: true
      })
    }

    return rows
  }, [lifecycle, runStartedAt, sessionId])

  const liveTimelineContentVersion = useMemo(
    () =>
      timelineMessages.length +
      ephemeralStatusRows.length +
      streamingParts.length +
      streamingContent.length +
      mirrorVersion,
    [
      ephemeralStatusRows.length,
      mirrorVersion,
      streamingContent.length,
      streamingParts.length,
      timelineMessages.length
    ]
  )

  // Ref so we can update the measured spacer height and have useSessionSmartScroll
  // read the latest value without re-initializing the hook.
  const clearScreenBottomInsetRef = useRef(0)

  const smartScroll = useSessionSmartScroll({
    sessionId,
    ready: !loading,
    contentVersion: liveTimelineContentVersion,
    mirrorVersion,
    isStreaming,
    bottomAreaRef: timelineBottomAreaRef,
    composerRef: composerBarRef,
    clearScreenBottomInsetRef
  })
  const timelineScrollContainerRef = smartScroll.scrollContainerRef
  const scrollTimelineToOffset = smartScroll.scrollToOffset

  const timelineContentRef = useRef<HTMLDivElement | null>(null)
  const [timelineViewportHeight, setTimelineViewportHeight] = useState(0)
  const [timelineContentHeight, setTimelineContentHeight] = useState(0)

  // Measure the timeline scroll container and content heights to compute the
  // clear-screen spacer height. This must be passed to useSessionSmartScroll so
  // that getDistanceFromBottom correctly accounts for the inflated scrollHeight.
  useLayoutEffect(() => {
    const scrollElement = timelineScrollContainerRef.current
    const contentElement = timelineContentRef.current
    if (!scrollElement || !contentElement) return

    let frame: number | null = null
    const updateMetrics = (): void => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      frame = requestAnimationFrame(() => {
        frame = null
        setTimelineViewportHeight(Math.round(scrollElement.clientHeight))
        setTimelineContentHeight(Math.round(contentElement.getBoundingClientRect().height))
      })
    }

    updateMetrics()
    const observer = new ResizeObserver(updateMetrics)
    observer.observe(scrollElement)
    observer.observe(contentElement)
    return () => {
      observer.disconnect()
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [
    timelineScrollContainerRef,
    timelineContentRef,
    // Re-set ResizeObserver when content length changes so measurements are fresh
    timelineMessages.length,
    isStreaming
  ])

  // safeBottomPadding must match AgentTimeline's computation so the spacer height
  // formula is consistent on both sides of the prop boundary.
  const safeBottomPadding =
    smartScroll.bottomFloatingHeight > 0
      ? Math.min(96, Math.max(56, Math.round(smartScroll.bottomFloatingHeight * 0.3) + 32))
      : 72

  const clearScreenBottomInset =
    timelineViewportHeight > 0 && timelineContentHeight > 0
      ? Math.max(0, timelineViewportHeight - timelineContentHeight - safeBottomPadding - 24)
      : 0

  // Sync the measured spacer height into the ref so useSessionSmartScroll reads
  // the latest value on every scroll calculation without re-initializing.
  useEffect(() => {
    clearScreenBottomInsetRef.current = clearScreenBottomInset
  }, [clearScreenBottomInset])

  // 清屏滚动效果：当新 round 开始时，将新 round 的顶部对齐到当前视口顶部。
  // 使用 useLayoutEffect 确保在 DOM 更新后立即执行，避免闪烁。
  useLayoutEffect(() => {
    const roundId = pendingTurnTopScrollRef.current
    const container = timelineScrollContainerRef.current
    if (!roundId || !container) return

    const roundElement = container.querySelector(`[data-round-id="${roundId}"]`)
    if (!roundElement) return

    // 计算元素相对于容器的位置，使新 round 对齐当前视口顶部
    const containerRect = container.getBoundingClientRect()
    const roundRect = roundElement.getBoundingClientRect()
    const targetTop = container.scrollTop + (roundRect.top - containerRect.top)

    scrollTimelineToOffset(targetTop, 'instant')
    pendingTurnTopScrollRef.current = null
  }, [
    activeRoundId,
    clearScreenActive,
    clearScreenBottomInset,
    scrollTimelineToOffset,
    timelineScrollContainerRef,
    timelineMessages.length
  ])

  const scrollFabBottomOffset = useMemo(
    () => Math.max(smartScroll.scrollFabBottomOffset, pendingPlan ? 152 : 16),
    [pendingPlan, smartScroll.scrollFabBottomOffset]
  )

  useEffect(() => {
    if (hasDurableCompactionMessage && compactionState?.phase === 'completed') {
      updateStreamingBuffer(
        sessionId,
        (current) => ({
          ...current,
          compactionState: null
        }),
        { notify: 'immediate' }
      )
    }
  }, [hasDurableCompactionMessage, compactionState, sessionId])

  const transitionToolStatus = useCallback(
    (toolUseID: string, status: 'success' | 'error' | 'rejected', error?: string) => {
      const mapper = (p: SharedStreamingPart): SharedStreamingPart =>
        p.type === 'tool_use' && p.toolUse?.id === toolUseID
          ? { ...p, toolUse: { ...p.toolUse!, status, ...(error ? { error } : {}) } }
          : p

      updateStreamingBuffer(
        sessionId,
        (current) => ({
          ...current,
          parts: current.parts.map(mapper)
        }),
        { notify: 'immediate' }
      )

      // Persist the visual status in committed timeline messages too, since
      // the plan card may already have been materialized from durable history.
      const updatedMessages = timelineMessagesRef.current.map((msg) => {
        if (!msg.parts) return msg
        let changed = false
        const updatedParts = msg.parts.map((part) => {
          const result = mapper(part)
          if (result !== part) changed = true
          return result
        })
        return changed ? { ...msg, parts: updatedParts } : msg
      })
      timelineMessagesRef.current = updatedMessages
      setMessages(updatedMessages)
    },
    [sessionId, setMessages]
  )

  useEffect(() => {
    if (!worktreePath) return

    let cancelled = false
    ;(async () => {
      try {
        if (opcSessionId) {
          const result = await window.agentOps.reconnect(worktreePath, opcSessionId, sessionId)
          if (!cancelled && result.success) {
            const runtimeSessionId = result.sessionId ?? opcSessionId
            setDroidSessionId(runtimeSessionId)
            if (runtimeSessionId !== opcSessionId) {
              useSessionStore.getState().setOpenCodeSessionId(sessionId, runtimeSessionId)
              await window.db.session.update(sessionId, {
                opencode_session_id: runtimeSessionId
              })
            }
          }
        } else {
          const result = await window.agentOps.connect(worktreePath, sessionId)
          if (!cancelled && result.success && result.sessionId) {
            setDroidSessionId(result.sessionId)
            useSessionStore.getState().setOpenCodeSessionId(sessionId, result.sessionId)
            await window.db.session.update(sessionId, {
              opencode_session_id: result.sessionId
            })
          }
        }
      } catch (err) {
        console.warn('[SessionShell] connect/reconnect failed:', err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [sessionId, worktreePath, opcSessionId, agentSdk])

  useEffect(() => {
    if (!worktreePath || !droidSessionId) return

    const pending = useSessionStore.getState().dequeuePendingMessageWithOptions(sessionId)
    if (!pending) return

    let cancelled = false
    const effectivePromptOptions = buildPendingPromptOptions(pending.options)
    const pendingMode = pending.options?.mode ?? mode
    const optimisticMessageId = `optimistic-${Date.now()}`

    ;(async () => {
      try {
        resetLiveOverlay(true)
        useSessionStore.getState().markSessionFirstMessage(sessionId)
        messageSendTimes.set(sessionId, Date.now())
        lastSendMode.set(sessionId, pendingMode)
        useWorktreeStatusStore
          .getState()
          .setSessionStatus(sessionId, pendingMode === 'plan' ? 'planning' : 'working')

        const optimisticMsg: TimelineMessage = {
          id: optimisticMessageId,
          role: 'user',
          content: pending.message,
          timestamp: new Date().toISOString()
        }
        appendOptimistic(optimisticMsg)
        requestTurnTopScroll(optimisticMsg.id)
        timelineMessagesRef.current = [...timelineMessagesRef.current, optimisticMsg]
        syncOptimisticMessagesToMirror()

        const result = await window.agentOps.prompt(
          worktreePath,
          droidSessionId,
          pending.message,
          requestModel,
          effectivePromptOptions
        )

        if (cancelled) return

        if (!result.success) {
          throw new Error(result.error || 'Failed to send pending message')
        }

        void refreshSessionLastMessageAt(sessionId)
      } catch (err) {
        console.error('[SessionShell] pending message send failed:', err)
        useSessionStore
          .getState()
          .requeuePendingMessage(sessionId, pending.message, pending.options)
        optimisticRef.current = optimisticRef.current.filter(
          (msg) => msg.id !== optimisticMessageId
        )
        timelineMessagesRef.current = timelineMessagesRef.current.filter(
          (msg) => msg.id !== optimisticMessageId
        )
        setMessages((prev) => prev.filter((msg) => msg.id !== optimisticMessageId))
        syncOptimisticMessagesToMirror()
        useWorktreeStatusStore.getState().clearSessionStatus(sessionId)
        resetLiveOverlay(false)
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : 'Failed to send pending message')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    sessionId,
    worktreePath,
    droidSessionId,
    buildPendingPromptOptions,
    mode,
    requestModel,
    appendOptimistic,
    requestTurnTopScroll,
    syncOptimisticMessagesToMirror,
    optimisticRef,
    resetLiveOverlay,
    setMessages
  ])

  useEffect(() => {
    if (!worktreePath || !droidSessionId || !window.agentOps?.getMessages) return

    let cancelled = false
    ;(async () => {
      try {
        const result = await window.agentOps.getMessages(worktreePath, droidSessionId)
        if (!result.success || !Array.isArray(result.messages) || cancelled) return

        const store = useContextStore.getState()
        let totalCost = 0
        let snapshotTokens: import('@/stores/useContextStore').TokenInfo | null = null
        let snapshotModelRef: import('@/stores/useContextStore').SessionModelRef | undefined

        for (let i = result.messages.length - 1; i >= 0; i--) {
          const rawMessage = result.messages[i]
          if (typeof rawMessage !== 'object' || rawMessage === null) continue

          const messageRecord = rawMessage as Record<string, unknown>
          const info = messageRecord.info as Record<string, unknown> | undefined
          const role =
            (info?.role as string | undefined) ?? (messageRecord.role as string | undefined)
          if (role !== 'assistant') continue

          totalCost += extractCost(messageRecord)

          if (!snapshotTokens) {
            const tokens = extractTokens(messageRecord)
            if (tokens) {
              snapshotTokens = tokens
              snapshotModelRef = extractModelRef(messageRecord, currentProviderId) ?? undefined
            }
          }
        }

        if (!cancelled && snapshotTokens && !store.tokensBySession[sessionId]) {
          store.setSessionTokens(sessionId, snapshotTokens, snapshotModelRef)
        }
        if (!cancelled && totalCost > 0 && (store.costBySession[sessionId] ?? 0) === 0) {
          store.setSessionCost(sessionId, totalCost)
        }
      } catch (err) {
        console.warn('[SessionShell] getMessages hydrate failed:', err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [sessionId, worktreePath, droidSessionId, currentProviderId])

  // --- Subscribe to per-session events for streaming ---
  useEffect(() => {
    const unsubscribe = useSessionRuntimeStore
      .getState()
      .subscribeToSessionEvents(sessionId, (event: CanonicalAgentEvent) => {
        // Live streaming parts
        if (event.type === 'message.part.updated') {
          const partData = event.data
          if (!partData) return
          if (event.childSessionId) return

          const part = partData.part as Record<string, unknown> | undefined
          if (part?.type === 'tool') {
            const toolName = (part.tool as string) || undefined
            const state = (part.state as Record<string, unknown>) || {}
            // callID 在整个 tool 生命周期内保持不变；fallback 到 part.id。
            // 这是 stream 期间 reducer 能正确 upsert 同一 task 的关键。
            const toolUseId =
              (typeof part.callID === 'string' ? part.callID : undefined) ??
              (typeof part.id === 'string' ? part.id : undefined)

            // --- Mission Control: detect todo/task tools ---
            const nextTasks = applySessionTaskToolEvent(
              missionTasksRef.current,
              toolName,
              state.input,
              toolUseId
            )
            if (nextTasks !== missionTasksRef.current) {
              setSharedMissionTasks(nextTasks)
            }
          }
        }

        // Lifecycle events
        if (event.type === 'session.status') {
          const statusType = event.data?.status?.type
          if (statusType === 'idle') {
            void refreshUsageSummary()
            // Mark the tab badge / sidebar as completed. useAgentEventBridge
            // intentionally skips active sessions on idle (its comment says
            // "lifecycle is handled by SessionView (until Phase 3)") — but the
            // session-hq UI never picked that up, so without this the tab
            // spinner stays spinning forever after the run finishes.
            const pendingPlan = useSessionStore.getState().getPendingPlan(sessionId)
            const currentBadge = useWorktreeStatusStore.getState().sessionStatuses[sessionId]
            const skipBadge =
              !!pendingPlan ||
              currentBadge?.status === 'plan_ready' ||
              currentBadge?.status === 'command_approval' ||
              currentBadge?.status === 'answering' ||
              currentBadge?.status === 'permission'
            if (!skipBadge) {
              const sendTime = messageSendTimes.get(sessionId)
              const durationMs = sendTime ? Date.now() - sendTime : 0
              useWorktreeStatusStore
                .getState()
                .setSessionStatus(sessionId, 'completed', { durationMs })
            }
            // Refresh timeline to pick up newly committed messages
            void refresh()
              .then((msgs) => {
                // Sync mission tasks from committed timeline using the same reducer semantics
                if (msgs.length > 0) {
                  const extracted = extractMissionTasks(msgs)
                  setSharedMissionTasks(extracted)
                } else {
                  setSharedMissionTasks([])
                }
              })
              .finally(() => {
                optimisticRef.current = []
                // NOTE: do NOT clearStreamingBufferOverlay here. By the time
                // we reach this finally, the runtime mirror's idle handler
                // already set isStreaming=false (so streamingNodes stop
                // rendering). Wiping `parts` would destroy content the user
                // might switch back to read, and the next user message will
                // call resetLiveOverlay(true) before any new stream lands.
              })

            // Auto-drain pending message queue
            void drainQueuedMessage()
          }
        }

        // Token / cost tracking (active session — global bridge skips the active one)
        if (event.type === 'message.updated') {
          const info = (event.data as Record<string, unknown>)?.info as
            | Record<string, unknown>
            | undefined
          if ((info?.time as Record<string, unknown>)?.completed) {
            const data = event.data as Record<string, unknown> | undefined
            if (data) {
              const tokens = extractTokens(data)
              if (tokens) {
                const modelRef = extractModelRef(data, currentProviderId) ?? undefined
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
        }

        // Context usage (Codex-style direct context reporting)
        if (event.type === 'session.context_usage') {
          applySessionContextUsage(sessionId, event.data)
        }

        if (event.type === 'session.materialized') {
          const newId = event.data?.newSessionId as string | undefined
          if (newId) setDroidSessionId(newId)
          void refreshUsageSummary()
        }

        // Handle session.updated — sync auto-generated title from SDK
        if (event.type === 'session.updated') {
          const data = event.data as Record<string, unknown> | undefined
          const info = data?.info as Record<string, unknown> | undefined
          const sessionTitle = info?.title || data?.title
          const isOpenCodeDefault = /^New session\s*-?\s*\d{4}-\d{2}-\d{2}/i.test(
            (sessionTitle as string) || ''
          )
          if (sessionTitle && !isOpenCodeDefault) {
            useSessionStore.getState().updateSessionName(sessionId, sessionTitle as string)
          }
          return
        }

        // Re-fetch slash commands when SDK reports them available
        if (event.type === 'session.commands_available') {
          setCommandsVersion((v) => v + 1)
        }
      })

    return unsubscribe
  }, [
    sessionId,
    refresh,
    worktreePath,
    droidSessionId,
    optimisticRef,
    currentProviderId,
    drainQueuedMessage,
    refreshUsageSummary,
    setSharedMissionTasks
  ])

  // --- Composer action handler ---
  const handleComposerAction = useCallback(
    async (
      action: ComposerAction,
      content: string,
      attachments: Attachment[]
    ): Promise<boolean> => {
      if (!worktreePath || !droidSessionId) return false
      let optimisticMessageId: string | null = null
      const shouldClearGoalComposer =
        supportsSessionGoalMode && goalMode && (action === 'send' || action === 'stop_and_send')
      const previousGoalMode = goalMode
      const previousSuccessCriteria = successCriteria

      // Pure stop (no content) requests provider interruption only. Do not
      // force lifecycle idle or clear the live overlay here: Codex may keep
      // streaming until it confirms interruption/completion, and hiding that
      // stream makes a still-running thread look stopped.
      if (action === 'stop_and_send' && !content.trim()) {
        try {
          const result = (await window.agentOps.abort(worktreePath, droidSessionId)) as {
            success: boolean
            aborted?: boolean
            error?: string
          }
          if (!result.success || result.aborted === false) {
            toast.error(result.error ?? 'Failed to stop active turn')
          }
        } catch (err) {
          console.error('[SessionShell] abort failed:', err)
          toast.error(err instanceof Error ? err.message : 'Failed to stop active turn')
        }
        return false
      }

      const diffCommentContext = buildLocalDiffCommentContext(
        useDiffCommentStore.getState().attachedComments
      )
      const contentToSend = diffCommentContext + content

      if (action === 'send' || action === 'stop_and_send') {
        resetLiveOverlay(true)
      }

      if (
        action === 'send' ||
        action === 'stop_and_send' ||
        action === 'steer' ||
        action === 'queue'
      ) {
        // Lock provider/model selectors immediately. Main process also stamps
        // first_message_at via createSessionMessage / upsertSessionActivity,
        // but the UI shouldn't wait for the round-trip.
        useSessionStore.getState().markSessionFirstMessage(sessionId)
      }

      if (shouldClearGoalComposer) {
        setGoalMode(false)
        setSuccessCriteria('')
      }

      // Optimistic insert — show user message immediately in the timeline
      if (
        (contentToSend.trim() || attachments.length > 0) &&
        (action === 'send' ||
          action === 'stop_and_send' ||
          action === 'steer' ||
          action === 'queue')
      ) {
        const optimisticAttachments = attachmentsToMessageParts(attachments)
        const optimisticMsg: TimelineMessage = {
          id: `${action === 'queue' ? 'queued' : 'optimistic'}-${Date.now()}`,
          role: 'user',
          content: contentToSend.trim(),
          timestamp: new Date().toISOString(),
          ...(action === 'queue' ? { deliveryStatus: 'queued' as const } : {}),
          ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {})
        }
        optimisticMessageId = optimisticMsg.id
        appendOptimistic(optimisticMsg)
        requestTurnTopScroll(optimisticMsg.id)
        // Sync ref immediately so streaming callbacks can find the user message
        // before the next useEffect tick.
        timelineMessagesRef.current = [...timelineMessagesRef.current, optimisticMsg]
        syncOptimisticMessagesToMirror()
      }

      try {
        const consumed = await executeSendAction(action, contentToSend, attachments, {
          worktreePath,
          sessionId: droidSessionId,
          queueSessionId: sessionId,
          runtimeId: agentSdk ?? undefined,
          model: requestModel,
          promptOptions,
          prompt: async (wp, sid, c) => {
            let messageParts: MessagePart[] | undefined
            if (attachments.length > 0) {
              messageParts = await buildMessageParts(attachments, c)
            }
            return window.agentOps.prompt(wp, sid, messageParts ?? c, requestModel, promptOptions)
          },
          steer: (wp, sid, c) => window.agentOps.steer(wp, sid, c, requestModel),
          abort: (wp, sid) => window.agentOps.abort(wp, sid),
          waitForAbortReady: () => waitForSessionIdleAfterAbort(sessionId),
          queueMessage: (sid, msg) => useSessionRuntimeStore.getState().queueMessage(sid, msg)
        })

        if (!consumed && (action === 'send' || action === 'stop_and_send')) {
          resetLiveOverlay(false)
        }
        if (consumed) {
          void refreshSessionLastMessageAt(sessionId)
          useDiffCommentStore.getState().clearAttachments()
        }
        if (!consumed && shouldClearGoalComposer) {
          setGoalMode(previousGoalMode)
          setSuccessCriteria(previousSuccessCriteria)
        }

        return consumed
      } catch (err) {
        console.error('[SessionShell] action failed:', err)
        if (optimisticMessageId) {
          optimisticRef.current = optimisticRef.current.filter(
            (msg) => msg.id !== optimisticMessageId
          )
          timelineMessagesRef.current = timelineMessagesRef.current.filter(
            (msg) => msg.id !== optimisticMessageId
          )
          setMessages((prev) => prev.filter((msg) => msg.id !== optimisticMessageId))
          syncOptimisticMessagesToMirror()
        }
        if (shouldClearGoalComposer) {
          setGoalMode(previousGoalMode)
          setSuccessCriteria(previousSuccessCriteria)
        }
        toast.error(err instanceof Error ? err.message : 'Failed to send message')
        if (action === 'send' || action === 'stop_and_send') {
          resetLiveOverlay(false)
        }
        return false
      }
    },
    [
      worktreePath,
      droidSessionId,
      sessionId,
      appendOptimistic,
      requestTurnTopScroll,
      optimisticRef,
      goalMode,
      successCriteria,
      supportsSessionGoalMode,
      requestModel,
      promptOptions,
      agentSdk,
      resetLiveOverlay,
      setMessages,
      syncOptimisticMessagesToMirror
    ]
  )

  const canEditUserMessage = useCallback(
    (message: TimelineMessage) =>
      message.role === 'user' &&
      message.id === latestUserMessageId &&
      !isStreaming &&
      lifecycle !== 'busy' &&
      lifecycle !== 'materializing',
    [latestUserMessageId, isStreaming, lifecycle]
  )

  const handleEditUserMessage = useCallback((message: TimelineMessage) => {
    setEditingMessageId(message.id)
    setEditingContent(getMessageDisplayContent(message.content))
  }, [])

  const handleCancelUserMessageEdit = useCallback(() => {
    setEditingMessageId(null)
    setEditingContent('')
  }, [])

  const handleSaveUserMessageEdit = useCallback(
    async (messageId: string) => {
      const trimmedContent = editingContent.trim()
      if (!trimmedContent || !worktreePath || !droidSessionId) return

      const messageIndex = timelineMessages.findIndex((message) => message.id === messageId)
      if (messageIndex === -1) return

      const originalMessage = timelineMessages[messageIndex]
      const contentToSend = restoreMessageModePrefix(originalMessage.content, trimmedContent)
      const trimmedMessages = timelineMessages.slice(0, messageIndex)

      setMessages(trimmedMessages)
      timelineMessagesRef.current = trimmedMessages
      optimisticRef.current = optimisticRef.current.filter((message) =>
        trimmedMessages.some((candidate) => candidate.id === message.id)
      )
      syncOptimisticMessagesToMirror()
      setEditingMessageId(null)
      setEditingContent('')

      resetLiveOverlay(true)

      const optimisticMsg: TimelineMessage = {
        id: `optimistic-${Date.now()}`,
        role: 'user',
        content: trimmedContent,
        timestamp: new Date().toISOString()
      }
      appendOptimistic(optimisticMsg)
      requestTurnTopScroll(optimisticMsg.id)
      timelineMessagesRef.current = [...trimmedMessages, optimisticMsg]
      syncOptimisticMessagesToMirror()

      try {
        const consumed = await executeSendAction('send', contentToSend, [], {
          worktreePath,
          sessionId: droidSessionId,
          queueSessionId: sessionId,
          runtimeId: agentSdk ?? undefined,
          model: requestModel,
          promptOptions,
          prompt: (wp, sid, content) =>
            window.agentOps.prompt(wp, sid, content, requestModel, promptOptions),
          abort: (wp, sid) => window.agentOps.abort(wp, sid),
          queueMessage: (sid, msg) => useSessionRuntimeStore.getState().queueMessage(sid, msg)
        })

        if (!consumed) {
          resetLiveOverlay(false)
        }
      } catch (error) {
        console.error('[SessionShell] edit resend failed:', error)
        toast.error(t('sessionView.toasts.messageError'))
        resetLiveOverlay(false)
      }
    },
    [
      editingContent,
      worktreePath,
      droidSessionId,
      sessionId,
      timelineMessages,
      setMessages,
      appendOptimistic,
      requestTurnTopScroll,
      requestModel,
      promptOptions,
      agentSdk,
      resetLiveOverlay,
      syncOptimisticMessagesToMirror,
      t,
      optimisticRef
    ]
  )

  const performForkFromUserMessage = useCallback(
    async (messageId: string) => {
      if (forkingMessageId || !worktreePath || !droidSessionId) {
        toast.error(t('sessionView.toasts.forkNotReady'))
        return
      }

      const sourceSession = sessionRecord ?? (await window.db.session.get(sessionId))
      if (!sourceSession) {
        toast.error(t('sessionView.toasts.forkNotReady'))
        return
      }

      const targetWorktreeId = worktreeId ?? sourceSession.worktree_id
      if (!targetWorktreeId) {
        toast.error(t('sessionView.toasts.forkNoWorktree'))
        return
      }

      const message = timelineMessages.find((candidate) => candidate.id === messageId)
      if (!message) {
        toast.error(t('sessionView.toasts.forkMessageNotFound'))
        return
      }

      const cutoffMessageId = getUserMessageForkCutoff(timelineMessages, messageId)
      setForkingMessageId(messageId)

      try {
        const forkResult = await window.agentOps.fork(worktreePath, droidSessionId, cutoffMessageId)
        if (!forkResult.success || !forkResult.sessionId) {
          throw new Error(forkResult.error || t('sessionView.toasts.forkFailed'))
        }

        const fallbackForkName = sourceSession.name ? `${sourceSession.name} (fork)` : null
        const forkedSession = await window.db.session.create({
          worktree_id: targetWorktreeId,
          project_id: sourceSession.project_id,
          name: fallbackForkName,
          opencode_session_id: forkResult.sessionId,
          model_provider_id: sourceSession.model_provider_id,
          model_id: sourceSession.model_id,
          model_variant: sourceSession.model_variant
        })

        await useSessionStore.getState().loadSessions(targetWorktreeId, sourceSession.project_id)
        useSessionStore.getState().setActiveSession(forkedSession.id)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('sessionView.toasts.forkFailed'))
      } finally {
        setForkingMessageId(null)
        setPendingForkMessageId(null)
      }
    },
    [
      droidSessionId,
      forkingMessageId,
      sessionId,
      sessionRecord,
      timelineMessages,
      t,
      worktreeId,
      worktreePath
    ]
  )

  const handleForkUserMessage = useCallback(
    async (message: TimelineMessage) => {
      if (skipForkFromMessageConfirm) {
        await performForkFromUserMessage(message.id)
        return
      }

      setForkConfirmDismissChecked(false)
      setPendingForkMessageId(message.id)
    },
    [performForkFromUserMessage, skipForkFromMessageConfirm]
  )

  const handleConfirmForkFromMessage = useCallback(async () => {
    if (!pendingForkMessageId) return

    if (forkConfirmDismissChecked) {
      await useSettingsStore.getState().updateSetting('skipForkFromMessageConfirm', true)
    }

    await performForkFromUserMessage(pendingForkMessageId)
  }, [forkConfirmDismissChecked, pendingForkMessageId, performForkFromUserMessage])

  // --- Plan implement/handoff handlers ---
  const handlePlanImplement = useCallback(async () => {
    if (!worktreePath || !droidSessionId || !pendingPlan) return

    const pendingBeforeAction = pendingPlan
    const isClaudeCode = agentSdk === 'claude-code'

    useSessionStore.getState().clearPendingPlan(sessionId)
    useSessionRuntimeStore.getState().removeInterrupt(sessionId, pendingBeforeAction.requestId)
    useWorktreeStatusStore.getState().clearSessionStatus(sessionId)

    try {
      if (isClaudeCode) {
        const result = await window.agentOps.planApprove(
          worktreePath,
          sessionId,
          pendingBeforeAction.requestId
        )
        if (!result.success) {
          toast.error(`Plan approve failed: ${result.error ?? 'Unknown error'}`)
          if (!(result.error ?? '').toLowerCase().includes('no pending plan')) {
            useSessionStore.getState().setPendingPlan(sessionId, pendingBeforeAction)
            useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'plan_ready')
          }
          return
        }
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
        // turn is started). The plan-phase thinking / tool_use cards have been
        // pushed to session.messages in main but NOT persisted to DB yet —
        // `persistMessagesToDB` only runs in the outer prompt `finally`. If we
        // cleared the streaming overlay here, those cards would disappear from
        // the UI until the full prompt loop finishes and a refresh pulls them
        // back. Keep the overlay so the user sees continuous progress.
        useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
        return
      }

      resetLiveOverlay(true)

      const optimisticMsg: TimelineMessage = {
        id: `optimistic-${Date.now()}`,
        role: 'user',
        content: implementPrompt,
        timestamp: new Date().toISOString()
      }
      appendOptimistic(optimisticMsg)
      requestTurnTopScroll(optimisticMsg.id)
      timelineMessagesRef.current = [...timelineMessagesRef.current, optimisticMsg]
      syncOptimisticMessagesToMirror()

      await executeSendAction('send', implementPrompt, [], {
        worktreePath,
        sessionId: droidSessionId,
        queueSessionId: sessionId,
        runtimeId: agentSdk ?? undefined,
        model: requestModel,
        promptOptions,
        prompt: (wp, sid, c) => window.agentOps.prompt(wp, sid, c, requestModel, promptOptions),
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
    droidSessionId,
    pendingPlan,
    agentSdk,
    sessionId,
    appendOptimistic,
    requestTurnTopScroll,
    resetLiveOverlay,
    syncOptimisticMessagesToMirror,
    transitionToolStatus,
    requestModel,
    promptOptions
  ])

  const handlePlanHandoff = useCallback(async () => {
    if (!pendingPlan) return

    const planContent = pendingPlan.planContent.trim()
    if (!planContent) {
      toast.error(t('sessionView.toasts.noAssistantPlanToHandoff'))
      return
    }

    const sourceAgentSdk = sessionRecord?.agent_sdk
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
        const currentWorktreeId = worktreeId
        const currentProjectId = sessionRecord?.project_id
        if (!currentWorktreeId || !currentProjectId) {
          toast.error(t('sessionView.toasts.startHandoffSessionError'))
          return
        }

        result = await sessionStore.createSession(
          currentWorktreeId,
          currentProjectId,
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
    sessionRecord?.agent_sdk,
    sessionRecord?.project_id,
    goalMode,
    successCriteria,
    connectionId,
    worktreeId,
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
    // PlanCard shows "Rejected" instead of falling through to "Approved"
    // (mirror of handlePlanImplement's transitionToolStatus('success') call).
    if (pendingBeforeAction.toolUseID) {
      transitionToolStatus(pendingBeforeAction.toolUseID, 'rejected')
    }

    if (!worktreePath) return

    // Always call the reject IPC — for claude-code it unblocks the SDK; for
    // codex it's a no-op on the runtime side but persists a `plan.resolved`
    // activity in SQLite, which is what flips the durable plan card from
    // "Requires Approval" → resolved on next read.
    try {
      await window.agentOps.planReject(
        worktreePath,
        sessionId,
        'Plan rejected by user',
        pendingBeforeAction.requestId
      )
      // Re-pull the durable timeline so the persisted `plan.resolved`
      // activity takes effect — without this, the plan card stays in its
      // "Requires Approval" state until the user reloads the session
      // (because timeline-mappers only sees the existing plan.ready
      // activity in cached results).
      await refresh()
    } catch (err) {
      const isClaudeCode = sessionRecord?.agent_sdk === 'claude-code'
      if (isClaudeCode) {
        // Claude reject failure means the SDK is still waiting. Restore so
        // the user can retry; surfaced via toast.
        toast.error(`Plan reject failed: ${err instanceof Error ? err.message : String(err)}`)
        useSessionStore.getState().setPendingPlan(sessionId, pendingBeforeAction)
        useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'plan_ready')
      } else {
        // Codex reject is best-effort persistence — log and continue. The
        // local UI is already cleared.
        console.warn('[SessionShell] codex plan reject persistence failed:', err)
      }
    }
  }, [
    pendingPlan,
    sessionRecord?.agent_sdk,
    sessionId,
    worktreePath,
    refresh,
    transitionToolStatus
  ])

  const handleRoundAnchorNavigate = useCallback(
    (roundId: string) => {
      setActiveRoundId(roundId)
      const container = timelineScrollContainerRef.current
      if (!container) return
      const section = findRoundSection(container, roundId)
      if (!section) return

      const targetTop = Math.max(getContainerRelativeTop(container, section) - 24, 0)
      scrollTimelineToOffset(targetTop, 'smooth')
    },
    [scrollTimelineToOffset, timelineScrollContainerRef]
  )

  useEffect(() => {
    if (isStreaming) {
      const lastUserMessage = [...timelineMessages]
        .reverse()
        .find((message) => message.role === 'user')
      if (lastUserMessage) {
        setActiveRoundId(lastUserMessage.id)
      }
    }
  }, [isStreaming, timelineMessages])

  // --- Loading state ---
  if (loading && timelineMessages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!sessionRecord) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Session not found
      </div>
    )
  }

  const currentInterrupt = interruptQueue[0] ?? null
  // Plan interrupts are handled by PlanReadyImplementFab, not the composer/dock.
  // Filter them out so the composer doesn't enter reply_interrupt mode for plans.
  const composerInterrupt = currentInterrupt?.type === 'plan' ? null : currentInterrupt
  const composerVeilHeight = Math.min(Math.max(smartScroll.bottomFloatingHeight + 24, 72), 128)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Main content area — hard-row layout keeps transcript output inside the scroll region. */}
      <div className="relative grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
        <div
          className="row-start-1 row-end-2 min-h-0 overflow-hidden"
          data-testid="session-transcript-region"
        >
          <AgentTimeline
            timelineMessages={timelineMessages}
            streamingContent={streamingContent}
            streamingParts={streamingParts}
            isStreaming={isStreaming}
            activeRunStartedAt={runStartedAt}
            lifecycle={lifecycle}
            ephemeralStatusRows={ephemeralStatusRows}
            inflightCompaction={inflightCompactionRow}
            suppressTodoCards
            sessionId={sessionId}
            worktreePath={worktreePath}
            childPartsMap={childPartsMap}
            planContentByToolUseId={planContentByToolUseId}
            canEditUserMessage={canEditUserMessage}
            editingMessageId={editingMessageId}
            editingContent={editingContent}
            onEditingContentChange={setEditingContent}
            onSaveUserMessageEdit={handleSaveUserMessageEdit}
            onCancelUserMessageEdit={handleCancelUserMessageEdit}
            onEditUserMessage={handleEditUserMessage}
            onForkUserMessage={handleForkUserMessage}
            onCopyUserMessage={() => {}}
            forkingMessageId={forkingMessageId}
            scrollContainerRef={smartScroll.scrollContainerRef}
            contentHeightRef={timelineContentRef}
            onScroll={smartScroll.handleScroll}
            onWheel={smartScroll.handleScrollWheel}
            onPointerDown={smartScroll.handleScrollPointerDown}
            onPointerUp={smartScroll.handleScrollPointerUp}
            onPointerCancel={smartScroll.handleScrollPointerCancel}
            bottomFloatingHeight={smartScroll.bottomFloatingHeight}
            clearScreenBottomInset={clearScreenBottomInset}
            activeRoundId={activeRoundId}
            onActiveRoundChange={setActiveRoundId}
            onRoundAnchorNavigate={handleRoundAnchorNavigate}
            showScrollIndicator={smartScroll.showScrollFab}
            onScrollIndicatorClick={smartScroll.handleScrollToBottomClick}
          />
        </div>

        <ScrollToBottomFab
          onClick={smartScroll.handleScrollToBottomClick}
          visible={smartScroll.showScrollFab}
          count={smartScroll.scrollFabCount}
          style={{ bottom: `${scrollFabBottomOffset}px` }}
        />

        <PlanReadyImplementFab
          onImplement={handlePlanImplement}
          onHandoff={handlePlanHandoff}
          onReject={handlePlanReject}
          visible={!!pendingPlan}
          superpowersAvailable={false}
        />

        <div
          className="row-start-2 row-end-3 min-h-0 overflow-visible"
          data-testid="session-bottom-stack"
        >
          <div ref={timelineBottomAreaRef} className="min-h-0">
            <InterruptDock
              sessionId={sessionId}
              interrupt={currentInterrupt}
              worktreePath={worktreePath}
            />
            {agentSdk === 'xuanpu-agent' && (
              <ContextBudgetDebugger
                sessionId={sessionId}
                runtimeSessionId={droidSessionId}
                worktreeId={worktreeId}
                className="mt-2 rounded-lg border border-border/45 bg-background/92 shadow-lg backdrop-blur"
              />
            )}
          </div>

          <div className="relative z-20 min-h-0 pb-4 pt-2" data-testid="session-composer-dock">
            <div
              className="crisp-composer-veil pointer-events-none absolute inset-x-0 bottom-0 z-0"
              style={{ height: `${composerVeilHeight}px` }}
            />

            <ComposerBar
              containerRef={composerBarRef}
              sessionId={sessionId}
              lifecycle={lifecycle}
              pendingCount={pendingCount}
              firstInterrupt={composerInterrupt}
              onAction={handleComposerAction}
              isConnected={!!droidSessionId && !!worktreePath}
              supportsSteer={supportsSteer}
              preferSteerWhenBusy={preferSteerWhenBusy}
              mode={mode}
              onToggleMode={toggleMode}
              pendingPlan={pendingPlan}
              supportsGoalMode={supportsSessionGoalMode}
              goalMode={goalMode}
              onToggleGoalMode={toggleGoalMode}
              successCriteria={successCriteria}
              onSuccessCriteriaChange={setSuccessCriteria}
              worktreePath={worktreePath}
              commandsVersion={commandsVersion}
              contextAttachmentSlot={<DiffCommentAttachments />}
              controlSlot={<MemoryPanel worktreeId={worktreeId} variant="composer" />}
            />
          </div>
        </div>

        {process.env.NODE_ENV === 'development' && (
          <div className="absolute right-3 top-3 z-30 w-[min(720px,calc(100%-1.5rem))] rounded-lg border border-border/45 bg-background/92 shadow-lg backdrop-blur">
            {/* Phase 22A debug: collapsible view of the last Field Context injection.
                Production users inspect memory through the Composer console. */}
            <FieldContextDebug
              sessionId={droidSessionId}
              fallbackSessionIds={[sessionId]}
              worktreeId={worktreeId}
            />
          </div>
        )}

        <ForkFromMessageConfirmDialog
          open={pendingForkMessageId !== null}
          dontShowAgain={forkConfirmDismissChecked}
          onDontShowAgainChange={setForkConfirmDismissChecked}
          onCancel={() => {
            setPendingForkMessageId(null)
            setForkConfirmDismissChecked(false)
          }}
          onConfirm={() => {
            void handleConfirmForkFromMessage()
          }}
        />
      </div>
    </div>
  )
}
