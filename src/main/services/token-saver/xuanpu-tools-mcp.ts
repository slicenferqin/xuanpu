/**
 * Token Saver MCP server — Token Saver stage 2b.
 *
 * Registers a single in-process MCP tool, `bash`, that shadows the SDK's
 * built-in Bash tool when the Token Saver feature is enabled. The tool:
 *
 *   1. Spawns the user's command via `runBashCommand` (timeout / abort / cwd /
 *      env handled, output capped + tee-streamed).
 *   2. Persists the full original output to ContextOffloadStore.
 *   3. Runs the OutputCompressionPipeline over stdout+stderr.
 *   4. Returns a tool result whose text body is the compressed view + a
 *      machine-readable footer pointing the user (not the agent) at the
 *      archive path.
 *
 * The MCP tool name surfaces to the agent as `mcp__xuanpu__bash` (SDK auto-
 * prefixes by server name). The caller is expected to pass
 * `disallowedTools: ['Bash']` so the built-in is suppressed and the agent
 * can only see ours.
 *
 * One server instance is created per session because:
 *   - cwd / sessionId are per-session (closed over here)
 *   - The AbortSignal lifecycle is per-prompt (passed via `extra`)
 *
 * Failure policy: if anything inside the handler throws, we MUST still
 * return a valid CallToolResult — never let the agent see a tool dispatch
 * failure as a transport error. The error text + the archived original
 * (when available) are sent back so the agent can react.
 */
import { ContextOffloadStore } from './offload-store'
import { runBashCommand, type RunBashResult } from './bash-runner'
import {
  defaultPipeline,
  type OutputCompressionPipeline,
  type PipelineResult
} from './index'

export interface XuanpuToolsContext {
  /** Hive session id — used as the archive subdirectory. */
  sessionId: string
  /** Default cwd for `bash` invocations (the worktree path). */
  defaultCwd: string
  /** Optional override for the offload store (tests). */
  offloadStore?: ContextOffloadStore
  /** Optional override for the compression pipeline (tests). */
  pipeline?: OutputCompressionPipeline
  /** Optional logger; if absent, fail silently. */
  logger?: { warn(msg: string, meta?: Record<string, unknown>): void }
}

export interface BashToolMetadata {
  beforeBytes: number
  afterBytes: number
  savedBytes: number
  ruleHits: Array<{ name: string; hint?: string }>
  archivePath: string | null
  exitCode: number
  durationMs: number
  timedOut: boolean
  aborted: boolean
}

const FOOTER_LINE = '---'

/**
 * Build the `bash` tool result text. Agent-visible body = compressed output
 * + footer noting savings + archive pointer. If compression didn't fire
 * (small output), the footer is omitted to keep simple commands clean.
 */
export function formatToolResultText(
  pipelineResult: PipelineResult,
  metadata: BashToolMetadata
): string {
  const compressionFired = pipelineResult.ruleHits.length > 0
  if (!compressionFired) {
    return pipelineResult.text
  }
  const savedPercent =
    metadata.beforeBytes > 0
      ? Math.round((metadata.savedBytes / metadata.beforeBytes) * 100)
      : 0
  const footerParts = [
    `[Token Saver] compressed ${metadata.beforeBytes}B → ${metadata.afterBytes}B (-${savedPercent}%)`,
    `via ${pipelineResult.ruleHits.map((h) => h.name).join(', ')}`
  ]
  if (metadata.archivePath) {
    footerParts.push(`original: ${metadata.archivePath}`)
  }
  return `${pipelineResult.text}\n${FOOTER_LINE}\n${footerParts.join(' · ')}`
}

/**
 * Run a single bash invocation through the full pipeline. Exposed for tests
 * (so we can validate the data path without the MCP transport).
 */
