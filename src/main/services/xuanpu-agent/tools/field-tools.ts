/**
 * Scoped field tools for xuanpu-agent M6.
 *
 * Xuanpu-owned, read-only, controlled field tool surface.
 * These tools expose XFP field context data without requiring external MCP.
 *
 * Tools:
 *   xfp_get_current_focus     — current file focus and selection
 *   xfp_get_last_terminal     — last terminal command and output
 *   xfp_get_recent_activity   — recent field events
 *   xfp_get_worktree_summary  — worktree metadata and context
 *   xfp_get_pinned_facts      — pinned facts for the worktree
 */
import type { AgentTool, AgentToolResult, AgentToolContext } from '@oh-my-pi/pi-agent-core'
import { basename } from 'path'

// Lazy imports to avoid Electron app dependency at module load time
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any
let _getDb: (() => unknown) | null = null
let _getSink: (() => { flushNow: () => Promise<void> }) | null = null
let _getEvents: AnyFn | null = null
let _getPinned: AnyFn | null = null

async function ensureImports() {
  if (!_getDb) {
    const dbMod = await import('../../../db')
    _getDb = dbMod.getDatabase
  }
  if (!_getSink) {
    const sinkMod = await import('../../../field/sink')
    _getSink = sinkMod.getFieldEventSink
  }
  if (!_getEvents) {
    const repoMod = await import('../../../field/repository')
    _getEvents = repoMod.getRecentFieldEvents
  }
  if (!_getPinned) {
    const pinnedMod = await import('../../../field/pinned-facts-repository')
    _getPinned = pinnedMod.getPinnedFacts
  }
}

type JsonSchema<T> = Record<string, unknown> & { static: T }

// ───────────────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────────────

function resolveWorktreePath(ctx?: AgentToolContext): string {
  const record = ctx as Record<string, unknown> | undefined
  if (record && typeof record.worktreePath === 'string') return record.worktreePath
  return process.cwd()
}

function textResult(text: string): AgentToolResult {
  return { content: [{ type: 'text', text }] }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

// ───────────────────────────────────────────────────────────────────────────
// xfp_get_current_focus
// ───────────────────────────────────────────────────────────────────────────

const xfpGetCurrentFocusParams = {
  type: 'object',
  additionalProperties: false,
  properties: {},
  required: []
} satisfies JsonSchema<Record<string, never>>

export const xfpGetCurrentFocusTool: AgentTool<typeof xfpGetCurrentFocusParams> = {
  name: 'xfp_get_current_focus',
  label: 'Get Current Focus',
  description: 'Get the currently focused file and text selection in the IDE',
  parameters: xfpGetCurrentFocusParams,
  intent: 'omit',
  concurrency: 'shared',
  async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
    await ensureImports()
    const worktreePath = resolveWorktreePath(ctx)
    const db = _getDb!()
    const worktree = db.getWorktreeByPath(worktreePath)

    if (!worktree) {
      return textResult('No worktree found for current path.')
    }

    try {
      await _getSink!().flushNow()
    } catch {
      // Ignore flush errors
    }

    const events = _getEvents!({
      worktreeId: worktree.id,
      since: Date.now() - 5 * 60_000,
      limit: 500,
      order: 'asc'
    })

    let focusFile: { path: string; name: string } | null = null
    let focusSelection: { path: string; fromLine: number; toLine: number; length: number } | null =
      null

    for (const e of events) {
      if (e.type === 'file.open' || e.type === 'file.focus') {
        const p = e.payload as { path?: string; name?: string }
        if (typeof p?.path === 'string') {
          focusFile = { path: p.path, name: typeof p.name === 'string' ? p.name : basename(p.path) }
        }
      } else if (e.type === 'file.selection') {
        const p = e.payload as { path?: string; fromLine?: number; toLine?: number; length?: number }
        if (
          typeof p?.path === 'string' &&
          typeof p?.fromLine === 'number' &&
          typeof p?.toLine === 'number' &&
          typeof p?.length === 'number'
        ) {
          focusSelection = { path: p.path, fromLine: p.fromLine, toLine: p.toLine, length: p.length }
        }
      }
    }

    if (focusSelection && focusFile && focusSelection.path !== focusFile.path) {
      focusFile = { path: focusSelection.path, name: basename(focusSelection.path) }
    }

    const lines: string[] = ['## Current Focus']

    if (focusFile) {
      lines.push(`**File:** \`${focusFile.path}\``)
    } else {
      lines.push('**File:** None (no recent file focus detected)')
    }

    if (focusSelection) {
      lines.push(`**Selection:** Lines ${focusSelection.fromLine}-${focusSelection.toLine} (${focusSelection.length} chars)`)
    }

    return textResult(lines.join('\n'))
  }
}

