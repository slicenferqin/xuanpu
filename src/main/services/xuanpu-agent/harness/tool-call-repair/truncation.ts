/**
 * ToolOutputTruncator — afterToolCall 钩子，MVP 级命令输出截断。
 *
 * 挂在 pi-agent-core 的 `afterToolCall` 钩子上。
 * M1.5 阶段只做 head/tail 截断（前 500 行 + 后 500 行），
 * M2 扩展到按命令类型差异化压缩（CommandProfiler + CommandCompressor）。
 *
 * 对应架构文档 §5.4 命令输出压缩（第一道防线）。
 */
import type { AgentLoopConfig } from '@oh-my-pi/pi-agent-core'
import { randomUUID } from 'node:crypto'
import type {
  CommandProfiler,
  CommandCompressor,
  CompressionMetadata
} from '../../context/compressor'

type AfterToolCallFn = NonNullable<AgentLoopConfig['afterToolCall']>

// ───────────────────────────────────────────────────────────────────────────
// Options
// ───────────────────────────────────────────────────────────────────────────

/** Payload passed to the archive callback after successful compression. */
export interface ArchivePayload {
  traceId: string
  toolName: string
  command: string
  cwd: string
  exitCode: number
  durationMs: number
  timedOut: boolean
  aborted: boolean
  rawOutput: string
  compressedOutput: string
  compressionRatio: number
  category: string
  ruleHits: string[]
}

interface TruncatorOptions {
  /** 字符数阈值：超过此值才触发截断。默认 12000（≈3000 token）。 */
  charThreshold?: number
  /** 保留头部行数。默认 500。 */
  headLines?: number
  /** 保留尾部行数。默认 500。 */
  tailLines?: number
  /** 是否启用。可用于临时关闭。 */
  enabled?: boolean
  /** M2: 命令分类器。设置后启用差异化压缩。 */
  profiler?: CommandProfiler
  /** M2: 命令压缩器。设置后启用差异化压缩。 */
  compressor?: CommandCompressor
  /** M2: 归档回调。每次压缩后调用，用于将原始输出写入 command_traces 表。 */
  onArchive?: (payload: ArchivePayload) => void
}

// ───────────────────────────────────────────────────────────────────────────
// Truncator
// ───────────────────────────────────────────────────────────────────────────

export class ToolOutputTruncator {
  private readonly charThreshold: number
  private readonly headLines: number
  private readonly tailLines: number
  private _enabled: boolean
  private profiler?: CommandProfiler
  private compressor?: CommandCompressor
  private onArchive?: (payload: ArchivePayload) => void

  constructor(options: TruncatorOptions = {}) {
    this.charThreshold = options.charThreshold ?? 12_000
    this.headLines = options.headLines ?? 500
    this.tailLines = options.tailLines ?? 500
    this._enabled = options.enabled ?? true
    this.profiler = options.profiler
    this.compressor = options.compressor
    this.onArchive = options.onArchive
  }

  get enabled(): boolean {
    return this._enabled
  }

  set enabled(value: boolean) {
    this._enabled = value
  }

  /** M2: Set the command profiler for differential compression. */
  setProfiler(profiler: CommandProfiler): void {
    this.profiler = profiler
  }

  /** M2: Set the command compressor for differential compression. */
  setCompressor(compressor: CommandCompressor): void {
    this.compressor = compressor
  }

  /** M2: Set the archive callback for writing raw output to command_traces. */
  setOnArchive(callback: (payload: ArchivePayload) => void): void {
    this.onArchive = callback
  }

  /**
   * 返回一个 `afterToolCall` 钩子函数，可直接赋值给 `agent.afterToolCall`。
   *
   * M2 流程：profiler 分类 → compressor 压缩 → archive 回调
   * 压缩失败时 fallback 到 head/tail 截断。
   */
  get hook(): AfterToolCallFn {
    return async (ctx) => {
      if (!this._enabled) return undefined

      const text = extractText(ctx.result)
      if (!text) return undefined

      const toolName = ctx.toolCall?.name ?? 'unknown'
      const traceId = createCommandTraceId()
      const command = extractCommand(ctx.result) || inferCommand(toolName, ctx.args)
      const cwd = extractCwd(ctx.result)
      const exitCode = extractNumberDetail(ctx.result, 'exitCode') ?? (ctx.isError ? 1 : 0)
      const durationMs = extractNumberDetail(ctx.result, 'durationMs') ?? 0
      const timedOut = extractBooleanDetail(ctx.result, 'timedOut') ?? false
      const aborted = extractBooleanDetail(ctx.result, 'aborted') ?? false

      if (text.length <= this.charThreshold) {
        this.archive({
          traceId,
          toolName,
          command,
          cwd,
          exitCode,
          durationMs,
          timedOut,
          aborted,
          rawOutput: text,
          compressedOutput: text,
          compressionRatio: 0,
          category: this.profiler?.identify(command, cwd) ?? 'unknown',
          ruleHits: ['trace:raw-small']
        })
        return undefined
      }

      // M2/M3: try profile compression first, including error outputs.
      if (this.profiler && this.compressor) {
        try {
          const category = this.profiler.identify(command, cwd)
          const profile = this.profiler.getProfile(category)
          if (profile?.enabled) {
            const metadata: CompressionMetadata = {
              traceId,
              command,
              exitCode,
              durationMs,
              cwd,
              timedOut,
              aborted
            }
            const result = this.compressor.compress(text, profile, metadata)

            if (result.compressionRatio > 0) {
              this.archive({
                traceId,
                toolName,
                command,
                cwd,
                exitCode: metadata.exitCode,
                durationMs: metadata.durationMs,
                timedOut,
                aborted,
                rawOutput: text,
                compressedOutput: result.text,
                compressionRatio: result.compressionRatio,
                category,
                ruleHits: [...result.ruleHits]
              })

              const note = [
                `[Tool output compressed: ${result.beforeBytes} → ${result.afterBytes} bytes ` +
                  `(${(result.compressionRatio * 100).toFixed(0)}% reduction, rules: ${result.ruleHits.join(', ')})]`,
                `Raw output archived at command-trace:${traceId}.`
              ].join(' ')
              return {
                content: [{ type: 'text', text: `${result.text}\n\n---\n${note}` }]
              }
            }
          }
        } catch {
          // Compression failed — fall through to head/tail truncation
        }
      }

      // Fallback: head/tail truncation
      const compressed = this.truncate(text)
      const compressionRatio = text.length > 0 ? 1 - compressed.length / text.length : 0
      this.archive({
        traceId,
        toolName,
        command,
        cwd,
        exitCode,
        durationMs,
        timedOut,
        aborted,
        rawOutput: text,
        compressedOutput: compressed,
        compressionRatio,
        category: this.profiler?.identify(command, cwd) ?? 'unknown',
        ruleHits: ['fallback:head-tail']
      })
      const note = [
        `[Tool output compressed: ${text.length} → ${compressed.length} chars (head ${this.headLines} + tail ${this.tailLines} lines)]`,
        `Raw output archived at command-trace:${traceId}.`
      ].join(' ')

      return {
        content: [{ type: 'text', text: `${compressed}\n\n---\n${note}` }]
      }
    }
  }

