/**
 * StormDetector — 滑动窗口工具调用去重检测。
 *
 * 挂在 pi-agent-core 的 `beforeToolCall` 钩子上。
 * 同 (toolName, normalizedArgs) 在最近 N 次工具调用中出现 ≥3 次时，
 * 返回 `{ block: true }` 阻止本次执行。
 *
 * 对应架构文档 §5.6 四件套之 storm。
 */
import type { AgentLoopConfig } from '@oh-my-pi/pi-agent-core'

type BeforeToolCallFn = NonNullable<AgentLoopConfig['beforeToolCall']>

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

interface StormCallRecord {
  toolName: string
  argsHash: string
  occurredAt: number
}

interface StormDetectorOptions {
  /** 滑动窗口大小（最近 N 次工具调用）。默认 5。 */
  windowSize?: number
  /** 抑制阈值：同签名出现次数 ≥ 此值时 block。默认 3。 */
  threshold?: number
}

// ───────────────────────────────────────────────────────────────────────────
// Detector
// ───────────────────────────────────────────────────────────────────────────

export class StormDetector {
  private readonly windowSize: number
  private readonly threshold: number
  private recentCalls: StormCallRecord[] = []

  constructor(options: StormDetectorOptions = {}) {
    this.windowSize = options.windowSize ?? 5
    this.threshold = options.threshold ?? 3
  }

  /**
   * 返回一个 `beforeToolCall` 钩子函数，可直接赋值给 `agent.beforeToolCall`。
   */
  get hook(): BeforeToolCallFn {
    // eslint-disable-next-line @typescript-eslint/require-await
    return async (ctx) => {
      const toolName = ctx.toolCall.name ?? ''
      const argsHash = this.hashArgs(ctx.args)

      this.recentCalls.push({
        toolName,
        argsHash,
        occurredAt: Date.now()
      })

      // 维护滑动窗口
      if (this.recentCalls.length > this.windowSize) {
        this.recentCalls = this.recentCalls.slice(-this.windowSize)
      }

      // 统计同签名出现次数
      const count = this.recentCalls.filter(
        (record) => record.toolName === toolName && record.argsHash === argsHash
      ).length

      if (count >= this.threshold) {
        return {
          block: true,
          reason: [
            `Storm detected: ${toolName} called ${count} times with same args in the last ${this.windowSize} calls.`,
            'Please try a different approach or review the prior results before retrying.'
          ].join(' ')
        }
      }

      return undefined // allow
    }
  }

  /**
   * 规范化 args 并做快速 hash。只做确定性 JSON canonicalize + 截断，
   * 不做 path normalization（那是调用方的责任）。
   */
  private hashArgs(args: Record<string, unknown>): string {
    try {
      return stableCanonicalize(args)
    } catch {
      // 环形引用或不可序列化 → 退化标记
      return `unstable:${Date.now()}`
    }
  }

  /** 重置滑动窗口（切换 session 时调用）。 */
  reset(): void {
    this.recentCalls = []
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function stableCanonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortKeys(item)])
  )
}
