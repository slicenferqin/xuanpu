/**
 * XFP (Xuanpu Field Protocol) v1 — packet TypeScript contract.
 *
 * Source: docs/plans/2026-05-24-xuanpu-agent-1.5.0-context-native-harness.zh-CN.md
 * Review: docs/plans/2026-05-24-xuanpu-agent-1.5.0-plan-review.md (AI-4, version field)
 *
 * XFP is the structured packet Xuanpu hands to xuanpu-agent every turn.
 * It is NOT a prompt prefix. It is a versioned, validated, source-anchored
 * snapshot of the field.
 *
 * v1 rules (vs. v2):
 *   - v1 captures WHAT + SOURCE REFS only.
 *   - v1 does NOT capture WHY-included / WHY-omitted (deferred to v2 when
 *     Context Budget rendering is mature — see plan-review AI-4).
 *   - v1 has an explicit `version: 1` literal so v2 can be detected at runtime.
 *
 * Cache stability annotations on each section JSDoc reflect the partition
 * for prefix-cache reuse:
 *   - stable    -> safe to put in prompt prefix; survives many turns
 *   - volatile  -> changes between turns; goes into append-only log section
 *   - mixed     -> per-field decision; the packet compiler partitions at
 *                  compile time
 *
 * Reuse policy: this file re-uses shared types from `src/shared/types/` where
 * they exist. New types here exist only when the shared types are not strict
 * enough (e.g. dirty-state derivation is needed at packet compile time).
 */

import type { GitFileStatus } from '@shared/types/git'

// ---------------------------------------------------------------------------
// Raw refs — every non-trivial field can attach raw refs so the user can
// audit and re-open the original artifact. "Summary without refs is lore;
// summary with refs is memory."
// ---------------------------------------------------------------------------

export type XfpRawRefKind =
  | 'file'
  | 'command-trace'
  | 'terminal-output'
  | 'git-object'
  | 'message'
  | 'episode'
  | 'memory-page'
  | 'checkpoint'

/**
 * Pointer to an artifact stored elsewhere (SQLite row, file on disk,
 * episode block, message id). The packet carries the pointer; the
 * consumer fetches if it needs the bytes.
 */
export interface XfpRawRef {
  kind: XfpRawRefKind
  /** Stable identifier resolvable in Xuanpu (db row id, abs file path, episode id, etc.). */
  id: string
  /** Optional short excerpt (head/tail) shown inline to the model. */
  excerpt?: string
  /** Optional byte range into the underlying artifact for the excerpt. */
  byteRange?: [number, number]
  /** Optional opaque pointer metadata for the consumer (e.g. line range, sha). */
  meta?: Record<string, string | number | boolean | null>
}

// ---------------------------------------------------------------------------
// Section 1: Identity (project / worktree / session / packet id / timestamp)
// @cacheStability stable
// ---------------------------------------------------------------------------

export interface XfpIdentitySection {
  /** Stable per-packet id (UUID v4) — referenced in audit trail. */
  packetId: string
  /** Unix ms, main-process clock. */
  capturedAt: number
  projectId: string
  worktreeId: string
  /**
   * sessions.id; null when the packet is compiled outside a chat session
   * (e.g. checkpoint compilation, headless dogfood probe).
   */
  sessionId: string | null
}

// ---------------------------------------------------------------------------
// Section 2: Git state (branch, HEAD, dirty, upstream)
// @cacheStability volatile
//
// Derived at packet compile time by reading git-service. We intentionally
// do NOT reuse the shared `GitBranchInfo` here because v1 packets always
// require these fields (shared type allows partial branches in other
// IPC contexts). `dirtyFiles` is a bounded preview — for the full list
// see the rawRefs entry of kind 'git-object'.
// ---------------------------------------------------------------------------

export interface XfpGitState {
  branchName: string
  /** Short HEAD sha (7-char) — full sha lives in rawRefs.meta. */
  headShort: string
  upstream: string | null
  ahead: number
  behind: number
  /** True iff working tree has unstaged or staged changes. */
  dirty: boolean
  /**
   * Bounded preview of dirty files (max 20). Full status lives behind
   * a rawRefs[] entry. Truncation is signalled by `dirtyTruncated`.
   */
  dirtyFiles: GitFileStatus[]
  dirtyTruncated: boolean
  rawRefs: XfpRawRef[]
}

