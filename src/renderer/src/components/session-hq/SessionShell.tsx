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
 *   Durable layer  → useSessionTimeline hook (IPC getTimeline)
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
import { useDiffCommentStore } from '@/stores/useDiffCommentStore'
import { useSettingsStore, resolveModelForSdk } from '@/stores/useSettingsStore'
import { Loader2, MessageSquare, X } from 'lucide-react'
import type { TimelineMessage } from '@shared/lib/timeline-types'
import {
  beginLocalSessionRun,
  cancelLocalSessionRun,
  getStreamingBufferSnapshot,
  subscribeToStreamingBuffer,
  updateStreamingBuffer
} from '@/stores/useSessionRuntimeStore'
import { useI18n } from '@/i18n/useI18n'
import { useSessionComposerActions } from '@/hooks/useSessionComposerActions'
import { useOptimisticTimelineMessages } from '@/hooks/useOptimisticTimelineMessages'
import { usePendingMessageDrain } from '@/hooks/usePendingMessageDrain'
import { usePendingInitialMessageSender } from '@/hooks/usePendingInitialMessageSender'
import { useSessionPlanActions } from '@/hooks/useSessionPlanActions'
import { useSessionTimeline } from '@/hooks/useSessionTimeline'
import { useSessionUserMessageActions } from '@/hooks/useSessionUserMessageActions'
import { useTimelineScrollController } from '@/hooks/useTimelineScrollController'
import { useSessionUsageHydration } from '@/hooks/useSessionUsageHydration'
import { useSessionMissionTasks } from '@/hooks/useSessionMissionTasks'
import { useSessionEventSubscription } from '@/hooks/useSessionEventSubscription'
import { useSessionRuntimeConnection } from '@/hooks/useSessionRuntimeConnection'
import { useSessionThreadStatusRows } from '@/hooks/useSessionThreadStatusRows'
import { useTimelineToolStatusTransition } from '@/hooks/useTimelineToolStatusTransition'
import { useSessionAbortReadiness } from '@/hooks/useSessionAbortReadiness'

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
  const opcSessionId = sessionRecord?.opencode_session_id ?? null
  const agentSdk = sessionRecord?.agent_sdk ?? null
  const {
    worktreePath,
    runtimeSessionId: droidSessionId,
    setRuntimeSessionId,
    supportsSteer
  } = useSessionRuntimeConnection({
    sessionId,
    worktreeId,
    connectionId,
    opencodeSessionId: opcSessionId,
    agentSdk
  })

  const {
    messages: timelineMessages,
    setMessages,
    loading,
    refresh,
    appendOptimistic,
    optimisticRef
  } = useSessionTimeline(sessionId, {
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

  // --- Model resolution ---
  const focusMode = useSettingsStore((s) => s.focusMode)
  const readingDensity = useSettingsStore((s) => s.readingDensity)
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
    if (agentSdk === 'opencode' || agentSdk === 'xuanpu-agent') {
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

      if (agentSdk === 'opencode' || agentSdk === 'xuanpu-agent') {
        return { mode: options?.mode ?? mode }
      }

      return undefined
    },
    [agentSdk, mode, promptOptions, supportsSessionGoalMode]
  )
  const currentProviderId = requestModel?.providerID ?? ''
  const { refreshUsageSummary } = useSessionUsageHydration({
    sessionId,
    timelineMessages,
    worktreePath,
    runtimeSessionId: droidSessionId,
    currentProviderId
  })

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
  // Overlay ref for measuring the combined bottom area (interrupt dock + composer)
  const bottomOverlayRef = useRef<HTMLDivElement>(null)

  // Incremented when session.commands_available fires — triggers ComposerBar re-fetch
  const [commandsVersion, setCommandsVersion] = useState(0)
  const notifyCommandsAvailable = useCallback(() => {
    setCommandsVersion((v) => v + 1)
  }, [])
  const preferSteerWhenBusy = agentSdk === 'codex'

  const { drainQueuedMessage } = usePendingMessageDrain({
    sessionId,
    worktreePath,
    runtimeSessionId: droidSessionId,
    lifecycle,
    pendingCount,
    requestModel,
    promptOptions
  })

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

  const resetLiveOverlay = useCallback(
    (nextIsStreaming: boolean) => {
      if (nextIsStreaming) {
        beginLocalSessionRun(sessionId)
        return
      }
      cancelLocalSessionRun(sessionId)
    },
    [sessionId]
  )

  const timelineMessagesRef = useRef<TimelineMessage[]>([])

  useEffect(() => {
    timelineMessagesRef.current = timelineMessages
  }, [timelineMessages])

  const { latestUserMessageId, applyMissionTaskToolEvent, syncMissionTasksFromMessages } =
    useSessionMissionTasks({
      sessionId,
      timelineMessages
    })

  const { ephemeralStatusRows, inflightCompactionRow } = useSessionThreadStatusRows({
    sessionId,
    lifecycle,
    runStartedAt,
    compactionState,
    timelineMessages
  })

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

  const timelineMetricsVersion = `${timelineMessages.length}:${ephemeralStatusRows.length}:${
    streamingParts.length
  }:${isStreaming ? 1 : 0}`

  // Measure the bottom overlay height for scroll geometry.
  // This replaces the hybrid safeBottomPadding heuristic.
  // MUST be defined before useTimelineScrollController so the same inset
  // drives AgentTimeline.paddingBottom, tail observer, clear-screen filler,
  // and FAB bottom offset.
  // Use useLayoutEffect for initial measurement so the first paint uses the
  // real overlay height, not the initial 24px placeholder.
  const [bottomOverlayHeight, setBottomOverlayHeight] = useState(0)
  const bottomReadableInset = bottomOverlayHeight > 0 ? bottomOverlayHeight + 24 : 144

  useLayoutEffect(() => {
    const el = bottomOverlayRef.current
    if (!el) {
      setBottomOverlayHeight(0)
      return
    }

    const measure = (): void => {
      const nextHeight = Math.round(el.getBoundingClientRect().height)
      setBottomOverlayHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight
      )
    }

    measure()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [loading, sessionRecord?.id])

  const timelineScroll = useTimelineScrollController({
    sessionId,
    ready: !loading,
    contentVersion: liveTimelineContentVersion,
    metricsVersion: timelineMetricsVersion,
    mirrorVersion,
    isStreaming,
    bottomReadableInset,
    bottomAreaRef: timelineBottomAreaRef,
    composerRef: composerBarRef
  })
  const requestClearScreenScroll = timelineScroll.requestClearScreenScroll
  const scrollToRound = timelineScroll.scrollToRound

  const requestTurnTopScroll = useCallback(
    (roundId: string) => {
      requestClearScreenScroll(roundId)
    },
    [requestClearScreenScroll]
  )

  const optimisticTimeline = useOptimisticTimelineMessages({
    appendOptimistic,
    optimisticRef,
    timelineMessagesRef,
    setMessages,
    syncOptimisticMessagesToMirror,
    requestTurnTopScroll
  })

  const transitionToolStatus = useTimelineToolStatusTransition({
    sessionId,
    timelineMessagesRef,
    setMessages
  })

  const clearOptimisticMessages = useCallback(() => {
    optimisticRef.current = []
  }, [optimisticRef])

  usePendingInitialMessageSender({
    sessionId,
    worktreePath,
    runtimeSessionId: droidSessionId,
    mode,
    requestModel,
    buildPendingPromptOptions,
    optimisticTimeline,
    resetLiveOverlay,
  })

  useSessionEventSubscription({
    sessionId,
    currentProviderId,
    refresh,
    refreshUsageSummary,
    drainQueuedMessage,
    clearOptimisticMessages,
    setRuntimeSessionId,
    notifyCommandsAvailable,
    applyMissionTaskToolEvent,
    syncMissionTasksFromMessages
  })

  // --- Composer action handler ---
  const waitForAbortReady = useSessionAbortReadiness(sessionId)
  const { handleComposerAction } = useSessionComposerActions({
    sessionId,
    worktreePath,
    runtimeSessionId: droidSessionId,
    agentSdk,
    requestModel,
    promptOptions,
    supportsSessionGoalMode,
    goalMode,
    successCriteria,
    setGoalMode,
    setSuccessCriteria,
    optimisticTimeline,
    resetLiveOverlay,
    waitForAbortReady,
  })

  const userMessageActions = useSessionUserMessageActions({
    sessionId,
    worktreePath,
    runtimeSessionId: droidSessionId,
    agentSdk,
    sessionRecord,
    worktreeId,
    timelineMessages,
    latestUserMessageId,
    isStreaming,
    lifecycle,
    requestModel,
    promptOptions,
    optimisticTimeline,
    resetLiveOverlay,
    t
  })

  // --- Plan implement/handoff handlers ---
  const { handlePlanImplement, handlePlanHandoff, handlePlanReject } = useSessionPlanActions({
    sessionId,
    worktreePath,
    runtimeSessionId: droidSessionId,
    agentSdk,
    pendingPlan,
    connectionId,
    worktreeId,
    projectId: sessionRecord?.project_id,
    goalMode,
    successCriteria,
    requestModel,
    promptOptions,
    optimisticTimeline,
    resetLiveOverlay,
    transitionToolStatus,
    refresh,
    t
  })

  const handleRoundAnchorNavigate = useCallback(
    (roundId: string) => {
      scrollToRound(roundId, { behavior: 'smooth', topPadding: 24 })
    },
    [scrollToRound]
  )

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
    <div className="relative h-full min-h-0 overflow-hidden" data-focus-mode={focusMode} data-reading-density={readingDensity}>
      {/* Timeline fills the full stage */}
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
        canEditUserMessage={userMessageActions.canEditUserMessage}
        editingMessageId={userMessageActions.editingMessageId}
        editingContent={userMessageActions.editingContent}
        onEditingContentChange={userMessageActions.setEditingContent}
        onSaveUserMessageEdit={userMessageActions.handleSaveUserMessageEdit}
        onCancelUserMessageEdit={userMessageActions.handleCancelUserMessageEdit}
        onEditUserMessage={userMessageActions.handleEditUserMessage}
        onForkUserMessage={userMessageActions.handleForkUserMessage}
        onCopyUserMessage={() => {}}
        forkingMessageId={userMessageActions.forkingMessageId}
        scrollContainerRef={timelineScroll.scrollContainerRef}
        timelineContentRef={timelineScroll.timelineContentRef}
        tailSentinelRef={timelineScroll.tailSentinelRef}
        bottomReadableInset={bottomReadableInset}
        onScroll={timelineScroll.handleScroll}
        onWheel={timelineScroll.handleScrollWheel}
        onPointerDown={timelineScroll.handleScrollPointerDown}
        onPointerUp={timelineScroll.handleScrollPointerUp}
        onPointerCancel={timelineScroll.handleScrollPointerCancel}
        clearScreenSpacerHeight={timelineScroll.focusFillerHeight}
        activeRoundId={timelineScroll.activeRoundId}
        onRoundAnchorNavigate={handleRoundAnchorNavigate}
      />

      {/* Jump-to-bottom FAB: positioned above the overlay */}
      <ScrollToBottomFab
        onClick={timelineScroll.handleScrollToBottomClick}
        visible={timelineScroll.showJumpToBottom}
        count={timelineScroll.unreadCount}
        style={{ bottom: `${bottomReadableInset + 16}px` }}
      />

      <PlanReadyImplementFab
        onImplement={handlePlanImplement}
        onHandoff={handlePlanHandoff}
        onReject={handlePlanReject}
        visible={!!pendingPlan}
        superpowersAvailable={false}
      />

      {/* Bottom overlay: absolute, does not affect timeline clientHeight */}
      <div
        ref={bottomOverlayRef}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-20"
        data-testid="session-bottom-overlay"
      >
        <div
          className="crisp-composer-veil pointer-events-none absolute inset-x-0 bottom-0"
          style={{ height: `${bottomOverlayHeight + 24}px` }}
        />

        <div className="pointer-events-auto">
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
      </div>

      {process.env.NODE_ENV === 'development' && (
        <div className="absolute right-3 top-3 z-30 w-[min(720px,calc(100%-1.5rem))] rounded-lg border border-border/45 bg-background/92 shadow-lg backdrop-blur">
          <FieldContextDebug
            sessionId={droidSessionId}
            fallbackSessionIds={[sessionId]}
            worktreeId={worktreeId}
          />
        </div>
      )}

      <ForkFromMessageConfirmDialog
        open={userMessageActions.forkConfirmOpen}
        dontShowAgain={userMessageActions.forkConfirmDismissChecked}
        onDontShowAgainChange={userMessageActions.setForkConfirmDismissChecked}
        onCancel={userMessageActions.handleCancelForkFromMessage}
        onConfirm={() => {
          void userMessageActions.handleConfirmForkFromMessage()
        }}
      />
    </div>
  )
}