export async function runBashWithCompression(
  input: { command: string; timeoutMs?: number },
  ctx: XuanpuToolsContext,
  signal?: AbortSignal
): Promise<{ text: string; metadata: BashToolMetadata; runResult: RunBashResult }> {
  const offload = ctx.offloadStore ?? new ContextOffloadStore()
  const pipeline = ctx.pipeline ?? defaultPipeline()

  let runResult: RunBashResult
  try {
    runResult = await runBashCommand({
      command: input.command,
      cwd: ctx.defaultCwd,
      timeoutMs: input.timeoutMs,
      signal
    })
  } catch (err) {
    // Spawn-level failure: surface a synthetic result so the agent can react.
    const message = err instanceof Error ? err.message : String(err)
    const fallback: RunBashResult = {
      exitCode: -1,
      durationMs: 0,
      stdout: '',
      stderr: `[xuanpu-tools] failed to spawn: ${message}`,
      combined: `[xuanpu-tools] failed to spawn: ${message}`,
      truncated: { stdout: false, stderr: false },
      timedOut: false,
      aborted: false
    }
    runResult = fallback
  }

  // Best-effort archive — failure here should not block the agent.
  let archivePath: string | null = null
  try {
    if (runResult.combined.length > 0) {
      const rec = await offload.write({
        sessionId: ctx.sessionId,
        body: runResult.combined
      })
      archivePath = rec.path
    }
  } catch (err) {
    ctx.logger?.warn?.('xuanpu-tools: archive write failed', {
      error: err instanceof Error ? err.message : String(err)
    })
  }

  // Compression. Strategy errors are isolated by the pipeline; we only catch
  // catastrophic failures.
  let pipelineResult: PipelineResult
  try {
    pipelineResult = pipeline.run(runResult.combined, {
      command: input.command,
      exitCode: runResult.exitCode,
      durationMs: runResult.durationMs,
      source: 'bash'
    })
  } catch (err) {
    ctx.logger?.warn?.('xuanpu-tools: pipeline crashed, falling back to raw output', {
      error: err instanceof Error ? err.message : String(err)
    })
    pipelineResult = {
      text: runResult.combined,
      beforeBytes: Buffer.byteLength(runResult.combined, 'utf8'),
      afterBytes: Buffer.byteLength(runResult.combined, 'utf8'),
      ruleHits: []
    }
  }

  const metadata: BashToolMetadata = {
    beforeBytes: pipelineResult.beforeBytes,
    afterBytes: pipelineResult.afterBytes,
    savedBytes: Math.max(0, pipelineResult.beforeBytes - pipelineResult.afterBytes),
    ruleHits: pipelineResult.ruleHits,
    archivePath,
    exitCode: runResult.exitCode,
    durationMs: runResult.durationMs,
    timedOut: runResult.timedOut,
    aborted: runResult.aborted
  }

  return { text: formatToolResultText(pipelineResult, metadata), metadata, runResult }
}

/**
 * Create the SDK MCP server config to attach to a Claude session's options.
 *
 * Dynamic import of the SDK matches the LSP server's pattern (the SDK is
 * ESM-only and would otherwise break test environments that load this module
 * synchronously). The returned value is opaque to us — pass it straight into
 * `options.mcpServers['xuanpu'] = ...`.
 */
export async function createXuanpuToolsMcpServerConfig(
  ctx: XuanpuToolsContext
): Promise<unknown> {
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
  const { z } = await import('zod')

  const bashTool = tool(
    'bash',
    [
      'Execute a shell command. Behaves like the built-in Bash tool but with',
      'Token Saver compression: long output is summarised before being returned',
      'to you (the agent). The original is archived locally so the user can',
      'expand any compressed result. Behaviour you should know:',
      '- timeout defaults to 120s, max 600s',
      '- exit code, stdout, stderr are all preserved (just compressed)',
      '- cwd is fixed to the current worktree; do NOT cd elsewhere',
      "- if you see '[Token Saver] compressed ...' at the bottom, the body",
      "  above is a summary; the archived path is included for the user's UI"
    ].join(' '),
    {
      command: z.string().describe('The shell command to execute'),
      timeout: z
        .number()
        .optional()
        .describe('Optional timeout in milliseconds (max 600000)'),
      description: z
        .string()
        .optional()
        .describe('Short description of what this command does (5-15 words)')
    },
    async (args, extra) => {
      // The SDK passes an abort signal through `extra` when the user
      // interrupts. Best-effort extraction.
      let signal: AbortSignal | undefined
      if (extra && typeof extra === 'object') {
        const maybe = (extra as { signal?: unknown }).signal
        if (maybe instanceof AbortSignal) signal = maybe
      }

      try {
        const { text } = await runBashWithCompression(
          { command: args.command, timeoutMs: args.timeout },
          ctx,
          signal
        )
        return {
          content: [{ type: 'text', text }]
        }
      } catch (err) {
        // Last-resort safety net — runBashWithCompression has its own catches
        // but if THIS throws, we still must return a valid CallToolResult.
        const message = err instanceof Error ? err.message : String(err)
        ctx.logger?.warn?.('xuanpu-tools: bash handler crashed', { error: message })
        return {
          content: [
            {
              type: 'text',
              text: `[xuanpu-tools] internal error: ${message}`
            }
          ],
          isError: true
        }
      }
    },
    { annotations: { readOnly: false } }
  )

  return createSdkMcpServer({
    name: 'xuanpu',
    version: '1.0.0',
    tools: [bashTool]
  })
}
