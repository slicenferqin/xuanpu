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
  | 'terminal.command'
  | 'session.message'

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
// Discriminated union
// ---------------------------------------------------------------------------

export type FieldEvent =
  | (FieldEventEnvelope & { type: 'worktree.switch'; payload: WorktreeSwitchPayload })
  | (FieldEventEnvelope & { type: 'terminal.command'; payload: TerminalCommandPayload })
  | (FieldEventEnvelope & { type: 'session.message'; payload: SessionMessagePayload })

/**
 * Renderer-side input for the narrow `field:reportWorktreeSwitch` IPC channel.
 * Other event types are emitted from main directly and do not need this shape.
 */
export interface WorktreeSwitchInput {
  fromWorktreeId: string | null
  toWorktreeId: string
  trigger: WorktreeSwitchTrigger
}
