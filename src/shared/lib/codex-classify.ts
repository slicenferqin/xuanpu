/**
 * Codex item classification — shared between the live event mapper
 * (main process) and the durable timeline mapper (renderer).
 *
 * Codex's app-server emits items in 7 shapes (commandExecution, fileChange,
 * webSearch, mcpToolCall, agentMessage, reasoning, userMessage). The xuanpu
 * UI uses canonical tool names (Bash / Read / Edit / Grep / WebSearch /
 * McpTool / TodoWrite / Unknown) so a single set of cards can render any
 * runtime's output.
 *
 * This module does ONE thing: take a raw codex item record and produce
 * `{ tool, input?, output?, mcpServer?, toolDisplay?, result? }` suitable
 * for a `ToolPart`. The streaming pipeline (codex-event-mapper.ts) and the
 * durable read path (timeline-mappers.parseToolPartFromActivity) MUST use
 * this same classifier so the same item renders identically in both modes.
 *
 * Returning `null` signals "not a tool" (agentMessage / reasoning /
 * userMessage are handled as text/reasoning parts elsewhere).
 */
import type { CanonicalToolName } from '../types/agent-protocol'

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

export interface ClassifiedCodexItem {
  tool: CanonicalToolName
  input?: Record<string, unknown>
  output?: string
  mcpServer?: string
  toolDisplay?: string
  result?: unknown
}

interface ClassifyCommandResult {
  tool: CanonicalToolName
  input: Record<string, unknown>
}

function classifyCommand(item: Record<string, unknown>): ClassifyCommandResult {
  const actions = Array.isArray(item.commandActions) ? (item.commandActions as unknown[]) : []
  const command = asString(item.command) ?? ''
  const cwd = asString(item.cwd)

  if (actions.length === 1) {
    const action = asObject(actions[0])
    const type = asString(action?.type)
    if (type === 'read') {
      const path = asString(action!.path) ?? ''
      const name = asString(action!.name)
      return {
        tool: 'Read',
        input: { file_path: path, ...(name ? { displayName: name } : {}) }
      }
    }
    if (type === 'search') {
      const pattern = asString(action!.query) ?? asString(action!.pattern) ?? ''
      const path = asString(action!.path)
      return {
        tool: 'Grep',
        input: { pattern, ...(path ? { path } : {}) }
      }
    }
  }

  return {
    tool: 'Bash',
    input: {
      command,
      ...(cwd ? { cwd } : {}),
      ...(actions.length > 0 ? { actions } : {})
    }
  }
}

export function classifyCodexItem(item: Record<string, unknown>): ClassifiedCodexItem | null {
  const itemType = asString(item.type)
  switch (itemType) {
    case 'commandExecution': {
      const { tool, input } = classifyCommand(item)
      const output = asString(item.aggregatedOutput)
      return {
        tool,
        input,
        ...(output !== undefined ? { output } : {})
      }
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      const input: Record<string, unknown> = { changes }
      if (changes.length === 1) {
        const c = asObject(changes[0])
        const p = asString(c?.path)
        if (p) input.file_path = p
        const d = asString(c?.diff)
        if (d) input.diff = d
      }
      return { tool: 'Edit', input }
    }
    case 'webSearch': {
      const action = asObject(item.action)
      const queries = Array.isArray(action?.queries) ? (action!.queries as string[]) : undefined
      const query =
        asString(item.query) ??
        asString(action?.query) ??
        (queries && queries.length > 0 ? queries[0] : undefined)
      const input: Record<string, unknown> = {}
      if (query) input.query = query
      if (queries && queries.length > 0) input.queries = queries
      return {
        tool: 'WebSearch',
        ...(Object.keys(input).length > 0 ? { input } : {})
      }
    }
    case 'mcpToolCall': {
      const server = asString(item.server)
      const toolDisplay = asString(item.tool)
      const args = item.arguments
      const input: Record<string, unknown> = {}
      if (args !== undefined) input.arguments = args
      return {
        tool: 'McpTool',
        ...(server ? { mcpServer: server } : {}),
        ...(toolDisplay ? { toolDisplay } : {}),
        ...(Object.keys(input).length > 0 ? { input } : {}),
        ...(item.result !== undefined ? { result: item.result } : {})
      }
    }
    case 'agentMessage':
    case 'reasoning':
    case 'userMessage':
      return null
    default:
      return {
        tool: 'Unknown',
        ...(itemType ? { toolDisplay: itemType } : {})
      }
  }
}
