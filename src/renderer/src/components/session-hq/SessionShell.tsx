/**
 * SessionShell — Phase 5
 *
 * Composition root for the new session UI. Zero business logic — it wires
 * together hooks and passes data to child components:
 *
 *   SessionHeader    — provider badge, model, lifecycle, tokens
 *   ThreadPane       — virtualized message list (durable + live overlay)
 *   AgentRail        — interrupt queue, running tools, unread
 *   InterruptDock    — first pending HITL prompt
 *   ComposerBar      — three-state send (Phase 5 state machine)
 *
 * Data sources:
 *   Durable layer  → useTimeline hook (IPC getTimeline)
 *   Runtime layer  → useSessionRuntimeStore (lifecycle, interrupts, unread, pending)
 *   View layer     → component-local state (editing, scrolling, etc.)
 */

import React, { useEffect, useState, useCallback, useRef } from 'react'
import { SessionHeader } from './SessionHeader'
import { ThreadPane, type ThreadPaneHandle } from './ThreadPane'
import { AgentRail } from './AgentRail'
import { InterruptDock } from './InterruptDock'
import { ComposerBar } from './ComposerBar'
import { useSessionRuntimeStore } from '@/stores/useSessionRuntimeStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores'
import { Loader2 } from 'lucide-react'
import type { TimelineMessage } from '@shared/lib/timeline-types'
import type { StreamingPart } from '../sessions/SessionView'
import type { Attachment } from '../sessions/AttachmentPreview'
import type { MessagePart } from '@shared/types/opencode'
import { buildMessageParts } from '@/lib/file-attachment-utils'
import type { CanonicalAgentEvent } from '@shared/types/agent-protocol'
import {
  executeSendAction,
  drainNextPending,
  type ComposerAction
} from '@/lib/session-send-actions'

// ---------------------------------------------------------------------------
// useTimeline hook — fetches durable timeline from main process
// ---------------------------------------------------------------------------

function useTimeline(sessionId: string) {
  const [messages, setMessages] = useState<TimelineMessage[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!window.agentOps?.getTimeline) {
      setLoading(false)
      return
    }
    try {
      const result = await window.agentOps.getTimeline(sessionId)
      setMessages(result.messages)
    } catch (err) {
      console.warn('[SessionShell] getTimeline failed:', err)
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    setLoading(true)
    setMessages([])
    refresh()
  }, [sessionId, refresh])

  return { messages, loading, refresh }
}

// ---------------------------------------------------------------------------
// useSessionRuntime selector — session-scoped runtime state
// ---------------------------------------------------------------------------

function useSessionRuntime(sessionId: string) {
  const lifecycle = useSessionRuntimeStore(
    (s) => s.getSession(sessionId).lifecycle
  )
  const interruptQueue = useSessionRuntimeStore(
    (s) => s.getInterruptQueue(sessionId)
  )
  const unreadCount = useSessionRuntimeStore(
    (s) => s.getSession(sessionId).unreadCount
  )
  const commandsAvailable = useSessionRuntimeStore(
    (s) => s.getSession(sessionId).commandsAvailable
  )
  const pendingCount = useSessionRuntimeStore(
    (s) => s.getPendingCount(sessionId)
  )

  return { lifecycle, interruptQueue, unreadCount, commandsAvailable, pendingCount }
}

// ---------------------------------------------------------------------------
// SessionShell
// ---------------------------------------------------------------------------

export interface SessionShellProps {
  sessionId: string
}

