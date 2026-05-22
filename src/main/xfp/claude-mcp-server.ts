import {
  XFP_DEFAULT_RECENT_LIMIT,
  XFP_DEFAULT_RECENT_WINDOW_MS,
  XFP_DEFAULT_TERMINAL_MAX_CHARS,
  XFP_TERMINAL_MAX_CHARS
} from './provider'
import { xfpProvider } from './provider'
import {
  hasXfpTruncatedOutput,
  inferXfpAuditPrivacy,
  recordXfpAuditEvent,
  summarizeXfpAuditOutput
} from './audit'
import type {
  XfpProvider,
  XfpRecentActivityInput,
  XfpScope,
  XfpTerminalInput,
  XfpTerminalOutputMode
} from './types'

export interface XfpClaudeMcpContext {
  worktreeId: string
  sessionId?: string
  provider?: XfpProvider
  logger?: { warn(msg: string, meta?: Record<string, unknown>): void }
}

export interface XfpMcpToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

type XfpToolHandler = (args: Record<string, unknown>) => Promise<XfpMcpToolResult>
type XfpClaudeMcpToolName =
  | 'xfp_get_current_focus'
  | 'xfp_get_last_terminal_activity'
  | 'xfp_get_recent_activity'
  | 'xfp_get_worktree_summary'
  | 'xfp_get_pinned_facts'

export const XFP_CLAUDE_MCP_SERVER_NAME = 'xuanpu-field'

export const XFP_CLAUDE_MCP_TOOL_NAMES: XfpClaudeMcpToolName[] = [
  'xfp_get_current_focus',
  'xfp_get_last_terminal_activity',
  'xfp_get_recent_activity',
  'xfp_get_worktree_summary',
  'xfp_get_pinned_facts'
]

export const XFP_CLAUDE_ALLOWED_TOOLS = XFP_CLAUDE_MCP_TOOL_NAMES.map(
  (toolName) => `mcp__${XFP_CLAUDE_MCP_SERVER_NAME}__${toolName}`
)

const TERMINAL_OUTPUT_MODES = new Set<XfpTerminalOutputMode>(['none', 'tail', 'head_tail'])

function scopeFromContext(ctx: XfpClaudeMcpContext): XfpScope | XfpMcpToolResult {
  if (!isNonEmptyString(ctx.worktreeId)) {
    return errorResult('XFP error: context.worktreeId is required')
  }

  const scope: XfpScope = { worktreeId: ctx.worktreeId }
  if (isNonEmptyString(ctx.sessionId)) scope.sessionId = ctx.sessionId
  return scope
}

function textResult(payload: unknown): XfpMcpToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2)
      }
    ]
  }
}

function errorResult(message: string): XfpMcpToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true
  }
}

