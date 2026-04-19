/**
 * SessionShell — Phase 6 (Timeline UI)
 *
 * Composition root for the new session UI. Wires together hooks and
 * passes data to child components:
 *
 *   SessionHeader    — provider badge, model, lifecycle, tokens
 *   MissionControl   — current task display + progress bar (inside scroll)
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
  useState,
  useCallback,
  useRef,
  useMemo,
  useSyncExternalStore
} from 'react'
import { SessionHeader } from './SessionHeader'
import { AgentTimeline } from './AgentTimeline'
import type { ThreadStatusRowData } from './ThreadStatusRow'
import { MissionControl, type MissionTask } from './MissionControl'
import { InterruptDock } from './InterruptDock'
import { ComposerBar } from './ComposerBar'
import { ForkFromMessageConfirmDialog } from './ForkFromMessageConfirmDialog'
import { PlanReadyImplementFab } from '../sessions/PlanReadyImplementFab'
import { useSessionRuntimeStore } from '@/stores/useSessionRuntimeStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores'
import { useContextStore } from '@/stores/useContextStore'
import { useWorktreeStatusStore } from '@/stores/useWorktreeStatusStore'
import { useSettingsStore, resolveModelForSdk } from '@/stores/useSettingsStore'
import { Loader2 } from 'lucide-react'
import type { TimelineMessage } from '@shared/lib/timeline-types'
import type { Attachment } from '../sessions/AttachmentPreview'
import type { MessagePart } from '@shared/types/opencode'
import { buildMessageParts } from '@/lib/file-attachment-utils'
import type { CanonicalAgentEvent } from '@shared/types/agent-protocol'
import type { StreamingPart as SharedStreamingPart } from '@shared/lib/timeline-types'
import {
  getStreamingBuffer,
  getStreamingBufferSnapshot,
  subscribeToStreamingBuffer,
  updateStreamingBuffer,
  clearStreamingBufferOverlay
} from '@/stores/useSessionRuntimeStore'
import {
  executeSendAction,
  drainNextPending,
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
import { lastSendMode } from '@/lib/message-send-times'
import {
  getMessageDisplayContent,
  getUserMessageForkCutoff,
  restoreMessageModePrefix
} from '@/lib/message-actions'
import { useI18n } from '@/i18n/useI18n'
import { toast } from 'sonner'
import { isTodoWriteTool } from '@/components/sessions/tools/todo-utils'

// ---------------------------------------------------------------------------
// Extract mission tasks from committed timeline messages
// ---------------------------------------------------------------------------

function extractMissionTasks(messages: TimelineMessage[]): MissionTask[] {
  // Scan from end to find the latest todo-like tool snapshot
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue

    for (const part of msg.parts ?? []) {
      if (part.type !== 'tool_use' || !part.toolUse) continue
      const toolName = part.toolUse.name?.toLowerCase() ?? ''
      if (!isTodoWriteTool(toolName)) continue

      const todos = part.toolUse.input?.todos
      if (!Array.isArray(todos)) continue

      return todos.map((t: Record<string, unknown>, idx: number) => ({
        id: String(t.id ?? `todo-${idx}`),
        content: String(t.content ?? t.subject ?? t.activeForm ?? ''),
        status: (t.status as MissionTask['status']) ?? 'pending'
      }))
    }
  }

  return []
}

// ---------------------------------------------------------------------------
// useTimeline hook — fetches durable timeline from main process
// ---------------------------------------------------------------------------

function useTimeline(sessionId: string) {
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
      // Restore cached attachments onto refreshed messages
      const cache = attachmentCacheRef.current
      const restored =
        cache.size > 0
          ? result.messages.map((msg) => {
              if (msg.role === 'user' && !msg.attachments) {
                const stored = cache.get(msg.content.trim())
                if (stored) return { ...msg, attachments: stored }
              }
              return msg
            })
          : result.messages

      // Merge back optimistic messages not yet present in DB results.
      // Match by content — once the DB contains a user message with the same
      // trimmed text, the optimistic copy is no longer needed.
      const dbContents = new Set(
        restored.filter((m) => m.role === 'user').map((m) => m.content.trim())
      )
      const stillPending = optimisticRef.current.filter((om) => !dbContents.has(om.content.trim()))
      optimisticRef.current = stillPending
      const merged = stillPending.length > 0 ? [...restored, ...stillPending] : restored
      setMessages(merged)
      return merged
    } catch (err) {
      console.warn('[SessionShell] getTimeline failed:', err)
      return []
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    setLoading(true)
    // Don't clear messages here — refresh() overwrites them once IPC returns.
    // Clearing early causes a flash-of-empty and loses optimistic messages
    // when SessionShell remounts (e.g. tab switch).
    attachmentCacheRef.current.clear()
    refresh()
  }, [sessionId, refresh])

  // Optimistic insert — append a local user message before the server confirms
  const appendOptimistic = useCallback((msg: TimelineMessage) => {
    // Cache attachments keyed by normalised content for restoreUserAttachments
    if (msg.attachments && msg.attachments.length > 0 && msg.content.trim()) {
      attachmentCacheRef.current.set(msg.content.trim(), msg.attachments)
    }
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

// ---------------------------------------------------------------------------
// SessionShell
// ---------------------------------------------------------------------------

export interface SessionShellProps {
  sessionId: string
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

  const {
    messages: timelineMessages,
    setMessages,
    loading,
    refresh,
    appendOptimistic,
    optimisticRef
  } = useTimeline(sessionId)
  const { lifecycle, interruptQueue, pendingCount } = useSessionRuntime(sessionId)

  // --- Connect or reconnect to agent runtime on mount ---
  const opcSessionId = sessionRecord?.opencode_session_id ?? null
  const agentSdk = sessionRecord?.agent_sdk ?? null

  // --- Plan mode ---
  const mode = useSessionStore((s) => s.modeBySession?.get(sessionId) ?? 'build')
  const pendingPlan = useSessionStore((s) => s.pendingPlans?.get(sessionId) ?? null)
  const toggleMode = useCallback(() => {
    useSessionStore.getState().toggleSessionMode(sessionId)
  }, [sessionId])

  // --- Cost / tokens ---
  const sessionCost = useContextStore((s) => s.costBySession?.[sessionId] ?? 0)
  const rawTokens = useContextStore((s) => s.tokensBySession?.[sessionId] ?? null)
  const sessionTokens = useMemo(() => {
    if (!rawTokens) return null
    return {
      input: rawTokens.input ?? 0,
      output: rawTokens.output ?? 0,
      cacheRead: rawTokens.cacheRead ?? 0,
      cacheWrite: rawTokens.cacheWrite ?? 0
    }
  }, [rawTokens])

  // --- Persisted usage summary (survives restart) ---
  const [usageSummary, setUsageSummary] = useState<
    import('@shared/types/usage-analytics').UsageAnalyticsSessionSummary | null
  >(null)
  const refreshUsageSummary = useCallback(async (): Promise<void> => {
    if (!window.usageAnalyticsOps?.fetchSessionSummary) return

    try {
      const result = await window.usageAnalyticsOps.fetchSessionSummary(sessionId)
      if (!result.success || !result.data) return

      const data = result.data
      setUsageSummary(data)

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
  const currentModelId = resolvedModel?.modelID ?? ''
  const currentProviderId = resolvedModel?.providerID ?? ''
  const skipForkFromMessageConfirm = useSettingsStore((s) => s.skipForkFromMessageConfirm)

  // --- Live streaming mirror (module-level runtime truth) ---
  const streamingMirror = useStreamingMirror(sessionId)
  const streamingContent = streamingMirror.streamingContent
  const isStreaming = streamingMirror.isStreaming
  const runStartedAt = streamingMirror.runStartedAt ?? null
  const compactionState = streamingMirror.compactionState ?? null
  const streamingParts = streamingMirror.parts
  const childPartsMap = streamingMirror.childParts
  const [droidSessionId, setDroidSessionId] = useState<string | null>(
    sessionRecord?.opencode_session_id ?? null
  )

  // Incremented when session.commands_available fires — triggers ComposerBar re-fetch
  const [commandsVersion, setCommandsVersion] = useState(0)
  const [supportsSteer, setSupportsSteer] = useState(agentSdk === 'codex')
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState('')
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null)
  const [pendingForkMessageId, setPendingForkMessageId] = useState<string | null>(null)
  const [forkConfirmDismissChecked, setForkConfirmDismissChecked] = useState(false)

  const syncOptimisticMessagesToMirror = useCallback(() => {
    updateStreamingBuffer(
      sessionId,
      (current) => ({
        ...current,
        optimisticMessages: optimisticRef.current.length > 0 ? [...optimisticRef.current] : undefined
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

  // --- Mission Control task state ---
  const [missionTasks, setMissionTasks] = useState<MissionTask[]>([])
  const [triggerMessageContent, setTriggerMessageContent] = useState<string | null>(null)
  const [missionVisible, setMissionVisible] = useState(false)
  const missionTasksRef = useRef<MissionTask[]>([])
  const missionVisibleRef = useRef(false)
  const timelineMessagesRef = useRef<TimelineMessage[]>([])

  // Keep refs in sync
  useEffect(() => {
    missionVisibleRef.current = missionVisible
  }, [missionVisible])
  useEffect(() => {
    timelineMessagesRef.current = timelineMessages
  }, [timelineMessages])

  const allTasksComplete = useMemo(
    () => missionTasks.length > 0 && missionTasks.every((t) => t.status === 'completed'),
    [missionTasks]
  )

  const lastUserMessageId = useMemo(() => {
    for (let i = timelineMessages.length - 1; i >= 0; i--) {
      if (timelineMessages[i].role === 'user') return timelineMessages[i].id
    }
    return null
  }, [timelineMessages])

  const hasDurableCompactionMessage = useMemo(
    () =>
      timelineMessages.some((message) =>
        (message.parts ?? []).some((part) => part.type === 'compaction')
      ),
    [timelineMessages]
  )

  const ephemeralStatusRows = useMemo<ThreadStatusRowData[]>(() => {
    const rows: ThreadStatusRowData[] = []

    if (
      compactionState &&
      !(compactionState.phase === 'completed' && hasDurableCompactionMessage)
    ) {
      rows.push({
        id: `compaction-${sessionId}`,
        kind: compactionState.phase === 'running' ? 'compacting' : 'compacted',
        timestamp: compactionState.timestamp,
        ephemeral: true
      })
    }

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
  }, [compactionState, hasDurableCompactionMessage, lifecycle, runStartedAt, sessionId])

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

  // Auto-hide MissionControl after all tasks complete
  useEffect(() => {
    if (allTasksComplete && missionVisible) {
      const timer = setTimeout(() => {
        setMissionVisible(false)
        setTriggerMessageContent(null)
      }, 2000)
      return () => clearTimeout(timer)
    }
  }, [allTasksComplete, missionVisible])

  // Failsafe: hide MissionControl when streaming stops and all tasks are done.
  // The primary timer above can be disrupted by rapid state updates; this
  // guarantees the panel disappears once the session goes idle.
  useEffect(() => {
    if (allTasksComplete && !isStreaming && missionVisible) {
      const failsafe = setTimeout(() => {
        setMissionVisible(false)
        setTriggerMessageContent(null)
      }, 4000)
      return () => clearTimeout(failsafe)
    }
  }, [allTasksComplete, isStreaming, missionVisible])

  const transitionToolStatus = useCallback(
    (toolUseID: string, status: 'success' | 'error', error?: string) => {
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
          console.log('[SessionShell] reconnecting', { sessionId, opcSessionId, worktreePath })
          const result = await window.agentOps.reconnect(worktreePath, opcSessionId, sessionId)
          console.log('[SessionShell] reconnect result', result)
          if (!cancelled && result.success) {
            setDroidSessionId(opcSessionId)
          }
        } else {
          console.log('[SessionShell] connecting (new)', { sessionId, worktreePath })
          const result = await window.agentOps.connect(worktreePath, sessionId)
          console.log('[SessionShell] connect result', result)
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

            // --- Mission Control: detect todo/task tools ---
            const lowerToolName = toolName?.toLowerCase() ?? ''
            if (isTodoWriteTool(lowerToolName)) {
              const todos = (state.input as Record<string, unknown>)?.todos
              if (Array.isArray(todos)) {
                const newTasks: MissionTask[] = todos.map(
                  (t: Record<string, unknown>, idx: number) => ({
                    id: String(t.id ?? `todo-${idx}`),
                    content: String(t.content ?? t.subject ?? t.activeForm ?? ''),
                    status: (t.status as MissionTask['status']) ?? 'pending'
                  })
                )
                missionTasksRef.current = newTasks
                setMissionTasks(newTasks)
                if (!missionVisibleRef.current) {
                  const lastUserMsg = [...timelineMessagesRef.current]
                    .reverse()
                    .find((m) => m.role === 'user')
                  setTriggerMessageContent(lastUserMsg?.content?.trim() ?? null)
                  setMissionVisible(true)
                  missionVisibleRef.current = true
                }
              }
            } else if (lowerToolName === 'taskcreate' || lowerToolName === 'task_create') {
              const input = (state.input as Record<string, unknown>) ?? {}
              const newTask: MissionTask = {
                id: String(input.taskId ?? `task-${Date.now()}`),
                content: String(input.subject ?? input.description ?? ''),
                status: 'pending'
              }
              missionTasksRef.current = [...missionTasksRef.current, newTask]
              setMissionTasks([...missionTasksRef.current])
              if (!missionVisibleRef.current) {
                const lastUserMsg = [...timelineMessagesRef.current]
                  .reverse()
                  .find((m) => m.role === 'user')
                setTriggerMessageContent(lastUserMsg?.content?.trim() ?? null)
                setMissionVisible(true)
                missionVisibleRef.current = true
              }
            } else if (lowerToolName === 'taskupdate' || lowerToolName === 'task_update') {
              const input = (state.input as Record<string, unknown>) ?? {}
              const taskId = String(input.taskId ?? '')
              const newStatus = input.status as MissionTask['status'] | undefined
              if (taskId && newStatus) {
                missionTasksRef.current = missionTasksRef.current.map((t) =>
                  t.id === taskId ? { ...t, status: newStatus } : t
                )
                setMissionTasks([...missionTasksRef.current])
              }
            }
          }
        }

        // Lifecycle events
        if (event.type === 'session.status') {
          const statusType = event.data?.status?.type
          if (statusType === 'idle') {
            void refreshUsageSummary()
            // Refresh timeline to pick up newly committed messages
            void refresh()
              .then((msgs) => {
                // Sync mission tasks from committed timeline (source of truth after idle)
                if (msgs.length > 0) {
                  const extracted = extractMissionTasks(msgs)
                  if (extracted.length > 0) {
                    // Don't overwrite if all tasks already completed in memory —
                    // streaming TaskUpdate events are more authoritative than DB
                    // snapshots for task status (DB only has original TodoWrite input)
                    const currentAllComplete =
                      missionTasksRef.current.length > 0 &&
                      missionTasksRef.current.every((t) => t.status === 'completed')
                    if (!currentAllComplete) {
                      missionTasksRef.current = extracted
                      setMissionTasks(extracted)
                    }
                  }
                }
              })
              .finally(() => {
                optimisticRef.current = []
                clearStreamingBufferOverlay(sessionId, {
                  notify: 'immediate',
                  preserveCompactionState: true
                })
              })

            // Auto-drain pending message queue
            if (worktreePath && droidSessionId) {
              drainNextPending(
                sessionId,
                droidSessionId,
                (sid) => useSessionRuntimeStore.getState().dequeueMessage(sid),
                (wp, sid, content) => window.agentOps.prompt(wp, sid, content, requestModel),
                worktreePath
              ).catch((err) => console.error('[SessionShell] drainNextPending failed:', err))
            }
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
    requestModel,
    refreshUsageSummary
  ])

  // --- Composer action handler ---
  const handleComposerAction = useCallback(
    async (action: ComposerAction, content: string, attachments: Attachment[]): Promise<boolean> => {
      if (!worktreePath || !droidSessionId) return false
      let optimisticMessageId: string | null = null

      // Pure stop (no content) — just abort, don't clear anything
      if (action === 'stop_and_send' && !content.trim()) {
        try {
          await window.agentOps.abort(worktreePath, droidSessionId)
        } catch (err) {
          console.error('[SessionShell] abort failed:', err)
        }
        return false
      }

      if (action === 'send' || action === 'stop_and_send' || action === 'steer') {
        resetLiveOverlay(true)
      }

      // Optimistic insert — show user message immediately in the timeline
      if (
        (content.trim() || attachments.length > 0) &&
        (action === 'send' || action === 'stop_and_send' || action === 'steer')
      ) {
        const optimisticAttachments: MessagePart[] = attachments
          .filter((a) => a.kind === 'data')
          .map((a) => ({ type: 'file' as const, mime: a.mime, url: a.dataUrl, filename: a.name }))
        const optimisticMsg: TimelineMessage = {
          id: `optimistic-${Date.now()}`,
          role: 'user',
          content: content.trim(),
          timestamp: new Date().toISOString(),
          ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {})
        }
        optimisticMessageId = optimisticMsg.id
        appendOptimistic(optimisticMsg)
        // Sync ref immediately so MissionControl's streaming callback can find
        // the user message before the next useEffect tick
        timelineMessagesRef.current = [...timelineMessagesRef.current, optimisticMsg]
        syncOptimisticMessagesToMirror()
      }

      try {
        const consumed = await executeSendAction(action, content, attachments, {
          worktreePath,
          sessionId: droidSessionId,
          prompt: async (wp, sid, c) => {
            let messageParts: MessagePart[] | undefined
            if (attachments.length > 0) {
              messageParts = await buildMessageParts(attachments, c)
            }
            return window.agentOps.prompt(wp, sid, messageParts ?? c, requestModel)
          },
          steer: (wp, sid, c) => window.agentOps.steer(wp, sid, c, requestModel),
          abort: (wp, sid) => window.agentOps.abort(wp, sid),
          queueMessage: (sid, msg) => useSessionRuntimeStore.getState().queueMessage(sid, msg)
        })

        if (!consumed && (action === 'send' || action === 'stop_and_send')) {
          resetLiveOverlay(false)
        }

        return consumed
      } catch (err) {
        console.error('[SessionShell] action failed:', err)
        if (optimisticMessageId) {
          optimisticRef.current = optimisticRef.current.filter((msg) => msg.id !== optimisticMessageId)
          timelineMessagesRef.current = timelineMessagesRef.current.filter(
            (msg) => msg.id !== optimisticMessageId
          )
          setMessages((prev) => prev.filter((msg) => msg.id !== optimisticMessageId))
          syncOptimisticMessagesToMirror()
        }
        toast.error(err instanceof Error ? err.message : 'Failed to send message')
        resetLiveOverlay(false)
        return false
      }
    },
    [
      worktreePath,
      droidSessionId,
      sessionId,
      appendOptimistic,
      optimisticRef,
      requestModel,
      resetLiveOverlay,
      setMessages,
      syncOptimisticMessagesToMirror
    ]
  )

  const canEditUserMessage = useCallback(
    (message: TimelineMessage) =>
      message.role === 'user'
      && message.id === lastUserMessageId
      && !isStreaming
      && lifecycle !== 'busy'
      && lifecycle !== 'materializing',
    [lastUserMessageId, isStreaming, lifecycle]
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
      optimisticRef.current = optimisticRef.current.filter(
        (message) => trimmedMessages.some((candidate) => candidate.id === message.id)
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
      timelineMessagesRef.current = [...trimmedMessages, optimisticMsg]
      syncOptimisticMessagesToMirror()

      try {
        const consumed = await executeSendAction('send', contentToSend, [], {
          worktreePath,
          sessionId: droidSessionId,
          prompt: (wp, sid, content) => window.agentOps.prompt(wp, sid, content, requestModel),
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
      timelineMessages,
      setMessages,
      appendOptimistic,
      requestModel,
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
    const isClaudeCode = sessionRecord?.agent_sdk === 'claude-code'

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
        : sessionRecord?.agent_sdk === 'codex'
          ? 'Implement the plan.'
          : buildPlanImplementationPrompt(pendingBeforeAction.planContent)

      resetLiveOverlay(true)

      if (isClaudeCode) {
        // Claude resumes within the same prompt cycle after approval; mark the
        // session busy explicitly because no new busy edge is guaranteed.
        useWorktreeStatusStore.getState().setSessionStatus(sessionId, 'working')
        return
      }

      const optimisticMsg: TimelineMessage = {
        id: `optimistic-${Date.now()}`,
        role: 'user',
        content: implementPrompt,
        timestamp: new Date().toISOString()
      }
      appendOptimistic(optimisticMsg)
      timelineMessagesRef.current = [...timelineMessagesRef.current, optimisticMsg]
      syncOptimisticMessagesToMirror()

      await executeSendAction('send', implementPrompt, [], {
        worktreePath,
        sessionId: droidSessionId,
        prompt: (wp, sid, c) => window.agentOps.prompt(wp, sid, c, requestModel),
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
    sessionRecord?.agent_sdk,
    sessionId,
    appendOptimistic,
    resetLiveOverlay,
    syncOptimisticMessagesToMirror,
    transitionToolStatus,
    requestModel
  ])

  const handlePlanHandoff = useCallback(() => {
    // Just clear the pending plan — user will handle it elsewhere
    useSessionStore.getState().clearPendingPlan(sessionId)
  }, [sessionId])

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

  return (
    <div className="flex flex-col h-full">
      <SessionHeader
        sessionId={sessionId}
        session={sessionRecord}
        lifecycle={lifecycle}
        modelId={currentModelId}
        providerId={currentProviderId}
        sessionCost={sessionCost}
        sessionTokens={sessionTokens}
        usageSummary={usageSummary}
      />

      {/* Mission Control — sticky floating task progress panel */}
      <MissionControl
        tasks={missionTasks}
        triggerQuestion={triggerMessageContent}
        visible={missionVisible}
        allComplete={allTasksComplete}
        isStreaming={isStreaming}
      />

      {/* Main content area — relative for floating ComposerBar */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        <AgentTimeline
          timelineMessages={timelineMessages}
          streamingContent={streamingContent}
          streamingParts={streamingParts}
          isStreaming={isStreaming}
          lifecycle={lifecycle}
          ephemeralStatusRows={ephemeralStatusRows}
          suppressTodoCards={missionVisible}
          sessionId={sessionId}
          worktreePath={worktreePath}
          childPartsMap={childPartsMap}
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
        />

        <InterruptDock
          sessionId={sessionId}
          interrupt={currentInterrupt}
          worktreePath={worktreePath}
        />

        <PlanReadyImplementFab
          onImplement={handlePlanImplement}
          onHandoff={handlePlanHandoff}
          visible={!!pendingPlan}
          superpowersAvailable={false}
        />

        <ComposerBar
          sessionId={sessionId}
          lifecycle={lifecycle}
          pendingCount={pendingCount}
          firstInterrupt={composerInterrupt}
          onAction={handleComposerAction}
          isConnected={!!droidSessionId && !!worktreePath}
          supportsSteer={supportsSteer}
          mode={mode}
          onToggleMode={toggleMode}
          pendingPlan={pendingPlan}
          worktreePath={worktreePath}
          commandsVersion={commandsVersion}
        />

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