// ───────────────────────────────────────────────────────────────────────────
// xfp_get_last_terminal
// ───────────────────────────────────────────────────────────────────────────

const xfpGetLastTerminalParams = {
  type: 'object',
  additionalProperties: false,
  properties: {},
  required: []
} satisfies JsonSchema<Record<string, never>>

export const xfpGetLastTerminalTool: AgentTool<typeof xfpGetLastTerminalParams> = {
  name: 'xfp_get_last_terminal',
  label: 'Get Last Terminal Activity',
  description: 'Get the most recent terminal command and its output',
  parameters: xfpGetLastTerminalParams,
  intent: 'omit',
  concurrency: 'shared',
  async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
    await ensureImports()
    const worktreePath = resolveWorktreePath(ctx)
    const db = _getDb!()
    const worktree = db.getWorktreeByPath(worktreePath)

    if (!worktree) {
      return textResult('No worktree found for current path.')
    }

    try {
      await _getSink!().flushNow()
    } catch {
      // Ignore flush errors
    }

    const events = _getEvents!({
      worktreeId: worktree.id,
      since: Date.now() - 5 * 60_000,
      limit: 500,
      order: 'asc'
    })

    let lastCommand: { command: string; timestamp: number; id: string } | null = null
    let relatedOutput: { head: string; tail: string; exitCode: number | null; truncated: boolean } | null =
      null

    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'terminal.command') {
        const p = events[i].payload as { command?: string }
        if (typeof p?.command === 'string') {
          lastCommand = { command: p.command, timestamp: events[i].timestamp, id: events[i].id }
          break
        }
      }
    }

    if (lastCommand) {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i]
        if (e.type === 'terminal.output' && e.relatedEventId === lastCommand.id) {
          const p = e.payload as {
            head?: string
            tail?: string
            truncated?: boolean
            exitCode?: number | null
          }
          relatedOutput = {
            head: typeof p?.head === 'string' ? p.head : '',
            tail: typeof p?.tail === 'string' ? p.tail : '',
            truncated: !!p?.truncated,
            exitCode: typeof p?.exitCode === 'number' ? p.exitCode : null
          }
          break
        }
      }
    }

    const lines: string[] = ['## Last Terminal Activity']

    if (!lastCommand) {
      lines.push('No recent terminal commands detected.')
      return textResult(lines.join('\n'))
    }

    const timeAgo = Math.round((Date.now() - lastCommand.timestamp) / 1000)
    lines.push(`**Command:** \`${lastCommand.command}\``)
    lines.push(`**Time:** ${timeAgo}s ago`)

    if (relatedOutput) {
      const exitStr = relatedOutput.exitCode != null ? `exit ${relatedOutput.exitCode}` : 'still running'
      lines.push(`**Status:** ${exitStr}`)

      if (relatedOutput.head) {
        lines.push('\n**Output (head):**')
        lines.push('```')
        lines.push(truncate(relatedOutput.head, 1000))
        lines.push('```')
      }

      if (relatedOutput.tail && relatedOutput.tail !== relatedOutput.head) {
        lines.push('\n**Output (tail):**')
        lines.push('```')
        lines.push(truncate(relatedOutput.tail, 1000))
        lines.push('```')
      }

      if (relatedOutput.truncated) {
        lines.push('\n*(Output was truncated)*')
      }
    } else {
      lines.push('**Output:** No captured output')
    }

    return textResult(lines.join('\n'))
  }
}