export function SessionShell({ sessionId }: SessionShellProps): React.JSX.Element {
  // --- Data sources ---
  const sessionRecord = useSessionStore((state) => {
    for (const sessions of state.sessionsByWorktree.values()) {
      const found = sessions.find((s) => s.id === sessionId)
      if (found) return found
    }
    for (const sessions of state.sessionsByConnection.values()) {
      const found = sessions.find((s) => s.id === sessionId)
      if (found) return found
    }
    return null
  })

  const worktreeId = sessionRecord?.worktree_id
  const worktreePath = useWorktreeStore((s) =>
    worktreeId ? s.worktrees.find((w) => w.id === worktreeId)?.path ?? null : null
  )

  const { messages: timelineMessages, loading, refresh } = useTimeline(sessionId)
  const { lifecycle, interruptQueue, unreadCount, commandsAvailable, pendingCount } =
    useSessionRuntime(sessionId)

  // --- Live streaming state (view-layer) ---
  const [streamingParts, setStreamingParts] = useState<StreamingPart[]>([])
  const [streamingContent, setStreamingContent] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [isCompacting, setIsCompacting] = useState(false)
  const [droidSessionId, setDroidSessionId] = useState<string | null>(
    sessionRecord?.opencode_session_id ?? null
  )

  const streamingPartsRef = useRef<StreamingPart[]>([])
  const streamingContentRef = useRef('')
  const threadPaneRef = useRef<ThreadPaneHandle>(null)

  // --- Subscribe to per-session events for streaming ---
  useEffect(() => {
    const unsubscribe = useSessionRuntimeStore
      .getState()
      .subscribeToSessionEvents(sessionId, (event: CanonicalAgentEvent) => {
        // Live streaming parts
        if (event.type === 'message.part.updated') {
          const partData = event.data
          if (!partData) return

          if (partData.type === 'text') {
            const text = typeof partData.text === 'string' ? partData.text : ''
            streamingContentRef.current += text
            setStreamingContent(streamingContentRef.current)
          }
        }

        // Lifecycle events
        if (event.type === 'session.status') {
          const statusType = event.data?.statusPayload?.type ?? event.data?.type
          if (statusType === 'busy') {
            setIsStreaming(true)
          } else if (statusType === 'idle') {
            setIsStreaming(false)
            setIsCompacting(false)
            // Refresh timeline to pick up newly committed messages
            refresh()
            // Clear streaming state
            streamingPartsRef.current = []
            streamingContentRef.current = ''
            setStreamingParts([])
            setStreamingContent('')

            // Phase 5: Auto-drain pending message queue
            if (worktreePath && droidSessionId) {
              drainNextPending(
                sessionId,
                droidSessionId,
                (sid) => useSessionRuntimeStore.getState().dequeueMessage(sid),
                (wp, sid, content) => window.agentOps.prompt(wp, sid, content),
                worktreePath
              ).catch((err) =>
                console.error('[SessionShell] drainNextPending failed:', err)
              )
            }
          }
        }

        if (event.type === 'session.materialized') {
          const newId = event.data?.newSessionId as string | undefined
          if (newId) setDroidSessionId(newId)
        }
      })

    return unsubscribe
  }, [sessionId, refresh, worktreePath, droidSessionId])

  // --- Composer action handler (Phase 5) ---
  const handleComposerAction = useCallback(
    async (action: ComposerAction, content: string, attachments: Attachment[]) => {
      if (!worktreePath || !droidSessionId) return

      // For actions that send immediately, prepare streaming state
      if (action === 'send' || action === 'stop_and_send' || action === 'steer') {
        streamingPartsRef.current = []
        streamingContentRef.current = ''
        setStreamingParts([])
        setStreamingContent('')
        setIsStreaming(true)
      }

      try {
        const consumed = await executeSendAction(action, content, attachments, {
          worktreePath,
          sessionId: droidSessionId,
          prompt: async (wp, sid, c) => {
            // Build message parts if there are attachments
            let messageParts: MessagePart[] | undefined
            if (attachments.length > 0) {
              messageParts = await buildMessageParts(c, attachments)
            }
            return window.agentOps.prompt(wp, sid, messageParts ?? c)
          },
          abort: (wp, sid) => window.agentOps.abort(wp, sid),
          queueMessage: (sid, msg) =>
            useSessionRuntimeStore.getState().queueMessage(sid, msg)
        })

        if (!consumed && (action === 'send' || action === 'stop_and_send')) {
          setIsStreaming(false)
        }
      } catch (err) {
        console.error('[SessionShell] action failed:', err)
        setIsStreaming(false)
      }
    },
    [worktreePath, droidSessionId]
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

  return (
    <div className="flex flex-col h-full">
      <SessionHeader
        sessionId={sessionId}
        session={sessionRecord}
        lifecycle={lifecycle}
      />

      <div className="flex flex-1 overflow-hidden">
        <ThreadPane
          ref={threadPaneRef}
          timelineMessages={timelineMessages}
          streamingParts={streamingParts}
          streamingContent={streamingContent}
          isStreaming={isStreaming}
          isCompacting={isCompacting}
          worktreePath={worktreePath}
        />

        <AgentRail
          sessionId={sessionId}
          lifecycle={lifecycle}
          interruptQueue={interruptQueue}
          unreadCount={unreadCount}
          commandsAvailable={commandsAvailable}
        />
      </div>

      <InterruptDock
        sessionId={sessionId}
        interrupt={currentInterrupt}
        worktreePath={worktreePath}
      />

      <ComposerBar
        sessionId={sessionId}
        lifecycle={lifecycle}
        pendingCount={pendingCount}
        firstInterrupt={currentInterrupt}
        onAction={handleComposerAction}
        isConnected={!!droidSessionId && !!worktreePath}
      />
    </div>
  )
}
