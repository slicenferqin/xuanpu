/**
 * Field Event Stream — Phase 21 type definitions.
 *
 * A FieldEvent is a structured record of a user action observed by the main
 * process. Events are persisted to the SQLite `field_events` table and consumed
 * by the Phase 22 memory layer / Phase 23 Agent input injection.
 *
 * See docs/prd/phase-21-field-events.md for the full design.
 */

export type FieldEventType =
  | 'worktree.switch'
  | 'file.open'
  | 'file.focus'
  | 'file.selection'
  | 'terminal.command'
  | 'terminal.output'
  | 'session.message'
  | 'agent.file_read'
  | 'agent.file_write'
  | 'agent.file_search'
  | 'agent.bash_exec'

/**
 * Common envelope shared by all field events.
 *
 * `id` is a stable UUID (used for cross-process correlation and dedup).
 * `seq` is assigned by SQLite AUTOINCREMENT on insert; it gives a stable
 * total order even when multiple events share a millisecond.
 */
export interface FieldEventEnvelope {
  /** UUID v4, generated at emit time. */
  id: string
  /** Unix ms, main-process clock at emit time. */
  timestamp: number
  /** worktrees.id; NULL for global events. */
  worktreeId: string | null
  /** projects.id; resolved from worktreeId at emit time for cheap grouping. */
  projectId: string | null
  /** sessions.id; only set for session-scoped events. */
  sessionId: string | null
  /** Optional first-class correlation (e.g. command -> output, message -> reply). */
  relatedEventId: string | null
  type: FieldEventType
}

// ---------------------------------------------------------------------------
// Per-type payloads
// ---------------------------------------------------------------------------

export type WorktreeSwitchTrigger = 'user-click' | 'keyboard' | 'store-restore' | 'unknown'

export interface WorktreeSwitchPayload {
  fromWorktreeId: string | null
  toWorktreeId: string
  trigger: WorktreeSwitchTrigger
}

export interface TerminalCommandPayload {
  /** The command line the user submitted (trimmed, no trailing CR). */
  command: string
  /** PTY shell if known (bash/zsh/fish/...). */
  shell?: string
  /** Working directory at submit time, if known. */
  cwd?: string
}

export interface TerminalOutputPayload {
  /**
   * If the window can be correlated to a prior terminal.command event for the
   * same worktree, its id is stored here. Best-effort only — no correlation
   * guarantees are made.
   */
  commandEventId: string | null
  /** Head of the window (first N lines). */
  head: string
  /** Tail of the window (last M lines). Empty if the whole output fit in head. */
  tail: string
  /** True if middle was elided between head and tail. */
  truncated: boolean
  /** Total bytes observed during this window (pre-truncation). */
  totalBytes: number
  /** Exit code if the process exited during the window; else null. */
  exitCode: number | null
  /** Why the window closed: 'size' | 'time' | 'next-command' | 'exit' | 'destroy'. */
  reason: 'size' | 'time' | 'next-command' | 'exit' | 'destroy'
}

export interface FileOpenPayload {
  /** Absolute path (matches what the FileViewerStore stores). */
  path: string
  /** Just the basename, precomputed so dumps don't have to split. */
  name: string
}

export interface FileFocusPayload {
  path: string
  name: string
  /** Previous active file path at the moment of focus change, if any. */
  fromPath: string | null
}

export interface FileSelectionPayload {
  path: string
  /** 1-indexed. Line of the anchor (where selection started). */
  fromLine: number
  /** 1-indexed. Line of the head (where caret is now). Equal to fromLine for caret-only movements; those are dropped upstream. */
  toLine: number
  /** Character count of the selected text. Useful for filtering caret-only moves if they slip through. */
  length: number
}

export type SessionMessageAgentSdk = 'opencode' | 'claude-code' | 'codex'

export interface SessionMessagePayload {
  agentSdk: SessionMessageAgentSdk
  agentSessionId: string
  /** Text preview of user message (truncated to 1KB). */
  text: string
  attachmentCount: number
  modelOverride?: { providerID: string; modelID: string; variant?: string }
}

