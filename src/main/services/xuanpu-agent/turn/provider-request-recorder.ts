/**
 * Provider Request Recorder.
 *
 * Persists a provider request snapshot to agent_turn_context_snapshots
 * BEFORE the model is called. This ensures even failed turns are auditable.
 */
import { createAgentTurnContextSnapshot } from '../../../db/turn-repository'
import type { XuanpuProviderRequestSnapshot } from './turn-snapshot'

export function recordProviderRequestSnapshot(snapshot: XuanpuProviderRequestSnapshot): void {
  createAgentTurnContextSnapshot({
    turnId: snapshot.turnId,
    sessionId: snapshot.sessionId,
    xfpPacketId: null,
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
        text: msg.content.map((c) => c.text).join('').slice(0, 500)
      })),
      promptMessage: {
        role: snapshot.promptMessage.role,
        text: snapshot.promptMessage.content.map((c) => c.text).join('')
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