function isToolResult(value: XfpScope | XfpMcpToolResult): value is XfpMcpToolResult {
  return 'content' in value
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function optionalPositiveInteger(value: unknown, fallback: number, max?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const normalized = Math.max(1, Math.floor(value))
  return typeof max === 'number' ? Math.min(normalized, max) : normalized
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries = value.filter(isNonEmptyString).map((entry) => entry.trim())
  return entries.length > 0 ? entries : undefined
}

async function runTool(
  ctx: XfpClaudeMcpContext,
  toolName: XfpClaudeMcpToolName,
  args: Record<string, unknown>,
  fn: (provider: XfpProvider, scope: XfpScope) => Promise<unknown>
): Promise<XfpMcpToolResult> {
  const scope = scopeFromContext(ctx)
  if (isToolResult(scope)) return scope

  try {
    const data = await fn(ctx.provider ?? xfpProvider, scope)
    const summary = summarizeXfpAuditOutput(data)
    recordXfpAuditEvent({
      worktreeId: scope.worktreeId,
      sessionId: scope.sessionId ?? null,
      runtimeId: 'claude-code',
      kind: 'tool',
      toolName,
      input: args,
      outputSummary: summary.outputSummary,
      outputChars: summary.outputChars,
      truncated: summary.truncated || hasXfpTruncatedOutput(data),
      privacy: inferXfpAuditPrivacy(data)
    })
    return textResult({
      ok: true,
      tool: toolName,
      data
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    recordXfpAuditEvent({
      worktreeId: scope.worktreeId,
      sessionId: scope.sessionId ?? null,
      runtimeId: 'claude-code',
      kind: 'tool',
      toolName,
      input: args,
      outputSummary: message,
      outputChars: message.length,
      truncated: false,
      privacy: 'allowed'
    })
    ctx.logger?.warn?.('xfp mcp tool failed', {
      tool: toolName,
      error: message
    })
    return errorResult(`XFP error in ${toolName}: ${message}`)
  }
}

/**
 * Build testable handlers for the Claude in-process MCP tools.
 *
 * The handlers return JSON text so the SDK transport remains simple, while the
 * payload preserves the provider's structured data under `data`.
 */
export function createXfpClaudeMcpToolHandlers(
  ctx: XfpClaudeMcpContext
): Record<string, XfpToolHandler> {
  return {
    xfp_get_current_focus: async () =>
      runTool(ctx, 'xfp_get_current_focus', {}, (provider, scope) =>
        provider.getCurrentFocus(scope)
      ),

    xfp_get_last_terminal_activity: async (args) =>
      runTool(ctx, 'xfp_get_last_terminal_activity', args, (provider, scope) => {
        const includeOutput = TERMINAL_OUTPUT_MODES.has(args.includeOutput as XfpTerminalOutputMode)
          ? (args.includeOutput as XfpTerminalOutputMode)
          : 'tail'
        const input: XfpTerminalInput = {
          ...scope,
          includeOutput,
          maxChars: optionalPositiveInteger(
            args.maxChars,
            XFP_DEFAULT_TERMINAL_MAX_CHARS,
            XFP_TERMINAL_MAX_CHARS
          )
        }
        return provider.getLastTerminalActivity(input)
      }),

    xfp_get_recent_activity: async (args) =>
      runTool(ctx, 'xfp_get_recent_activity', args, (provider, scope) => {
        const input: XfpRecentActivityInput = {
          ...scope,
          limit: optionalPositiveInteger(args.limit, XFP_DEFAULT_RECENT_LIMIT),
          windowMs: optionalPositiveInteger(args.windowMs, XFP_DEFAULT_RECENT_WINDOW_MS)
        }
        const types = optionalStringArray(args.types)
        if (types) input.types = types
        return provider.getRecentActivity(input)
      }),

    xfp_get_worktree_summary: async () =>
      runTool(ctx, 'xfp_get_worktree_summary', {}, (provider, scope) =>
        provider.getWorktreeSummary(scope)
      ),

    xfp_get_pinned_facts: async () =>
      runTool(ctx, 'xfp_get_pinned_facts', {}, (provider, scope) => provider.getPinnedFacts(scope))
  }
}

/**
 * Create the Claude Agent SDK in-process MCP server config for XFP.
 *
 * The caller should attach it under XFP_CLAUDE_MCP_SERVER_NAME and allow
 * XFP_CLAUDE_ALLOWED_TOOLS in Claude session options.
 */
export async function createXfpClaudeMcpServerConfig(ctx: XfpClaudeMcpContext): Promise<unknown> {
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
  const { z } = await import('zod')

  const handlers = createXfpClaudeMcpToolHandlers(ctx)
  const scopeHint =
    'Scope is fixed by Xuanpu for this Claude session: current worktreeId and optional sessionId.'

  const tools = [
    tool(
      'xfp_get_current_focus',
      `Get the current Xuanpu editor focus: worktree, focused file, and selected range/text preview. ${scopeHint}`,
      {},
      async (args) => handlers.xfp_get_current_focus(args as Record<string, unknown>),
      { annotations: { readOnly: true } }
    ),
    tool(
      'xfp_get_last_terminal_activity',
      `Get the latest terminal command metadata and optional bounded output. Defaults to tail output. ${scopeHint}`,
      {
        includeOutput: z
          .enum(['none', 'tail', 'head_tail'])
          .optional()
          .describe('Whether to include no output, terminal tail, or split head/tail output'),
        maxChars: z
          .number()
          .optional()
          .describe(
            `Maximum output characters to return; defaults to ${XFP_DEFAULT_TERMINAL_MAX_CHARS}`
          )
      },
      async (args) => handlers.xfp_get_last_terminal_activity(args as Record<string, unknown>),
      { annotations: { readOnly: true } }
    ),
    tool(
      'xfp_get_recent_activity',
      `Get recent Xuanpu field activity for this worktree, optionally filtered by event types. ${scopeHint}`,
      {
        limit: z
          .number()
          .optional()
          .describe(`Maximum entries to return; defaults to ${XFP_DEFAULT_RECENT_LIMIT}`),
        windowMs: z
          .number()
          .optional()
          .describe(`Lookback window in milliseconds; defaults to ${XFP_DEFAULT_RECENT_WINDOW_MS}`),
        types: z.array(z.string()).optional().describe('Optional activity event type filters')
      },
      async (args) => handlers.xfp_get_recent_activity(args as Record<string, unknown>),
      { annotations: { readOnly: true } }
    ),
    tool(
      'xfp_get_worktree_summary',
      `Get the compact worktree/session resume summary from Xuanpu field memory. ${scopeHint}`,
      {},
      async (args) => handlers.xfp_get_worktree_summary(args as Record<string, unknown>),
      { annotations: { readOnly: true } }
    ),
    tool(
      'xfp_get_pinned_facts',
      `Get user-pinned durable facts for the current Xuanpu worktree. ${scopeHint}`,
      {},
      async (args) => handlers.xfp_get_pinned_facts(args as Record<string, unknown>),
      { annotations: { readOnly: true } }
    )
  ]

  return createSdkMcpServer({
    name: XFP_CLAUDE_MCP_SERVER_NAME,
    version: '1.0.0',
    tools
  })
}
