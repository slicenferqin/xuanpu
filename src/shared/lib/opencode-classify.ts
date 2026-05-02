/**
 * OpenCode tool classification — shared between the live event mapper
 * (main process: src/main/services/opencode-service.ts) and the durable
 * timeline mapper (src/shared/lib/timeline-mappers.ts).
 *
 * OpenCode's SDK emits tool parts on `message.part.updated` events. Each tool
 * part has the shape:
 *
 *   { type: 'tool', callID, tool: '<lowercase-name>', state: { status, input, output, error, time } }
 *
 * The xuanpu UI uses canonical tool names (Bash / Read / Edit / Grep / Glob /
 * Write / WebSearch / WebFetch / TodoWrite / Task / McpTool / Unknown) so a
 * single set of cards can render any runtime's output. OpenCode's native names
 * are lowercase ('bash', 'read', ...). MCP tools follow various conventions
 * but typically include a server segment.
 *
 * This module does ONE thing: take an OpenCode tool name (with optional
 * companion data) and return a canonical classification:
 *
 *   { tool: CanonicalToolName, toolDisplay?: string, mcpServer?: string }
 *
 * The streaming pipeline (opencode-service.ts) and the durable read path
 * (timeline-mappers.mapPartToStreamingPart) MUST use this same classifier so
 * the same item renders identically in both modes.
 *
 * Returning `tool: 'Unknown'` signals an unrecognized tool — UI falls back to
 * FallbackToolView.
 */
import type { CanonicalToolName } from '../types/agent-protocol'

export interface ClassifiedOpenCodeTool {
  tool: CanonicalToolName
  /** Original (un-normalized) name; preserved for display and fallback lookups. */
  toolDisplay?: string
  /** Server segment when the tool is an MCP-routed call. */
  mcpServer?: string
}

/**
 * Map of OpenCode native lowercase tool names → CanonicalToolName.
 *
 * Add new entries here when OpenCode's SDK introduces a new built-in tool.
 * MCP tools are NOT listed here — they are detected via prefix/separator and
 * fall through to the McpTool branch.
 */
const OPENCODE_NATIVE_TOOLS: Record<string, CanonicalToolName> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  multiedit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  list: 'Glob',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  todowrite: 'TodoWrite',
  task: 'Task',
  // Phase 1.4.8 (OpenCode AskUserQuestion parity): OpenCode wraps the
  // `question.asked` HITL request in a tool part named `question`. Without
  // this entry it would fall through to `Unknown`, AgentTimeline would not
  // recognise it as the AskUser card type, and the question UI would never
  // render even though the input bar correctly switches into reply mode.
  // Aligns with codex-implementer.ts which emits 'AskUserQuestion' directly.
  question: 'AskUserQuestion',
  askuserquestion: 'AskUserQuestion',
  ask_user: 'AskUserQuestion'
}

/**
 * Heuristic for MCP-routed tools. OpenCode surfaces MCP tools with names that
 * usually contain an underscore separator between the server and tool, and
 * sometimes a leading `mcp_` / `mcp__` prefix.
 *
 * Examples seen in the wild:
 *   - mcp_figma_get_file
 *   - mcp__hive-lsp__lsp
 *   - context7_query-docs
 *
 * We deliberately do NOT classify simple snake_case native names like
 * `read_file` as MCP — those are claude-code shaped and are handled by the
 * ToolCard renderer's case-insensitive fallback.
 */
function isLikelyMcpTool(rawName: string): boolean {
  if (rawName.startsWith('mcp_') || rawName.startsWith('mcp__')) return true
  // Multi-segment names with explicit double-underscore are MCP-shaped
  if (rawName.includes('__')) return true
  return false
}

function extractMcpServer(rawName: string): string | undefined {
  // Strip leading mcp_ / mcp__
  const stripped = rawName.replace(/^mcp__?/, '')
  // Prefer double-underscore separator (claude-code MCP convention)
  if (stripped.includes('__')) {
    const [server] = stripped.split('__')
    return server || undefined
  }
  // Fall back to first underscore segment
  if (stripped.includes('_')) {
    const [server] = stripped.split('_')
    return server || undefined
  }
  return undefined
}

/**
 * Classify a raw OpenCode tool name into a canonical record.
 *
 * Inputs:
 *   - rawName: the value of `part.tool` from a `message.part.updated` event.
 *
 * Returns a `ClassifiedOpenCodeTool`. Always returns a value (never null) —
 * unrecognized names map to `{ tool: 'Unknown', toolDisplay: rawName }`.
 */
export function classifyOpenCodeTool(rawName: unknown): ClassifiedOpenCodeTool {
  if (typeof rawName !== 'string' || rawName.length === 0) {
    return { tool: 'Unknown' }
  }

  const lower = rawName.toLowerCase()

  // 1. Native built-in tools — exact (case-insensitive) match against the map.
  const native = OPENCODE_NATIVE_TOOLS[lower]
  if (native) {
    return { tool: native, toolDisplay: rawName }
  }

  // 2. MCP-routed tools — detected via prefix/separator.
  if (isLikelyMcpTool(rawName)) {
    const server = extractMcpServer(rawName)
    return {
      tool: 'McpTool',
      toolDisplay: rawName,
      ...(server ? { mcpServer: server } : {})
    }
  }

  // 3. Unknown — pass through with original display name.
  return { tool: 'Unknown', toolDisplay: rawName }
}
