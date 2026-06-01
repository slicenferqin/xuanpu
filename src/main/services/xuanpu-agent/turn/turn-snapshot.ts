/**
 * Turn-scoped types shared across the turn builder, runner, and event router.
 */
import type { XuanpuPiPromptMessage } from '../context-transform'
import type { XuanpuAgentModelRef } from '../model-config'

// ─────────────────────────────────────────────────────────────────────────────
// Provider Session Policy
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderSessionPolicyMode = 'disabled' | 'explicit-prefix-cache' | 'provider-continuation'

export interface ProviderSessionPolicy {
  mode: ProviderSessionPolicyMode
  providerSessionId?: string
  providerSessionStateKey?: string
  reason: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn Budget
// ─────────────────────────────────────────────────────────────────────────────

export interface XuanpuTurnBudget {
  profile: 'focused' | 'balanced' | 'extended'
  managedApproxTokens: number
  providerEstimatedInputTokens: number
  maxContextTokens: number
  fillRatio: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider Request Snapshot (INV-TURN-5: auditably replayable)
// ─────────────────────────────────────────────────────────────────────────────

export interface XuanpuProviderRequestSnapshot {
  turnId: string
  sessionId: string
  providerRequestHash: string
  prefixHash?: string
  systemPrompt: string[]
  contextMessages: XuanpuPiPromptMessage[]
  promptMessage: XuanpuPiPromptMessage
  toolsJson: string
  modelRef: XuanpuAgentModelRef
  providerSessionPolicy: ProviderSessionPolicy
  budget: XuanpuTurnBudget
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn Runner Input / Output
// ─────────────────────────────────────────────────────────────────────────────

export interface XuanpuToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface XuanpuRunTurnInput {
  turnId: string
  sessionId: string
  worktreePath: string
  modelRef: XuanpuAgentModelRef
  systemPrompt: string[]
  contextMessages: XuanpuPiPromptMessage[]
  promptMessage: XuanpuPiPromptMessage
  tools: XuanpuToolDefinition[]
  toolMode: 'plan' | 'build'
  providerSessionPolicy: ProviderSessionPolicy
  budget: XuanpuTurnBudget
  requestSnapshot: XuanpuProviderRequestSnapshot
}

export interface XuanpuProviderUsage {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  totalTokens: number
  raw?: Record<string, unknown>
}

export interface XuanpuRunTurnResult {
  turnId: string
  assistantMessageId: string
  text: string
  rawAssistantMessage?: unknown
  usage?: XuanpuProviderUsage
  /** Model reference resolved during the turn. */
  modelRef: XuanpuAgentModelRef
}
