/**
 * Provider Request Recorder.
 *
 * Persists a provider request snapshot to agent_turn_context_snapshots
 * BEFORE the model is called. This ensures even failed turns are auditable.
 */
import { createAgentTurnContextSnapshot } from '../../../db/turn-repository'
import type { XuanpuProviderRequestSnapshot } from './turn-snapshot'

export function recordProviderRequestSnapshot(
  snapshot: XuanpuProviderRequestSnapshot,
  xfpPacketId?: string
): void {
  createAgentTurnContextSnapshot({
    turnId: snapshot.turnId,
    sessionId: snapshot.sessionId,
    xfpPacketId: xfpPacketId ?? null,
    providerRequestHash: snapshot.providerRequestHash,
    prefixHash: snapshot.prefixHash ?? null,
    managedContextJson: JSON.stringify({
      budget: snapshot.budget,
      messageCount: snapshot.contextMessages.length + 1
    }),
    providerMessagesJson: JSON.stringify({
      systemPrompt: snapshot.systemPrompt,
      contextMessages: snapshot.contextMessages.map((msg) => ({
        role: msg.role,
        content: msg.content
      })),
      promptMessage: {
        role: snapshot.promptMessage.role,
        content: snapshot.promptMessage.content
      }
    }),
    providerToolsJson: snapshot.toolsJson,
    providerConfigJson: JSON.stringify({
      modelRef: {
        providerID: snapshot.modelRef.providerID,
        modelID: snapshot.modelRef.modelID,
        variant: snapshot.modelRef.variant ?? null
      },
      providerSessionPolicy: snapshot.providerSessionPolicy
    }),
    decisionsJson: JSON.stringify({
      providerRequestHash: snapshot.providerRequestHash,
      prefixHash: snapshot.prefixHash,
      includedMessageCount: snapshot.contextMessages.length
    }),
    managedApproxTokens: snapshot.budget.managedApproxTokens,
    providerEstimatedInputTokens: snapshot.budget.providerEstimatedInputTokens,
    maxContextTokens: snapshot.budget.maxContextTokens
  })
}