// ---------------------------------------------------------------------------
// Section 3: Current focus (file + selection)
// @cacheStability volatile
// ---------------------------------------------------------------------------

export interface XfpFocusFile {
  /** Absolute path; matches FileViewerStore convention. */
  path: string
  /** Basename, precomputed. */
  name: string
}

export interface XfpFocusSelection {
  path: string
  /** 1-indexed line bounds. */
  fromLine: number
  toLine: number
  /** Character count of the selected text. */
  length: number
}

export interface XfpFocusSection {
  file: XfpFocusFile | null
  selection: XfpFocusSelection | null
  rawRefs: XfpRawRef[]
}

// ---------------------------------------------------------------------------
// Section 4: Terminal & test summaries
// @cacheStability volatile
//
// Raw output is NEVER inlined. We carry head/tail excerpts plus a rawRef
// pointer to the full trace artifact (see plan-review §Command Trace Storage:
// raw bytes -> files, structured row -> SQLite).
// ---------------------------------------------------------------------------

export interface XfpTerminalSummary {
  /** The submitted command line (trimmed). */
  command: string
  /** Unix ms when the command was submitted. */
  commandAt: number
  /** Shell if known (bash / zsh / fish / ...). */
  shell: string | null
  /** Working directory at submit time. */
  cwd: string | null
  exitCode: number | null
  /** Wall-clock duration in ms, if the process exited within the window. */
  durationMs: number | null
  /** First N lines of stdout/stderr (combined). */
  outputHead: string
  /** Last M lines of stdout/stderr (combined). Empty when the whole output fit in head. */
  outputTail: string
  /** True when middle was elided between head and tail. */
  truncated: boolean
  /** Total bytes of pre-truncation output. */
  totalBytes: number
  rawRefs: XfpRawRef[]
}

export type XfpTestStatus = 'pass' | 'fail' | 'mixed' | 'unknown'

export interface XfpTestSummary {
  status: XfpTestStatus
  /** Last test runner detected (vitest / playwright / jest / ...). */
  runner: string | null
  passed: number | null
  failed: number | null
  skipped: number | null
  /**
   * Up to ~10 short failure excerpts. Each entry should include the failing
   * file path and 1–3 lines of the error. The complete output lives in rawRefs.
   */
  failureExcerpts: string[]
  rawRefs: XfpRawRef[]
}

// ---------------------------------------------------------------------------
// Section 5: Command trace summary (recent N command traces)
// @cacheStability mixed
//
// This is the "history" view: a roll-up of the last few non-current commands
// the user (or a tool) ran in this worktree. Distinct from XfpTerminalSummary,
// which is the SINGLE most-recent terminal command.
// ---------------------------------------------------------------------------

export interface XfpCommandTraceEntry {
  /** UUID of the underlying command_traces row. */
  traceId: string
  command: string
  capturedAt: number
  exitCode: number | null
  durationMs: number | null
  /** Compression ratio: 0..1 (1 = raw, 0 = fully elided). */
  compressionRatio: number | null
  /** One-line summary produced by the compression profile. */
  summary: string
  rawRefs: XfpRawRef[]
}

export interface XfpCommandTraceSection {
  entries: XfpCommandTraceEntry[]
  /** Total traces available in the window (entries.length may be capped). */
  totalAvailable: number
}

// ---------------------------------------------------------------------------
// Section 6: Current task goal (what the user is actively asking for)
// @cacheStability volatile
//
// Distinct from the model-managed AgentSessionGoalState — this is the
// session-level interpretation of the active user request.
// ---------------------------------------------------------------------------

export interface XfpTaskGoal {
  /** User's stated objective in 1–3 sentences. May be heuristic. */
  objective: string
  /** Source: 'user-message' = directly from latest user text, 'checkpoint' = restored, 'heuristic' = inferred. */
  source: 'user-message' | 'checkpoint' | 'heuristic'
  /** Optional success criteria the user spelled out. */
  successCriteria: string | null
  rawRefs: XfpRawRef[]
}

