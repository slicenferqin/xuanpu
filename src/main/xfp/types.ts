export interface XfpScope {
  worktreeId: string
  sessionId?: string
}

export interface XfpWorktreeRef {
  id: string
  name: string
  branchName: string | null
  path: string | null
}

export interface XfpFocusFile {
  path: string
  name: string
}

export interface XfpSelection {
  path: string
  fromLine: number
  toLine: number
  length: number
  textPreview?: string
}

export interface XfpCurrentFocus {
  disabled: boolean
  asOf: number | null
  worktree: XfpWorktreeRef | null
  file: XfpFocusFile | null
  selection: XfpSelection | null
}

export type XfpTerminalOutputMode = 'none' | 'tail' | 'head_tail'

export interface XfpTerminalInput extends XfpScope {
  includeOutput?: XfpTerminalOutputMode
  maxChars?: number
}

export interface XfpTerminalActivity {
  command: string
  commandAt: number
  exitCode: number | null
  output?: {
    head?: string
    tail?: string
    truncated: boolean
  }
}

export interface XfpRecentActivityInput extends XfpScope {
  windowMs?: number
  limit?: number
  types?: string[]
}

export interface XfpActivityEntry {
  timestamp: number
  type: string
  summary: string
}

export type XfpWorktreeSummarySource = 'checkpoint' | 'episodic' | 'checkpoint+episodic'

export interface XfpWorktreeSummary {
  markdown: string
  compactedAt: number
  source: XfpWorktreeSummarySource
  warnings: string[]
}

export interface XfpPinnedFacts {
  markdown: string
  updatedAt: number
}

export interface XfpProvider {
  getCurrentFocus(input: XfpScope): Promise<XfpCurrentFocus>
  getLastTerminalActivity(input: XfpTerminalInput): Promise<XfpTerminalActivity | null>
  getRecentActivity(input: XfpRecentActivityInput): Promise<XfpActivityEntry[]>
  getWorktreeSummary(input: XfpScope): Promise<XfpWorktreeSummary | null>
  getPinnedFacts(input: XfpScope): Promise<XfpPinnedFacts | null>
}
