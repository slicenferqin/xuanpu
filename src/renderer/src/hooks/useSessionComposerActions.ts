import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import type { MessagePart } from '@shared/types/opencode'
import type { DiffComment } from '@shared/types/git'
import type { Attachment } from '@/components/sessions/AttachmentPreview'
import { buildRuntimeMessagePayload } from '@/lib/file-attachment-utils'
import { refreshSessionLastMessageAt } from '@/lib/session-last-message'
import { executeSendAction, type ComposerAction } from '@/lib/session-send-actions'
import { mergeXuanpuAgentAutonomyDirective } from '@/lib/xuanpu-agent-autonomy-directive'
import {
  createOptimisticUserMessage,
  type OptimisticTimelineMessagesController
} from '@/hooks/useOptimisticTimelineMessages'
import { useDiffCommentStore } from '@/stores/useDiffCommentStore'
import {
  useSessionRuntimeStore,
  type PendingMessageModelSnapshot,
  type PendingMessagePromptOptions
} from '@/stores/useSessionRuntimeStore'
import { useSessionStore } from '@/stores/useSessionStore'

type ResetLiveOverlay = (nextIsStreaming: boolean) => void

interface UseSessionComposerActionsOptions {
  sessionId: string
  worktreePath: string | null
  runtimeSessionId: string | null
  agentSdk: string | null
  requestModel?: PendingMessageModelSnapshot | null
  promptOptions?: PendingMessagePromptOptions
  supportsSessionGoalMode: boolean
  goalMode: boolean
  successCriteria: string
  setGoalMode: Dispatch<SetStateAction<boolean>>
  setSuccessCriteria: Dispatch<SetStateAction<string>>
  optimisticTimeline: OptimisticTimelineMessagesController
  resetLiveOverlay: ResetLiveOverlay
  waitForAbortReady: () => Promise<void>
}

interface UseSessionComposerActionsResult {
  handleComposerAction: (
    action: ComposerAction,
    content: string,
    attachments: Attachment[]
  ) => Promise<boolean>
}

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

export function useSessionComposerActions({
  sessionId,
  worktreePath,
  runtimeSessionId,
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
  waitForAbortReady
}: UseSessionComposerActionsOptions): UseSessionComposerActionsResult {
  const handleComposerAction = useCallback(
    async (
      action: ComposerAction,
      content: string,
      attachments: Attachment[]
    ): Promise<boolean> => {
      if (!worktreePath || !runtimeSessionId) return false
      let optimisticMessageId: string | null = null
      const shouldClearGoalComposer =
        supportsSessionGoalMode && goalMode && (action === 'send' || action === 'stop_and_send')
      const previousGoalMode = goalMode
      const previousSuccessCriteria = successCriteria

      // Pure stop requests provider interruption only. The runtime event stream
      // remains visible until the provider confirms the turn has actually stopped.
      if (action === 'stop_and_send' && !content.trim()) {
        try {
          const result = (await window.agentOps.abort(worktreePath, runtimeSessionId)) as {
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
        // first_message_at, but the UI shouldn't wait for the IPC round-trip.
        useSessionStore.getState().markSessionFirstMessage(sessionId)
      }

      if (shouldClearGoalComposer) {
        setGoalMode(false)
        setSuccessCriteria('')
      }

      if (
        (contentToSend.trim() || attachments.length > 0) &&
        (action === 'send' ||
          action === 'stop_and_send' ||
          action === 'steer' ||
          action === 'queue')
      ) {
        const optimisticAttachments = attachmentsToMessageParts(attachments)
        const optimisticMessage = createOptimisticUserMessage({
          idPrefix: action === 'queue' ? 'queued' : 'optimistic',
          content: contentToSend,
          deliveryStatus: action === 'queue' ? 'queued' : undefined,
          attachments: optimisticAttachments
        })
        optimisticMessageId = optimisticMessage.id
        optimisticTimeline.appendOptimisticUserMessage(optimisticMessage)
      }

      try {
        const effectivePromptOptions = mergeXuanpuAgentAutonomyDirective(
          content,
          agentSdk,
          promptOptions
        )

        const consumed = await executeSendAction(action, contentToSend, attachments, {
          worktreePath,
          sessionId: runtimeSessionId,
          queueSessionId: sessionId,
          runtimeId: agentSdk ?? undefined,
          model: requestModel,
          promptOptions: effectivePromptOptions,
          prompt: async (wp, sid, c) => {
            const payload =
              attachments.length > 0 ? buildRuntimeMessagePayload(agentSdk, attachments, c) : c
            return window.agentOps.prompt(wp, sid, payload, requestModel, effectivePromptOptions)
          },
          steer: (wp, sid, c) => window.agentOps.steer(wp, sid, c, requestModel),
          abort: (wp, sid) => window.agentOps.abort(wp, sid),
          waitForAbortReady,
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
          optimisticTimeline.removeOptimisticUserMessage(optimisticMessageId)
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
      runtimeSessionId,
      supportsSessionGoalMode,
      goalMode,
      successCriteria,
      resetLiveOverlay,
      sessionId,
      setGoalMode,
      setSuccessCriteria,
      optimisticTimeline,
      agentSdk,
      requestModel,
      promptOptions,
      waitForAbortReady
    ]
  )

  return { handleComposerAction }
}
