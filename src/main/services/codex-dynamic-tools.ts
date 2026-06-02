import { runBashWithCompression } from './token-saver'
import { asNumber, asObject, asString } from './codex-utils'
import {
  createXfpClaudeMcpToolHandlers,
  XFP_CLAUDE_ALLOWED_TOOLS,
  XFP_CLAUDE_MCP_SERVER_NAME
} from '../xfp/claude-mcp-server'

export const CODEX_XUANPU_BASH_TOOL_NAME = 'mcp__xuanpu__bash'

export interface CodexDynamicToolSpec {
  namespace?: string
  name: string
  description: string
  inputSchema: unknown
  deferLoading?: boolean
}

export interface CodexDynamicToolConfig {
  sessionId: string
  defaultCwd: string
  tokenSaverEnabled?: boolean
  xfpWorktreeId?: string | null
  logger?: { warn(msg: string, meta?: Record<string, unknown>): void }
}

export interface CodexDynamicToolCall {
  namespace?: string | null
  tool?: string
  arguments?: unknown
}

export interface CodexDynamicToolCallResponse {
  contentItems: Array<{ type: 'inputText'; text: string }>
  success: boolean
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false
  }
}

function textResponse(text: string, success = true): CodexDynamicToolCallResponse {
  return {
    success,
    contentItems: [{ type: 'inputText', text }]
  }
}

function normalizeToolName(call: CodexDynamicToolCall): string {
  const tool = call.tool ?? ''
  const namespace = call.namespace?.trim()
  if (!namespace) return tool
  if (namespace === 'xuanpu' && tool === 'bash') return CODEX_XUANPU_BASH_TOOL_NAME
  if (namespace === XFP_CLAUDE_MCP_SERVER_NAME && tool.startsWith('xfp_')) {
    return `mcp__${XFP_CLAUDE_MCP_SERVER_NAME}__${tool}`
  }
  return `${namespace}.${tool}`
}

export function buildCodexDynamicToolSpecs(
  config: CodexDynamicToolConfig
): CodexDynamicToolSpec[] {
  const tools: CodexDynamicToolSpec[] = []

  if (config.tokenSaverEnabled) {
    tools.push({
      name: CODEX_XUANPU_BASH_TOOL_NAME,
      description: [
        'Execute a shell command in the current Xuanpu worktree.',
        'This is the Xuanpu Token Saver bash tool: long stdout/stderr is compressed before',
        'it reaches the model, while the original output is archived locally.',
        'Use this instead of native shell execution when available.'
      ].join(' '),
      inputSchema: objectSchema(
        {
          command: {
            type: 'string',
            description: 'The shell command to execute'
          },
          timeout: {
            type: 'number',
            description: 'Optional timeout in milliseconds, capped by Xuanpu'
          },
          description: {
            type: 'string',
            description: 'Short description of what this command does'
          }
        },
        ['command']
      )
    })
  }

  if (config.xfpWorktreeId) {
    tools.push(
      {
        name: 'mcp__xuanpu-field__xfp_get_current_focus',
        description:
          'Get the current Xuanpu editor focus: worktree, focused file, selected range, and text preview.',
        inputSchema: objectSchema({})
      },
      {
        name: 'mcp__xuanpu-field__xfp_get_last_terminal_activity',
        description:
          'Get the latest Xuanpu terminal command metadata and optional bounded output. Defaults to tail output.',
        inputSchema: objectSchema({
          includeOutput: {
            type: 'string',
            enum: ['none', 'tail', 'head_tail'],
            description: 'Whether to include no output, terminal tail, or split head/tail output'
          },
          maxChars: {
            type: 'number',
            description: 'Maximum output characters to return'
          }
        })
      },
      {
        name: 'mcp__xuanpu-field__xfp_get_recent_activity',
        description:
          'Get recent Xuanpu field activity for this worktree, optionally filtered by event types.',
        inputSchema: objectSchema({
          limit: {
            type: 'number',
            description: 'Maximum entries to return'
          },
          windowMs: {
            type: 'number',
            description: 'Lookback window in milliseconds'
          },
          types: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional activity event type filters'
          }
        })
      },
      {
        name: 'mcp__xuanpu-field__xfp_get_worktree_summary',
        description: 'Get the compact worktree/session resume summary from Xuanpu field memory.',
        inputSchema: objectSchema({})
      },
      {
        name: 'mcp__xuanpu-field__xfp_get_pinned_facts',
        description: 'Get user-pinned durable facts for the current Xuanpu worktree.',
        inputSchema: objectSchema({})
      }
    )
  }

  return tools
}

function normalizeArgs(value: unknown): Record<string, unknown> {
  return asObject(value) ?? {}
}

async function callBash(
  config: CodexDynamicToolConfig,
  args: Record<string, unknown>
): Promise<CodexDynamicToolCallResponse> {
  const command = asString(args.command)
  if (!command?.trim()) {
    return textResponse('[xuanpu-tools] command is required', false)
  }

  const timeoutMs = asNumber(args.timeout) ?? asNumber(args.timeoutMs)
  try {
    const { text } = await runBashWithCompression(
      { command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
      {
        sessionId: config.sessionId,
        defaultCwd: config.defaultCwd,
        logger: config.logger
      }
    )
    return textResponse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    config.logger?.warn?.('Codex dynamic bash tool failed', { error: message })
    return textResponse(`[xuanpu-tools] internal error: ${message}`, false)
  }
}

async function callXfp(
  config: CodexDynamicToolConfig,
  toolName: string,
  args: Record<string, unknown>
): Promise<CodexDynamicToolCallResponse | null> {
  if (!config.xfpWorktreeId || !XFP_CLAUDE_ALLOWED_TOOLS.includes(toolName)) return null

  const localToolName = toolName.slice(`mcp__${XFP_CLAUDE_MCP_SERVER_NAME}__`.length)
  const handlers = createXfpClaudeMcpToolHandlers({
    worktreeId: config.xfpWorktreeId,
    sessionId: config.sessionId,
    runtimeId: 'codex',
    logger: config.logger
  })
  const handler = handlers[localToolName]
  if (!handler) return null

  const result = await handler(args)
  const text = result.content.map((item) => item.text).join('\n')
  return textResponse(text, result.isError !== true)
}

export async function handleCodexDynamicToolCall(
  config: CodexDynamicToolConfig | undefined,
  call: CodexDynamicToolCall
): Promise<CodexDynamicToolCallResponse | null> {
  if (!config) return null

  const toolName = normalizeToolName(call)
  const args = normalizeArgs(call.arguments)

  if (toolName === CODEX_XUANPU_BASH_TOOL_NAME && config.tokenSaverEnabled) {
    return callBash(config, args)
  }

  return callXfp(config, toolName, args)
}
