/**
 * Provider Request Recorder.
 *
 * Persists a provider request snapshot to agent_turn_context_snapshots
 * BEFORE the model is called. This ensures even failed turns are auditable.
 */
import { createHash } from 'node:crypto'
import { createAgentTurnContextSnapshot } from '../../../db/turn-repository'
import { incrementUserRoundProviderRequestCount } from '../../../db/task-run-repository'
import type { XuanpuPiPromptMessage } from '../context-transform'
import type { XuanpuProviderRequestSnapshot } from './turn-snapshot'

function sanitizePromptMessageForStorage(message: XuanpuPiPromptMessage): {
  role: XuanpuPiPromptMessage['role']
  content: Array<Record<string, unknown>>
} {
  return {
    role: message.role,
    content: message.content.map((part) => {
      if (part.type === 'text') {
        return { type: 'text', text: part.text }
      }
      return {
        type: 'image',
        mimeType: part.mimeType,
        dataSha256: createHash('sha256').update(part.data).digest('hex'),
        byteLength: Buffer.byteLength(part.data, 'base64'),
        contentOmitted: true
      }
    })
  }
}

export function recordProviderRequestSnapshot(
  snapshot: XuanpuProviderRequestSnapshot,
  xfpPacketId?: string
): void {
  createAgentTurnContextSnapshot({
    turnId: snapshot.turnId,
    sessionId: snapshot.sessionId,
    xfpPacketId: xfpPacketId ?? null,
    taskRunId: snapshot.taskRunId ?? null,
    userRoundId: snapshot.userRoundId ?? null,
    contextSegmentId: snapshot.contextSegmentId ?? null,
    contextSegmentOrdinal: snapshot.contextSegmentOrdinal ?? null,
    providerCallSeq: snapshot.providerCallSeq ?? 0,
    providerRequestHash: snapshot.providerRequestHash,
    prefixHash: snapshot.prefixHash ?? null,
    managedContextJson: JSON.stringify({
      budget: snapshot.budget,
      taskRunId: snapshot.taskRunId ?? null,
      userRoundId: snapshot.userRoundId ?? null,
      contextSegmentId: snapshot.contextSegmentId ?? null,
      contextSegmentOrdinal: snapshot.contextSegmentOrdinal ?? null,
      providerCallSeq: snapshot.providerCallSeq ?? 0,
      messageCount: snapshot.contextMessages.length + 1
    }),
    providerMessagesJson: JSON.stringify({
      systemPrompt: snapshot.systemPrompt,
      contextMessages: snapshot.contextMessages.map(sanitizePromptMessageForStorage),
      promptMessage: sanitizePromptMessageForStorage(snapshot.promptMessage)
    }),
    providerToolsJson: snapshot.toolsJson,
    providerConfigJson: JSON.stringify({
      modelRef: {
        providerID: snapshot.modelRef.providerID,
        modelID: snapshot.modelRef.modelID,
        variant: snapshot.modelRef.variant ?? null,
        reasoningEffort: snapshot.modelRef.reasoningEffort ?? null,
        verbosity: snapshot.modelRef.verbosity ?? null,
        providerOptions: snapshot.modelRef.providerOptions ?? null
      },
      providerSessionPolicy: snapshot.providerSessionPolicy
    }),
    decisionsJson: JSON.stringify({
      providerRequestHash: snapshot.providerRequestHash,
      prefixHash: snapshot.prefixHash,
      taskRunId: snapshot.taskRunId ?? null,
      userRoundId: snapshot.userRoundId ?? null,
      contextSegmentId: snapshot.contextSegmentId ?? null,
      contextSegmentOrdinal: snapshot.contextSegmentOrdinal ?? null,
      providerCallSeq: snapshot.providerCallSeq ?? 0,
      includedMessageCount: snapshot.contextMessages.length
    }),
    managedApproxTokens: snapshot.budget.managedApproxTokens,
    providerEstimatedInputTokens: snapshot.budget.providerEstimatedInputTokens,
    maxContextTokens: snapshot.budget.maxContextTokens
  })
  if (snapshot.userRoundId) {
    incrementUserRoundProviderRequestCount(snapshot.userRoundId)
  }
}