  private truncate(text: string): string {
    const lines = text.split('\n')
    if (lines.length <= this.headLines + this.tailLines) return text

    const head = lines.slice(0, this.headLines).join('\n')
    const tail = lines.slice(-this.tailLines).join('\n')

    return [
      head,
      '',
      `... [${lines.length - this.headLines - this.tailLines} lines truncated] ...`,
      '',
      tail
    ].join('\n')
  }

  private archive(payload: ArchivePayload): void {
    if (!this.onArchive) return

    try {
      this.onArchive(payload)
    } catch {
      // Archive failure is non-fatal. The model still receives compressed output.
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/** 从 oh-my-pi 的 tool result 中提取纯文本。 */
function extractText(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null

  const r = result as Record<string, unknown>

  // 优先取 content 数组中的 text
  if (Array.isArray(r.content)) {
    return r.content
      .filter(
        (part: unknown): part is { type: 'text'; text: string } =>
          typeof part === 'object' &&
          part !== null &&
          (part as Record<string, string>).type === 'text'
      )
      .map((part) => part.text)
      .join('\n')
  }

  // Fallback: toString
  if (typeof r.text === 'string') return r.text
  if (typeof r.output === 'string') return r.output

  return null
}

function extractCwd(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const details = (result as { details?: unknown }).details
  if (!details || typeof details !== 'object') return ''
  const cwd = (details as Record<string, unknown>).cwd
  return typeof cwd === 'string' ? cwd : ''
}

function extractCommand(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const details = (result as { details?: unknown }).details
  if (!details || typeof details !== 'object') return null
  const command = (details as Record<string, unknown>).command
  return typeof command === 'string' && command.trim() ? command : null
}

function extractNumberDetail(result: unknown, key: string): number | null {
  if (!result || typeof result !== 'object') return null
  const details = (result as { details?: unknown }).details
  if (!details || typeof details !== 'object') return null
  const value = (details as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function extractBooleanDetail(result: unknown, key: string): boolean | null {
  if (!result || typeof result !== 'object') return null
  const details = (result as { details?: unknown }).details
  if (!details || typeof details !== 'object') return null
  const value = (details as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : null
}

function inferCommand(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'git_status':
      return args.path ? `git status -- ${String(args.path)}` : 'git status'
    case 'git_log': {
      const n = typeof args.n === 'number' ? args.n : 10
      const branch = typeof args.branch === 'string' ? ` ${args.branch}` : ''
      const targetPath = typeof args.path === 'string' ? ` -- ${args.path}` : ''
      return `git log -${n}${branch}${targetPath}`
    }
    case 'git_diff': {
      const flags = [
        args.staged ? '--staged' : null,
        typeof args.branch === 'string' ? args.branch : null,
        typeof args.path === 'string' ? `-- ${args.path}` : null
      ].filter((part): part is string => Boolean(part))
      return ['git diff', ...flags].join(' ')
    }
    case 'rg_search': {
      const pattern = typeof args.pattern === 'string' ? args.pattern : ''
      const targetPath = typeof args.path === 'string' ? ` ${args.path}` : ''
      return `rg ${pattern}${targetPath}`.trim()
    }
    case 'read_file':
      return typeof args.path === 'string' ? `cat ${args.path}` : 'cat'
    case 'list_files':
      return typeof args.path === 'string' ? `ls ${args.path}` : 'ls'
    case 'apply_patch':
      return args.reverse ? 'git apply --reverse' : 'git apply'
    case 'write_file':
      return typeof args.path === 'string' ? `write_file ${args.path}` : 'write_file'
    case 'edit_file':
      return typeof args.path === 'string' ? `edit_file ${args.path}` : 'edit_file'
    case 'run_test':
      if (typeof args.command === 'string') return args.command
      if (Array.isArray(args.args)) return args.args.map(String).join(' ')
      return 'run_test'
    case 'format_file':
      return typeof args.path === 'string'
        ? `pnpm exec prettier --stdin-filepath ${args.path}`
        : 'pnpm exec prettier'
    default:
      return toolName
  }
}

function createCommandTraceId(): string {
  return `cmd-${randomUUID()}`
}