// ───────────────────────────────────────────────────────────────────────────
// xfp_get_recent_activity
// ───────────────────────────────────────────────────────────────────────────

const xfpGetRecentActivityParams = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Maximum number of activity entries to return (default: 20)'
    }
  },
  required: []
} satisfies JsonSchema<{ limit?: number }>

export const xfpGetRecentActivityTool: AgentTool<typeof xfpGetRecentActivityParams> = {
  name: 'xfp_get_recent_activity',
  label: 'Get Recent Activity',
  description: 'Get recent field events (file operations, terminal commands, etc.)',
  parameters: xfpGetRecentActivityParams,
  intent: 'omit',
  concurrency: 'shared',
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    await ensureImports()
    const worktreePath = resolveWorktreePath(ctx)
    const db = _getDb!()
    const worktree = db.getWorktreeByPath(worktreePath)

    if (!worktree) {
      return textResult('No worktree found for current path.')
    }

    try {
      await _getSink!().flushNow()
    } catch {
      // Ignore flush errors
    }

    const limit = params.limit ?? 20
    const events = _getEvents!({
      worktreeId: worktree.id,
      since: Date.now() - 5 * 60_000,
      limit: 200,
      order: 'asc'
    })

    const recentEvents = events.slice(-limit)

    const lines: string[] = ['## Recent Activity']

    if (recentEvents.length === 0) {
      lines.push('No recent activity detected.')
      return textResult(lines.join('\n'))
    }

    for (const e of recentEvents) {
      const timeAgo = Math.round((Date.now() - e.timestamp) / 1000)
      let summary = ''

      switch (e.type) {
        case 'file.open': {
          const p = e.payload as { name?: string; path?: string }
          summary = `opened \`${p?.name ?? p?.path ?? ''}\``
          break
        }
        case 'file.focus': {
          const p = e.payload as { name?: string; path?: string }
          summary = `focused \`${p?.name ?? p?.path ?? ''}\``
          break
        }
        case 'file.selection': {
          const p = e.payload as { path?: string; fromLine?: number; toLine?: number }
          const name = p?.path ? basename(p.path) : ''
          summary = `selected lines ${p?.fromLine}-${p?.toLine} in \`${name}\``
          break
        }
        case 'terminal.command': {
          const p = e.payload as { command?: string }
          summary = `ran \`${truncate(p?.command ?? '', 60)}\``
          break
        }
        case 'terminal.output': {
          const p = e.payload as { exitCode?: number | null; totalBytes?: number }
          const exit = p?.exitCode != null ? `exit ${p.exitCode}` : 'running'
          summary = `terminal output (${p?.totalBytes ?? 0}B, ${exit})`
          break
        }
        case 'session.message': {
          const p = e.payload as { agentSdk?: string; text?: string }
          const sdk = p?.agentSdk ? `(${p.agentSdk}) ` : ''
          summary = `${sdk}message: "${truncate(p?.text ?? '', 50)}"`
          break
        }
        case 'agent.file_read': {
          const p = e.payload as { path?: string }
          summary = `agent read \`${basename(p?.path ?? '')}\``
          break
        }
        case 'agent.file_write': {
          const p = e.payload as { path?: string }
          summary = `agent wrote \`${basename(p?.path ?? '')}\``
          break
        }
        case 'agent.file_search': {
          const p = e.payload as { pattern?: string; matchCount?: number | null }
          const mc = typeof p?.matchCount === 'number' ? ` → ${p.matchCount} matches` : ''
          summary = `agent searched \`${p?.pattern ?? ''}\`${mc}`
          break
        }
        case 'agent.bash_exec': {
          const p = e.payload as { command?: string; exitCode?: number | null }
          const exit = p?.exitCode != null ? ` (exit ${p.exitCode})` : ''
          summary = `agent ran \`${truncate(p?.command ?? '', 50)}\`${exit}`
          break
        }
        default:
          summary = e.type
      }

      lines.push(`- [${timeAgo}s ago] ${summary}`)
    }

    return textResult(lines.join('\n'))
  }
}

