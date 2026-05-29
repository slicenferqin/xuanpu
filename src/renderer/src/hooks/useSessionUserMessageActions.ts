import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import type { TimelineMessage } from '@shared/lib/timeline-types'
import {
  getMessageDisplayContent,
  getUserMessageForkCutoff,
  restoreMessageModePrefix
} from '@/lib/message-actions'
import { executeSendAction } from '@/lib/session-send-actions'
import {
  createOptimisticUserMessage,
  type OptimisticTimelineMessagesController
} from '@/hooks/useOptimisticTimelineMessages'
import { useSessionStore } from '@/stores/useSessionStore'
import {
  useSessionRuntimeStore,
  type PendingMessageModelSnapshot,
  type PendingMessagePromptOptions,
  type SessionLifecycle
} from '@/stores/useSessionRuntimeStore'
import { useSettingsStore } from '@/stores/useSettingsStore'

type Translate = (key: string, params?: Record<string, string | number | boolean>) => string
type ResetLiveOverlay = (nextIsStreaming: boolean) => void
type PromptSettledHandler = () => Promise<void>

export interface SessionRecordForUserMessageActions {
  id: string
  worktree_id: string | null
  project_id: string
  name: string | null
  model_provider_id: string | null
  model_id: string | null
  model_variant: string | null
}

export interface UseSessionUserMessageActionsOptions {
  sessionId: string
  worktreePath: string | null
  runtimeSessionId: string | null
  agentSdk: string | null
  sessionRecord: SessionRecordForUserMessageActions | null
  worktreeId: string | null | undefined
  timelineMessages: TimelineMessage[]
  latestUserMessageId: string | null
  isStreaming: boolean
  lifecycle: SessionLifecycle
  requestModel?: PendingMessageModelSnapshot | null
  promptOptions?: PendingMessagePromptOptions
  optimisticTimeline: OptimisticTimelineMessagesController
  resetLiveOverlay: ResetLiveOverlay
  onPromptSettled?: PromptSettledHandler
  t: Translate
}

export interface UseSessionUserMessageActionsResult {
  canEditUserMessage: (message: TimelineMessage) => boolean
  editingMessageId: string | null
  editingContent: string
  setEditingContent: (content: string) => void
  handleEditUserMessage: (message: TimelineMessage) => void
  handleCancelUserMessageEdit: () => void
  handleSaveUserMessageEdit: (messageId: string) => Promise<void>
  handleForkUserMessage: (message: TimelineMessage) => Promise<void>
  forkingMessageId: string | null
  forkConfirmOpen: boolean
  forkConfirmDismissChecked: boolean
  setForkConfirmDismissChecked: (checked: boolean) => void
  handleCancelForkFromMessage: () => void
  handleConfirmForkFromMessage: () => Promise<void>
}

export function useSessionUserMessageActions({
  sessionId,
  worktreePath,
  runtimeSessionId,
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
  onPromptSettled,
  t
}: UseSessionUserMessageActionsOptions): UseSessionUserMessageActionsResult {
  const skipForkFromMessageConfirm = useSettingsStore((state) => state.skipForkFromMessageConfirm)
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState('')
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null)
  const [pendingForkMessageId, setPendingForkMessageId] = useState<string | null>(null)
  const [forkConfirmDismissChecked, setForkConfirmDismissChecked] = useState(false)

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
      if (!trimmedContent || !worktreePath || !runtimeSessionId) return

      const messageIndex = timelineMessages.findIndex((message) => message.id === messageId)
      if (messageIndex === -1) return

      const originalMessage = timelineMessages[messageIndex]
      const contentToSend = restoreMessageModePrefix(originalMessage.content, trimmedContent)
      const trimmedMessages = timelineMessages.slice(0, messageIndex)

      optimisticTimeline.trimOptimisticMessagesToTimeline(trimmedMessages)
      setEditingMessageId(null)
      setEditingContent('')

      resetLiveOverlay(true)

      optimisticTimeline.appendOptimisticUserMessage(
        createOptimisticUserMessage({ content: trimmedContent }),
        { baseMessages: trimmedMessages }
      )

      try {
        const consumed = await executeSendAction('send', contentToSend, [], {
          worktreePath,
          sessionId: runtimeSessionId,
          queueSessionId: sessionId,
          runtimeId: agentSdk ?? undefined,
          model: requestModel,
          promptOptions,
          prompt: (wp, sid, content) =>
            window.agentOps.prompt(wp, sid, content, requestModel, promptOptions),
          abort: (wp, sid) => window.agentOps.abort(wp, sid),
          queueMessage: (sid, message) =>
            useSessionRuntimeStore.getState().queueMessage(sid, message)
        })

        if (!consumed) {
          resetLiveOverlay(false)
        } else {
          await onPromptSettled?.()
        }
      } catch (error) {
        console.error('[useSessionUserMessageActions] edit resend failed:', error)
        toast.error(t('sessionView.toasts.messageError'))
        resetLiveOverlay(false)
      }
    },
    [
      editingContent,
      worktreePath,
      runtimeSessionId,
      timelineMessages,
      optimisticTimeline,
      resetLiveOverlay,
      sessionId,
      agentSdk,
      requestModel,
      promptOptions,
      onPromptSettled,
      t
    ]
  )

  const performForkFromUserMessage = useCallback(
    async (messageId: string) => {
      if (forkingMessageId || !worktreePath || !runtimeSessionId) {
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
        const forkResult = await window.agentOps.fork(
          worktreePath,
          runtimeSessionId,
          cutoffMessageId
        )
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
      forkingMessageId,
      worktreePath,
      runtimeSessionId,
      sessionRecord,
      sessionId,
      worktreeId,
      timelineMessages,
      t
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

  const handleCancelForkFromMessage = useCallback(() => {
    setPendingForkMessageId(null)
    setForkConfirmDismissChecked(false)
  }, [])

  const handleConfirmForkFromMessage = useCallback(async () => {
    if (!pendingForkMessageId) return

    if (forkConfirmDismissChecked) {
      await useSettingsStore.getState().updateSetting('skipForkFromMessageConfirm', true)
    }

    await performForkFromUserMessage(pendingForkMessageId)
  }, [forkConfirmDismissChecked, pendingForkMessageId, performForkFromUserMessage])

  return {
    canEditUserMessage,
    editingMessageId,
    editingContent,
    setEditingContent,
    handleEditUserMessage,
    handleCancelUserMessageEdit,
    handleSaveUserMessageEdit,
    handleForkUserMessage,
    forkingMessageId,
    forkConfirmOpen: pendingForkMessageId !== null,
    forkConfirmDismissChecked,
    setForkConfirmDismissChecked,
    handleCancelForkFromMessage,
    handleConfirmForkFromMessage
  }
}