// ---------------------------------------------------------------------------
// Agent tool events (Phase 21.5)
//
// Captured when a runtime adapter (Claude Code / Codex / OpenCode) observes
// a tool_use → tool_result completion. Lets fully-delegated users (where the
// agent does all reads/edits/commands) populate hot_files, Current Focus,
// and the Phase 24C session checkpoint.
//
// Sub-agent / Task-tool nested events are SKIPPED at emit time (V1) — only
// outermost-session tool calls are captured.
//
// `toolUseId` is mandatory in every payload as a join key for future
// Outcome Loop attribution (e.g. linking a test_pass back to the bash
// command that triggered it).
// ---------------------------------------------------------------------------

export interface AgentFileReadPayload {
  /** Tool-use id from the SDK (Claude block.id / Codex item.id / OpenCode part id). */
  toolUseId: string
  /** Tool name as reported by the SDK (Read / NotebookRead / file_read). */
  toolName: string
  /** Path relative to the worktree root. Never a glob — Glob/Grep emit `agent.file_search` instead. */
  path: string
  /** Bytes returned by the read, if known. */
  bytes: number | null
}

export interface AgentFileWritePayload {
  toolUseId: string
  toolName: string
  path: string
  /**
   * V1: always 'edit'. Future Outcome Loop may refine to
   * 'create' | 'edit' | 'delete' once file-existed-before detection is
   * implemented. Single-value union is forward-compatible.
   */
  operation: 'edit'
}

export interface AgentFileSearchPayload {
  toolUseId: string
  toolName: string
  /** The glob/regex pattern as given to the tool (truncated 512 chars). */
  pattern: string
  /** Number of matches returned, if known. */
  matchCount: number | null
}

export interface AgentBashExecPayload {
  toolUseId: string
  toolName: string
  /** First 512 chars of the command. */
  command: string
  exitCode: number | null
  durationMs: number | null
  /**
   * First 1024 chars of stdout. Only populated when the user has explicitly
   * opted into bash output capture (Settings → Privacy → "Capture Bash
   * stdout/stderr for agent analysis"). Default OFF — bash output frequently
   * contains secrets (API keys, env dumps, error stacks with tokens).
   */
  stdoutHead: string | null
  /** Last 1024 chars of stderr. Same opt-in rule as stdoutHead. */
  stderrTail: string | null
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export type FieldEvent =
  | (FieldEventEnvelope & { type: 'worktree.switch'; payload: WorktreeSwitchPayload })
  | (FieldEventEnvelope & { type: 'file.open'; payload: FileOpenPayload })
  | (FieldEventEnvelope & { type: 'file.focus'; payload: FileFocusPayload })
  | (FieldEventEnvelope & { type: 'file.selection'; payload: FileSelectionPayload })
  | (FieldEventEnvelope & { type: 'terminal.command'; payload: TerminalCommandPayload })
  | (FieldEventEnvelope & { type: 'terminal.output'; payload: TerminalOutputPayload })
  | (FieldEventEnvelope & { type: 'session.message'; payload: SessionMessagePayload })
  | (FieldEventEnvelope & { type: 'agent.file_read'; payload: AgentFileReadPayload })
  | (FieldEventEnvelope & { type: 'agent.file_write'; payload: AgentFileWritePayload })
  | (FieldEventEnvelope & { type: 'agent.file_search'; payload: AgentFileSearchPayload })
  | (FieldEventEnvelope & { type: 'agent.bash_exec'; payload: AgentBashExecPayload })

/**
 * Renderer-side input for the narrow `field:reportWorktreeSwitch` IPC channel.
 * Other event types are emitted from main directly and do not need this shape.
 */
export interface WorktreeSwitchInput {
  fromWorktreeId: string | null
  toWorktreeId: string
  trigger: WorktreeSwitchTrigger
}

/** Renderer-side input for `field:reportFileOpen`. */
export interface FileOpenInput {
  worktreeId: string
  path: string
  name: string
}

/** Renderer-side input for `field:reportFileFocus`. */
export interface FileFocusInput {
  worktreeId: string
  path: string
  name: string
  fromPath: string | null
}

/** Renderer-side input for `field:reportFileSelection`. */
export interface FileSelectionInput {
  worktreeId: string
  path: string
  fromLine: number
  toLine: number
  length: number
}