// ───────────────────────────────────────────────────────────────────────────
// xfp_get_worktree_summary
// ───────────────────────────────────────────────────────────────────────────

const xfpGetWorktreeSummaryParams = {
  type: 'object',
  additionalProperties: false,
  properties: {},
  required: []
} satisfies JsonSchema<Record<string, never>>

export const xfpGetWorktreeSummaryTool: AgentTool<typeof xfpGetWorktreeSummaryParams> = {
  name: 'xfp_get_worktree_summary',
  label: 'Get Worktree Summary',
  description: 'Get worktree metadata, branch info, and context notes',
  parameters: xfpGetWorktreeSummaryParams,
  intent: 'omit',
  concurrency: 'shared',
  async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
    await ensureImports()
    const worktreePath = resolveWorktreePath(ctx)
    const db = _getDb!()
    const worktree = db.getWorktreeByPath(worktreePath)

    if (!worktree) {
      return textResult('No worktree found for current path.')
    }

    const lines: string[] = ['## Worktree Summary']

    lines.push(`**Name:** ${worktree.name}`)
    lines.push(`**Path:** \`${worktree.path}\``)

    if (worktree.branch_name) {
      lines.push(`**Branch:** \`${worktree.branch_name}\``)
    }

    if (worktree.github_pr_number) {
      lines.push(`**PR:** #${worktree.github_pr_number}`)
      if (worktree.github_pr_url) {
        lines.push(`**PR URL:** ${worktree.github_pr_url}`)
      }
    }

    if (worktree.context) {
      lines.push('\n**Context Notes:**')
      lines.push(worktree.context)
    }

    const episodicMemory = db.getEpisodicMemory(worktree.id)
    if (episodicMemory) {
      lines.push('\n**Episodic Memory:**')
      lines.push(truncate(episodicMemory.summaryMarkdown, 500))
    }

    return textResult(lines.join('\n'))
  }
}

// ───────────────────────────────────────────────────────────────────────────
// xfp_get_pinned_facts
// ───────────────────────────────────────────────────────────────────────────

const xfpGetPinnedFactsParams = {
  type: 'object',
  additionalProperties: false,
  properties: {},
  required: []
} satisfies JsonSchema<Record<string, never>>

export const xfpGetPinnedFactsTool: AgentTool<typeof xfpGetPinnedFactsParams> = {
  name: 'xfp_get_pinned_facts',
  label: 'Get Pinned Facts',
  description: 'Get pinned facts and notes for the current worktree',
  parameters: xfpGetPinnedFactsParams,
  intent: 'omit',
  concurrency: 'shared',
  async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
    await ensureImports()
    const worktreePath = resolveWorktreePath(ctx)
    const db = _getDb!()
    const worktree = db.getWorktreeByPath(worktreePath)

    if (!worktree) {
      return textResult('No worktree found for current path.')
    }

    const pinnedFacts = _getPinned!(worktree.id)

    const lines: string[] = ['## Pinned Facts']

    if (!pinnedFacts || pinnedFacts.contentMd.trim().length === 0) {
      lines.push('No pinned facts for this worktree.')
      return textResult(lines.join('\n'))
    }

    const updatedAt = new Date(pinnedFacts.updatedAt).toLocaleString()
    lines.push(`*Last updated: ${updatedAt}*\n`)
    lines.push(pinnedFacts.contentMd)

    return textResult(lines.join('\n'))
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Exports
// ───────────────────────────────────────────────────────────────────────────

export const XFP_FIELD_TOOLS: AgentTool[] = [
  xfpGetCurrentFocusTool,
  xfpGetLastTerminalTool,
  xfpGetRecentActivityTool,
  xfpGetWorktreeSummaryTool,
  xfpGetPinnedFactsTool
]
