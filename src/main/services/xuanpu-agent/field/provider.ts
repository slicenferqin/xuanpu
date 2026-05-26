/**
 * FieldProvider — 解耦 harness 与 IDE/CLI 基础设施。
 *
 * IDE 内嵌模式：IdeFieldProvider（SQLite + field events + GitService）
 * 独立 CLI 模式：CliFieldProvider（simple-git + cwd + 文件存储）
 *
 * 两者的 harness 层完全复用，只在 FieldProvider 的实现上分叉。
 */
import type { XfpFieldPacket, XfpGitState } from '../xfp/types'
import type { XuanpuPiPromptMessage } from '../context-transform'

// ───────────────────────────────────────────────────────────────────────────
// Data types (不依赖 IDE DB 类型)
// ───────────────────────────────────────────────────────────────────────────

export interface FieldWorktree {
  id: string
  name: string
  path: string
  context: string | null
  projectId: string
}

export interface FieldSession {
  id: string
  projectId: string
}

export interface FieldTurn {
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export interface FieldEpisode {
  id: string
  title: string | null
  summaryMarkdown: string
  tokenEstimate: number
  createdAt: number
  sessionId?: string | null
  keyFacts?: string[]
  constraints?: string[]
  files?: string[]
  commands?: string[]
  failures?: string[]
}

export interface FieldContextSnapshot {
  /** Compact markdown summary of current field state. */
  markdown: string | null
  /** Approximate token count of the rendered markdown. */
  approxTokens: number
  /** Whether the rendered markdown was truncated to fit budget. */
  wasTruncated: boolean
  /** Unix-ms timestamp of the snapshot. */
  capturedAt: number
}

export interface FieldEpisodeRetrieval {
  /** Episodes matched by gated retrieval for this turn. */
  included: FieldEpisode[]
  /** How many candidate episodes were dropped. */
  dropped: number
  /** Which triggers fired (e.g. "keyword:上次", "path:src/auth.ts"). */
  triggers: string[]
}

// ───────────────────────────────────────────────────────────────────────────
// Context package (audit/debug record — cross-runtime compatible)
// ───────────────────────────────────────────────────────────────────────────

export interface FieldContextPackageSection {
  id: string
  kind: string
  title: string
  included: boolean
  approxTokens: number
  source: string
  reason?: string
  metadata?: Record<string, unknown>
}

export interface FieldContextPackage {
  id: string
  sessionId: string
  worktreeId: string
  runtimeId: string
  modelProviderId: string | null
  modelId: string | null
  budgetProfile: string
  approxTokens: number
  sections: FieldContextPackageSection[]
  renderedMarkdown: string | null
  decisions: Record<string, unknown>
}

// ───────────────────────────────────────────────────────────────────────────
// Provider interface
// ───────────────────────────────────────────────────────────────────────────

export interface FieldProvider {
  // ── Read: 现场数据 ──

  /** Resolve worktree metadata from a filesystem path. */
  getWorktree(path: string): FieldWorktree | null

  /** Get the session record. */
  getSession(sessionId: string): FieldSession | null

  /** Get prior conversation turns (user + assistant). */
  getPriorTurns(sessionId: string): FieldTurn[]

  /** Build the current field context snapshot. */
  buildFieldSnapshot(worktree: FieldWorktree): Promise<FieldContextSnapshot>

  /** Get all episode block candidates for this worktree + session. */
  getEpisodeCandidates(worktreeId: string, sessionId: string): FieldEpisode[]

  /** Run gated retrieval over episode candidates. */
  retrieveEpisodes(
    userText: string,
    candidates: FieldEpisode[],
    priorTurns: FieldTurn[],
    currentSessionId: string
  ): FieldEpisodeRetrieval

  // ── Write: 持久化 ──

  /** Persist a user or assistant message. */
  persistMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    meta?: {
      messageId?: string
      modelProviderId?: string
      modelId?: string
      usage?: Record<string, unknown>
      rawMessage?: unknown
    }
  ): void

  /** Record a context package for audit/debug. */
  persistContextPackage(pkg: FieldContextPackage): void

  /** Freeze old conversation turns into an episode block. */
  freezeEpisodes(worktreeId: string, sessionId: string): void

  // ── Lifecycle ──

  /** Mark the start of a session run (for status tracking). */
  beginRun(sessionId: string): void
}

// ───────────────────────────────────────────────────────────────────────────
// Turn context — assembled result of a single prompt turn
// ───────────────────────────────────────────────────────────────────────────

export interface FieldTurnContext {
  /** The assembled prompt messages ready for the agent. */
  messages: XuanpuPiPromptMessage[]
  /** Compiled XFP packet. */
  packet: XfpFieldPacket
  /** Git state used in the packet. */
  gitState: XfpGitState
  /** Field context snapshot. */
  fieldSnapshot: FieldContextSnapshot
  /** Retrieved episodes for this turn. */
  episodeRetrieval: FieldEpisodeRetrieval
  /** Context package ID (for linking back in audit trail). */
  contextPackageId: string | null
}
