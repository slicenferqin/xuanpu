/**
 * Agent tool-event emit helper — Phase 21.5.
 *
 * Bridges runtime adapter observations (Claude Code / Codex / OpenCode) into
 * the unified field_events stream. Each adapter is responsible for
 * normalizing its own SDK-specific payload shape into `AgentToolObservation`;
 * this module owns:
 *   - sub-agent skip (V1: parent_tool_use_id non-null → no-op)
 *   - tool-name → event-type routing (4 categories)
 *   - glob pattern guard (never let "** /*.ts" leak into a path field)
 *   - bash output privacy gate (`isBashOutputCaptureEnabled`)
 *
 * Failure mode: silent. Caller must not rely on emission for correctness.
 *
 * See docs/prd/phase-21.5-agent-tool-events-v2.md
 */
import path from 'node:path'
import { emitFieldEvent } from './emit'
import { isBashOutputCaptureEnabled } from './privacy'

/** Tools that read a single concrete file. */
const READ_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'NotebookRead',
  'file_read'
])

/** Tools that mutate a single concrete file. */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch'
])

/** Tools that search by pattern (no concrete file). */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['Glob', 'Grep'])

/** Tools that execute shell commands. */
const BASH_TOOLS: ReadonlySet<string> = new Set(['Bash', 'exec_command'])

const COMMAND_MAX = 512
const PATTERN_MAX = 512
const STDOUT_MAX = 1024
const STDERR_MAX = 1024

export interface AgentToolObservation {
  /** Worktree the agent is acting in. */
  worktreeId: string | null
  projectId: string | null
  /** Hive sessions.id (preferred) or runtime session id — caller resolves. */
  sessionId: string | null
  /** Worktree absolute path; used to resolve absolute file paths to relative. */
  worktreePath: string

  /** SDK tool name (Read / Edit / Bash / Glob / ...). */
  toolName: string
  /** SDK tool-use id (Claude block.id / Codex item.id / OpenCode part id). */
  toolUseId: string
  /**
   * If this tool call was made BY a sub-agent (e.g. Claude Code Task tool),
   * the parent tool_use id. V1: non-null → emit is skipped entirely.
   */
  parentToolUseId?: string | null

  /** Raw input dict from the SDK tool call (file_path / pattern / command). */
  input: Record<string, unknown>

  /** Optional output observations — fields populated when known. */
  output?: {
    /** Tool output text (truncated downstream by category-specific limit). */
    text?: string
    /** Stderr (Bash only). */
    error?: string
    /** Exit code (Bash only). */
    exitCode?: number
    /** Wall-clock duration in ms (Bash only, when measured). */
    durationMs?: number
    /** Match count (Glob/Grep only, when reported by SDK). */
    matchCount?: number
  }
}

/**
 * Emit a normalized agent tool event into the field_events stream.
 *
 * Returns the emitted event id, or `null` when the call was skipped
 * (sub-agent, unknown tool, missing required field, glob-string guard).
 *
 * Never throws.
 */
export function emitAgentToolEvent(obs: AgentToolObservation): string | null {
  // V1: skip nested sub-agent tool calls entirely. The user's mental model is
  // "the session I'm watching" → only outermost tool_use ids count.
  if (obs.parentToolUseId) return null

  const { toolName, input, output, worktreePath, toolUseId } = obs
  if (!toolUseId) return null
  if (!toolName) return null

  const baseEnvelope = {
    worktreeId: obs.worktreeId,
    projectId: obs.projectId,
    sessionId: obs.sessionId,
    relatedEventId: null as string | null
  }

  // ─── Bash ────────────────────────────────────────────────────────────────
  if (BASH_TOOLS.has(toolName)) {
    const captureOutput = isBashOutputCaptureEnabled()
    return emitFieldEvent({
      type: 'agent.bash_exec',
      ...baseEnvelope,
      payload: {
        toolUseId,
        toolName,
        command: stringField(input.command, COMMAND_MAX),
        exitCode: numberOrNull(output?.exitCode),
        durationMs: numberOrNull(output?.durationMs),
        stdoutHead: captureOutput ? sliceHead(output?.text, STDOUT_MAX) : null,
        stderrTail: captureOutput ? sliceTail(output?.error, STDERR_MAX) : null
      }
    })
  }

  // ─── Search (Glob / Grep) ────────────────────────────────────────────────
  if (SEARCH_TOOLS.has(toolName)) {
    const pattern = stringField(input.pattern ?? input.path, PATTERN_MAX)
    if (!pattern) return null
    return emitFieldEvent({
      type: 'agent.file_search',
      ...baseEnvelope,
      payload: {
        toolUseId,
        toolName,
        pattern,
        matchCount: numberOrNull(output?.matchCount)
      }
    })
  }

  // ─── Read / Write (single concrete file) ─────────────────────────────────
  const isRead = READ_TOOLS.has(toolName)
  const isWrite = WRITE_TOOLS.has(toolName)
  if (!isRead && !isWrite) {
    // Unknown tool name — safer to no-op than to miscategorize.
    return null
  }

  const rawPath = (input.file_path ?? input.path ?? '') as unknown
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null

  // Guard: if a search tool's pattern accidentally reaches here (or a
  // future tool sends a glob in `path`), bail rather than letting the
  // pattern pollute hot_files / Current Focus.
  if (rawPath.includes('*') || rawPath.includes('?')) return null

  const relPath = path.isAbsolute(rawPath)
    ? path.relative(worktreePath, rawPath)
    : rawPath

  if (isRead) {
    return emitFieldEvent({
      type: 'agent.file_read',
      ...baseEnvelope,
      payload: {
        toolUseId,
        toolName,
        path: relPath,
        bytes: typeof output?.text === 'string' ? output.text.length : null
      }
    })
  }

  // isWrite
  return emitFieldEvent({
    type: 'agent.file_write',
    ...baseEnvelope,
    payload: {
      toolUseId,
      toolName,
      path: relPath,
      operation: 'edit'
    }
  })
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function stringField(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  return v.length > max ? v.slice(0, max) : v
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function sliceHead(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.length === 0) return null
  return v.length > max ? v.slice(0, max) : v
}

function sliceTail(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.length === 0) return null
  return v.length > max ? v.slice(-max) : v
}

// ─── Test-only re-exports ──────────────────────────────────────────────────

export const __TEST_TOOL_SETS = {
  READ_TOOLS,
  WRITE_TOOLS,
  SEARCH_TOOLS,
  BASH_TOOLS
}
