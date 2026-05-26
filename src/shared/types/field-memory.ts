export type FieldMemoryScope = 'user' | 'project' | 'worktree' | 'session' | 'episode' | 'command'

export type FieldMemoryKind = 'fact' | 'decision' | 'assumption' | 'constraint'

export type FieldMemoryStatus = 'proposed' | 'accepted' | 'rejected' | 'archived'

export interface FieldMemoryRawRef {
  type:
    | 'session_message'
    | 'field_event'
    | 'file'
    | 'command'
    | 'episode'
    | 'memory_page'
    | 'manual'
  id: string
  seq?: number
  role?: string
  at?: string | number | null
  excerpt?: string
  metadata?: Record<string, unknown>
}

export interface FieldMemoryEntity {
  type: 'file' | 'command' | 'symbol' | 'keyword' | 'error_signature'
  value: string
}

export interface FieldMemoryPageRecord {
  id: string
  scope: FieldMemoryScope
  scopeId: string
  projectId?: string | null
  worktreeId?: string | null
  sessionId?: string | null
  episodeId?: string | null
  commandTraceId?: string | null
  kind: FieldMemoryKind
  status: FieldMemoryStatus
  title: string
  bodyMarkdown: string
  entities: FieldMemoryEntity[]
  rawRefs: FieldMemoryRawRef[]
  retrievalHints: string[]
  source: string
  proposedBy: string
  proposalReason?: string | null
  createdAt: number
  updatedAt: number
  acceptedAt?: number | null
  rejectedAt?: number | null
  archivedAt?: number | null
}

export interface FieldMemoryPageListQuery {
  worktreeId?: string
  projectId?: string
  sessionId?: string
  scope?: FieldMemoryScope
  scopeId?: string
  status?: FieldMemoryStatus
  statuses?: FieldMemoryStatus[]
  includeUserScope?: boolean
  limit?: number
}

export interface FieldMemoryPageUpdate {
  title?: string
  bodyMarkdown?: string
  kind?: FieldMemoryKind
  entities?: FieldMemoryEntity[]
  rawRefs?: FieldMemoryRawRef[]
  retrievalHints?: string[]
}

export interface FieldMemoryProposalCreate extends FieldMemoryPageUpdate {
  scope: FieldMemoryScope
  scopeId: string
  projectId?: string | null
  worktreeId?: string | null
  sessionId?: string | null
  episodeId?: string | null
  commandTraceId?: string | null
  kind: FieldMemoryKind
  title: string
  bodyMarkdown: string
  entities?: FieldMemoryEntity[]
  rawRefs: FieldMemoryRawRef[]
  retrievalHints?: string[]
  source: string
  proposedBy?: string
  proposalReason?: string | null
}

export interface FieldMemoryRetrievedPage {
  page: FieldMemoryPageRecord
  retrievalReason: string
  score: number
}
