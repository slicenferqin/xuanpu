import type { SharedAgentRuntimeId } from './agent-protocol'

export type FieldContextPackageSectionKind =
  | 'anchor'
  | 'frozen_episodes'
  | 'retrieved_episodes'
  | 'working_set'
  | 'current_field'

export interface FieldContextPackageSectionDebug {
  id: string
  kind: FieldContextPackageSectionKind
  title: string
  included: boolean
  approxTokens: number
  source?: string
  reason?: string
  metadata?: Record<string, unknown>
}

export interface FieldContextPackageDebugQuery {
  sessionId?: string
  worktreeId?: string
  runtimeId?: SharedAgentRuntimeId
  limit?: number
  includeRenderedMarkdown?: boolean
}

export interface FieldContextPackageDebugRecord {
  id: string
  sessionId: string
  worktreeId: string
  runtimeId: string
  modelProviderId?: string | null
  modelId?: string | null
  createdAt: number
  budgetProfile: 'focused' | 'balanced' | 'extended' | 'max'
  approxTokens: number
  sections: FieldContextPackageSectionDebug[]
  renderedMarkdown?: string | null
  renderedMarkdownStored?: boolean
  decisions: Record<string, unknown>
}

export type FieldEpisodeBlockKind = 'turns' | 'events' | 'checkpoint' | 'manual'
export type FieldEpisodeBlockConfidence = 'low' | 'medium' | 'high'

export interface FieldEpisodeRawRefDebug {
  type: 'session_message' | 'field_event' | 'file' | 'command' | 'manual'
  id: string
  seq?: number
  role?: string
  at?: string | number | null
  metadata?: Record<string, unknown>
}

export interface FieldEpisodeBlockDebugQuery {
  worktreeId?: string
  sessionId?: string
  kind?: FieldEpisodeBlockKind
  limit?: number
}

export interface FieldEpisodeBlockDebugRecord {
  id: string
  worktreeId: string
  sessionId?: string | null
  createdAt: number
  sourceEventSeqStart?: number | null
  sourceEventSeqEnd?: number | null
  sourceMessageIdStart?: string | null
  sourceMessageIdEnd?: string | null
  kind: FieldEpisodeBlockKind
  title?: string | null
  summaryMarkdown: string
  keyFacts: string[]
  constraints: string[]
  files: string[]
  commands: string[]
  failures: string[]
  rawRefs: FieldEpisodeRawRefDebug[]
  tokenEstimate: number
  confidence: FieldEpisodeBlockConfidence
}
