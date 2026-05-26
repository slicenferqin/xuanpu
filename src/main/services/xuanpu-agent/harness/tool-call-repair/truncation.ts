/**
 * ToolOutputTruncator — afterToolCall 钩子，MVP 级命令输出截断。
 *
 * 挂在 pi-agent-core 的 `afterToolCall` 钩子上。
 * M1.5 阶段只做 head/tail 截断（前 500 行 + 后 500 行），
 * M2-M3 扩展到按命令类型差异化压缩（CommandProfiler profile）。
 *
 * 对应架构文档 §5.4 命令输出压缩（第一道防线）。
 */
import type { AgentLoopConfig } from '@oh-my-pi/pi-agent-core'

type AfterToolCallFn = NonNullable<AgentLoopConfig['afterToolCall']>

// ───────────────────────────────────────────────────────────────────────────
// Options
// ───────────────────────────────────────────────────────────────────────────

interface TruncatorOptions {
  /** 字符数阈值：超过此值才触发截断。默认 12000（≈3000 token）。 */
  charThreshold?: number
  /** 保留头部行数。默认 500。 */
  headLines?: number
  /** 保留尾部行数。默认 500。 */
  tailLines?: number
  /** 是否启用。可用于临时关闭。 */
  enabled?: boolean
}

// ───────────────────────────────────────────────────────────────────────────
// Truncator
// ───────────────────────────────────────────────────────────────────────────

export class ToolOutputTruncator {
  private readonly charThreshold: number
  private readonly headLines: number
  private readonly tailLines: number
  private _enabled: boolean

  constructor(options: TruncatorOptions = {}) {
    this.charThreshold = options.charThreshold ?? 12_000
    this.headLines = options.headLines ?? 500
    this.tailLines = options.tailLines ?? 500
    this._enabled = options.enabled ?? true
  }

  get enabled(): boolean {
    return this._enabled
  }

  set enabled(value: boolean) {
    this._enabled = value
  }

  /**
   * 返回一个 `afterToolCall` 钩子函数，可直接赋值给 `agent.afterToolCall`。
   */
  get hook(): AfterToolCallFn {
    // eslint-disable-next-line @typescript-eslint/require-await
    return async (ctx) => {
      if (!this._enabled) return undefined
      if (ctx.isError) return undefined // 错误结果不截断，让模型看到完整错误

      const text = extractText(ctx.result)
      if (!text || text.length <= this.charThreshold) return undefined

      const compressed = this.truncate(text)
      const note = [
        `[Tool output compressed: ${text.length} → ${compressed.length} chars (head ${this.headLines} + tail ${this.tailLines} lines)]`,
        `Raw output available via tool result reference.`
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
          typeof part === 'object' && part !== null && (part as Record<string, string>).type === 'text'
      )
      .map((part) => part.text)
      .join('\n')
  }

  // Fallback: toString
  if (typeof r.text === 'string') return r.text
  if (typeof r.output === 'string') return r.output

  return null
}