// ---------------------------------------------------------------------------
// Section 7: Context budget (what the compiler decided to include / drop)
// @cacheStability mixed
//
// v1 records totals, included sections, and omitted-section names. v1 does
// NOT record per-section "why" — that's a v2 deliverable (plan-review AI-4).
// ---------------------------------------------------------------------------

export type XfpBudgetProfile = 'focused' | 'balanced' | 'extended'

export interface XfpBudgetSection {
  profile: XfpBudgetProfile
  /** Maximum tokens the compiler was allowed to spend. */
  budgetTokens: number
  /** Estimated tokens used by sections actually included in this packet. */
  estimatedTokens: number
  /**
   * Names of XFP sections that were considered but omitted from this packet.
   * String enum kept loose for v1 — we don't know all future section names.
   * v2 will add per-name omission reason.
   */
  omittedSectionNames: string[]
  /** Aggregate compression ratio over volatile sections; null when no compression was applied. */
  compressionRatio: number | null
}

// ---------------------------------------------------------------------------
// Section 8: Anchor (pinned facts, project rules, stable protocol)
// @cacheStability stable
//
// Re-uses FieldContextSnapshot.pinnedFacts shape (see field-context.ts),
// but XFP narrows it to the markdown body + last updated stamp.
// ---------------------------------------------------------------------------

export interface XfpAnchorSection {
  /** Pinned-facts markdown body; null when the user has not authored any. */
  pinnedFactsMarkdown: string | null
  /** Worktree notes (worktrees.context column). */
  worktreeNotesMarkdown: string | null
  /** Unix ms of the most recent edit to any anchor source. */
  updatedAt: number | null
  rawRefs: XfpRawRef[]
}

// ---------------------------------------------------------------------------
// XFP Field Packet — v1 top-level structure
// ---------------------------------------------------------------------------

/**
 * Versioned packet handed from Xuanpu to xuanpu-agent every turn.
 *
 * @invariant version === 1 for all v1 packets; v2 will set version === 2.
 * @invariant identity, gitState, focus, currentGoal are REQUIRED.
 * @invariant terminal, tests, commandTrace, anchor MAY be null when no
 *            relevant signal exists for this packet.
 */
export interface XfpFieldPacket {
  version: 1
  identity: XfpIdentitySection
  anchor: XfpAnchorSection | null
  gitState: XfpGitState
  focus: XfpFocusSection
  terminal: XfpTerminalSummary | null
  tests: XfpTestSummary | null
  commandTrace: XfpCommandTraceSection | null
  currentGoal: XfpTaskGoal
  budget: XfpBudgetSection
}

// ---------------------------------------------------------------------------
// MinimalFieldPacket — CLI-mode subset
// ---------------------------------------------------------------------------

/**
 * Structurally narrower packet used by the 1.7.0 standalone CLI mode where
 * Xuanpu's main process (with its SQLite + worktree manager) is NOT running.
 *
 * Not strictly a `Pick<>` of XfpFieldPacket: identity drops worktreeId/
 * sessionId/projectId (replaced by cwd), and git state is optional because
 * cwd may not be inside a repo.
 *
 * Conversion: use `narrowToMinimal()` in `./schema.ts` to derive a
 * MinimalFieldPacket from a full XfpFieldPacket.
 *
 * @cacheStability mixed — same partition as XfpFieldPacket but smaller surface.
 */
export interface MinimalFieldPacket {
  version: 1
  /** packetId + capturedAt; no project/worktree/session ids. */
  identity: {
    packetId: string
    capturedAt: number
  }
  /** Absolute path the CLI was invoked from. Replaces worktree.path. */
  cwd: string
  /** Optional stdin payload (file content piped in). */
  stdin: {
    path: string | null
    /** Bounded excerpt; full content stays at the rawRef. */
    excerpt: string
    rawRefs: XfpRawRef[]
  } | null
  /** Git state IFF cwd is inside a git repo. Same fields as XfpGitState. */
  gitState: XfpGitState | null
  currentGoal: XfpTaskGoal
}
