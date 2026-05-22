import { getDatabase } from '../db'
import { buildFieldContextSnapshot } from '../field/context-builder'
import type {
  FieldContextSnapshot,
  FieldContextTerminalOutput,
  ResumedCheckpointBlock
} from '../../shared/types'
import type {
  XfpActivityEntry,
  XfpCurrentFocus,
  XfpPinnedFacts,
  XfpProvider,
  XfpRecentActivityInput,
  XfpScope,
  XfpTerminalActivity,
  XfpTerminalInput,
  XfpTerminalOutputMode,
  XfpWorktreeRef,
  XfpWorktreeSummary,
  XfpWorktreeSummarySource
} from './types'

export const XFP_DEFAULT_RECENT_WINDOW_MS = 5 * 60_000
export const XFP_DEFAULT_RECENT_LIMIT = 10
export const XFP_MAX_RECENT_LIMIT = 100
export const XFP_DEFAULT_TERMINAL_MAX_CHARS = 4_000
export const XFP_TERMINAL_MAX_CHARS = 12_000

type BuildSnapshot = typeof buildFieldContextSnapshot

export interface XfpProviderOptions {
  buildSnapshot?: BuildSnapshot
  getWorktreePath?: (worktreeId: string) => string | null
}

export function createXfpProvider(options: XfpProviderOptions = {}): XfpProvider {
  const buildSnapshot = options.buildSnapshot ?? buildFieldContextSnapshot
  const getWorktreePath = options.getWorktreePath ?? readWorktreePath

  return {
    async getCurrentFocus(input: XfpScope): Promise<XfpCurrentFocus> {
      const snapshot = await buildSnapshot({ worktreeId: input.worktreeId })
      if (!snapshot) return emptyCurrentFocus(true)

      return {
        disabled: false,
        asOf: snapshot.asOf,
        worktree: toWorktreeRef(snapshot, getWorktreePath),
        file: snapshot.focus.file,
        selection: snapshot.focus.selection
      }
    },

    async getLastTerminalActivity(input: XfpTerminalInput): Promise<XfpTerminalActivity | null> {
      const snapshot = await buildSnapshot({ worktreeId: input.worktreeId })
      if (!snapshot?.lastTerminal) return null

      const terminal = snapshot.lastTerminal
      const includeOutput = input.includeOutput ?? 'tail'
      const activity: XfpTerminalActivity = {
        command: terminal.command,
        commandAt: terminal.commandAt,
        exitCode: terminal.output?.exitCode ?? null
      }

      const output = shapeTerminalOutput(terminal.output, includeOutput, input.maxChars)
      if (output) activity.output = output
      return activity
    },

    async getRecentActivity(input: XfpRecentActivityInput): Promise<XfpActivityEntry[]> {
      const limit = normalizeLimit(input.limit, XFP_DEFAULT_RECENT_LIMIT, XFP_MAX_RECENT_LIMIT)
      const windowMs = normalizePositiveInteger(input.windowMs, XFP_DEFAULT_RECENT_WINDOW_MS)
      const snapshot = await buildSnapshot({
        worktreeId: input.worktreeId,
        windowMs,
        maxActivity: input.types?.length ? XFP_MAX_RECENT_LIMIT : limit
      })
      if (!snapshot) return []

      const typeSet = input.types?.length ? new Set(input.types) : null
      const entries = typeSet
        ? snapshot.recentActivity.filter((entry) => typeSet.has(entry.type))
        : snapshot.recentActivity

      return entries.slice(-limit).map((entry) => ({
        timestamp: entry.timestamp,
        type: entry.type,
        summary: entry.summary
      }))
    },

    async getWorktreeSummary(input: XfpScope): Promise<XfpWorktreeSummary | null> {
      const snapshot = await buildSnapshot({ worktreeId: input.worktreeId })
      if (!snapshot) return null

      return toWorktreeSummary(snapshot)
    },

    async getPinnedFacts(input: XfpScope): Promise<XfpPinnedFacts | null> {
      const snapshot = await buildSnapshot({ worktreeId: input.worktreeId })
      if (!snapshot?.pinnedFacts) return null

      return {
        markdown: snapshot.pinnedFacts.contentMd,
        updatedAt: snapshot.pinnedFacts.updatedAt
      }
    }
  }
}

export const xfpProvider = createXfpProvider()

function emptyCurrentFocus(disabled: boolean): XfpCurrentFocus {
  return {
    disabled,
    asOf: null,
    worktree: null,
    file: null,
    selection: null
  }
}

