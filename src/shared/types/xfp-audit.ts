import type { SharedAgentRuntimeId } from './agent-protocol'

export type XfpAuditRuntimeId = Extract<
  SharedAgentRuntimeId,
  'claude-code' | 'codex' | 'opencode' | 'xuanpu-agent'
>

export type XfpAuditKind = 'tool' | 'fallback' | 'prompt'

export type XfpAuditPrivacy = 'allowed' | 'redacted' | 'disabled'

export type XfpFieldDeliveryMode = 'none' | 'xfp-mcp' | 'xfp-fallback' | 'legacy-injection'

export interface XfpAuditEvent {
  id: string
  worktreeId: string | null
  sessionId: string | null
  runtimeId: XfpAuditRuntimeId
  kind: XfpAuditKind
  toolName: string
  input: Record<string, unknown>
  outputSummary: string
  outputChars: number
  truncated: boolean
  privacy: XfpAuditPrivacy
  createdAt: number
}

export interface XfpAuditListInput {
  worktreeId?: string | null
  sessionId?: string | null
  limit?: number
}