function toWorktreeRef(
  snapshot: FieldContextSnapshot,
  getWorktreePath: (worktreeId: string) => string | null
): XfpWorktreeRef | null {
  if (!snapshot.worktree) return null

  return {
    id: snapshot.worktree.id,
    name: snapshot.worktree.name,
    branchName: snapshot.worktree.branchName,
    path: getWorktreePath(snapshot.worktree.id)
  }
}

function readWorktreePath(worktreeId: string): string | null {
  try {
    return getDatabase().getWorktree(worktreeId)?.path ?? null
  } catch {
    return null
  }
}

function shapeTerminalOutput(
  output: FieldContextTerminalOutput | null,
  includeOutput: XfpTerminalOutputMode,
  requestedMaxChars: number | undefined
): XfpTerminalActivity['output'] | undefined {
  if (!output || includeOutput === 'none') return undefined

  const maxChars = normalizeLimit(
    requestedMaxChars,
    XFP_DEFAULT_TERMINAL_MAX_CHARS,
    XFP_TERMINAL_MAX_CHARS
  )

  if (includeOutput === 'tail') {
    const source = output.tail.length > 0 ? output.tail : output.head
    const clipped = takeTail(source, maxChars)
    return {
      tail: clipped.value,
      truncated: output.truncated || clipped.truncated
    }
  }

  return shapeHeadTailOutput(output.head, output.tail, output.truncated, maxChars)
}

function shapeHeadTailOutput(
  storedHead: string,
  storedTail: string,
  storedTruncated: boolean,
  maxChars: number
): XfpTerminalActivity['output'] {
  if (!storedTruncated && storedTail.length === 0) {
    if (storedHead.length <= maxChars) {
      return {
        head: storedHead,
        truncated: false
      }
    }

    const headBudget = Math.ceil(maxChars / 2)
    const tailBudget = maxChars - headBudget
    const result: XfpTerminalActivity['output'] = {
      head: storedHead.slice(0, headBudget),
      truncated: true
    }
    if (tailBudget > 0) result.tail = storedHead.slice(-tailBudget)
    return result
  }

  const headBudget = Math.ceil(maxChars / 2)
  const tailBudget = maxChars - headBudget
  const head = takeHead(storedHead, headBudget)
  const tail = takeTail(storedTail, tailBudget)
  const result: XfpTerminalActivity['output'] = {
    truncated: storedTruncated || head.truncated || tail.truncated
  }
  if (head.value.length > 0) result.head = head.value
  if (tail.value.length > 0) result.tail = tail.value
  return result
}

function toWorktreeSummary(snapshot: FieldContextSnapshot): XfpWorktreeSummary | null {
  const sections: string[] = []
  const warnings: string[] = []
  let compactedAt = 0
  let source: XfpWorktreeSummarySource | null = null

  if (snapshot.checkpoint) {
    sections.push(renderCheckpoint(snapshot.checkpoint))
    warnings.push(...snapshot.checkpoint.warnings)
    compactedAt = Math.max(compactedAt, snapshot.checkpoint.createdAt)
    source = 'checkpoint'
  }

  if (snapshot.episodicSummary) {
    sections.push(snapshot.episodicSummary.markdown)
    compactedAt = Math.max(compactedAt, snapshot.episodicSummary.compactedAt)
    source = source ? 'checkpoint+episodic' : 'episodic'
  }

  if (!source) return null

  return {
    markdown: sections.join('\n\n').trim(),
    compactedAt,
    source,
    warnings
  }
}

function renderCheckpoint(checkpoint: ResumedCheckpointBlock): string {
  const lines = [
    '## Resumed Work State',
    checkpoint.summary,
    checkpoint.currentGoal ? `- Current goal (heuristic): ${checkpoint.currentGoal}` : null,
    checkpoint.nextAction ? `- Next action (heuristic): ${checkpoint.nextAction}` : null,
    checkpoint.blockingReason ? `- Blocking reason: ${checkpoint.blockingReason}` : null,
    checkpoint.hotFiles.length > 0 ? `- Hot files: ${checkpoint.hotFiles.join(', ')}` : null
  ].filter((line): line is string => typeof line === 'string' && line.length > 0)

  return lines.join('\n')
}

function normalizeLimit(value: number | undefined, fallback: number, upperBound: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(Math.floor(value), upperBound))
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(value))
}

function takeHead(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (maxChars <= 0) return { value: '', truncated: value.length > 0 }
  if (value.length <= maxChars) return { value, truncated: false }
  return { value: value.slice(0, maxChars), truncated: true }
}

function takeTail(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (maxChars <= 0) return { value: '', truncated: value.length > 0 }
  if (value.length <= maxChars) return { value, truncated: false }
  return { value: value.slice(-maxChars), truncated: true }
}
