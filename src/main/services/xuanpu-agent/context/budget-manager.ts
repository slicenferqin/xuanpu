/**
 * ContextBudgetManager — M3 emergency fallback (M7: retreated to fallback role).
 *
 * M7 introduced Context Packer + Episode Freezer for proactive context management.
 * This manager now only handles:
 *   - 80% emergency shrink: drop oldest tool results when context critically overflows
 *   - Fill ratio recording: tracks context utilization for telemetry
 *
 * The 40% soft shrink path is a no-op — Context Packer handles budget allocation
 * per-zone before messages reach the LLM.
 *
 * Budget profiles (from xfp/types.ts):
 *   focused  = 80K tokens (~320K chars)
 *   balanced = 150K tokens (~600K chars)
 *   extended = 200K tokens (~800K chars)
 */
import type { AgentLoopConfig, AgentMessage } from '@oh-my-pi/pi-agent-core'

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type BudgetProfile = 'focused' | 'balanced' | 'extended'

export interface BudgetState {
  profile: BudgetProfile
  /** Estimated total tokens currently in context. */
  estimatedTokens: number
  /** Maximum tokens for the current profile. */
  maxTokens: number
  /** Fill ratio: 0..1. */
  fillRatio: number
  /** Timestamp of last shrink. */
  lastShrinkAt: number
  /** Whether an emergency shrink happened this turn. */
  emergencyShrunk: boolean
  /** Shrink count for this session. */
  shrinkCount: number
  /** Total bytes before compression (all time). */
  totalBeforeBytes: number
  /** Total bytes after compression (all time). */
  totalAfterBytes: number
  /** Number of included/omitted sections (informational). */
  sectionStats: { included: number; omitted: number }
}

// ───────────────────────────────────────────────────────────────────────────
// Token estimator
// ───────────────────────────────────────────────────────────────────────────

/** Fast heuristic: UTF-8 bytes ÷ 4 ≈ tokens. */
function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf-8') / 4)
}

function estimateTokensFromMessages(messages: AgentMessage[]): number {
  let total = 0
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    const m = msg as unknown as Record<string, unknown>
    if (Array.isArray(m.content)) {
      for (const part of m.content as Array<Record<string, unknown>>) {
        if (typeof part.text === 'string') total += estimateTokens(part.text)
      }
    } else if (typeof m.content === 'string') {
      total += estimateTokens(m.content)
    }
  }
  return total
}

// ───────────────────────────────────────────────────────────────────────────
// ContextBudgetManager
// ───────────────────────────────────────────────────────────────────────────

const BUDGET_TOKENS: Record<BudgetProfile, number> = {
  focused: 80_000,
  balanced: 150_000,
  extended: 200_000
}

interface BudgetManagerOptions {
  profile?: BudgetProfile
}

export class ContextBudgetManager {
  private profile: BudgetProfile
  readonly state: BudgetState

  constructor(options: BudgetManagerOptions = {}) {
    this.profile = options.profile ?? 'balanced'
    this.state = {
      profile: this.profile,
      estimatedTokens: 0,
      maxTokens: BUDGET_TOKENS[this.profile],
      fillRatio: 0,
      lastShrinkAt: 0,
      emergencyShrunk: false,
      shrinkCount: 0,
      totalBeforeBytes: 0,
      totalAfterBytes: 0,
      sectionStats: { included: 0, omitted: 0 }
    }
  }

  /** Update profile (e.g. from XFP compiler decision). */
  setProfile(profile: BudgetProfile): void {
    this.profile = profile
    this.state.profile = profile
    this.state.maxTokens = BUDGET_TOKENS[profile]
  }

  /** Record compression stats for UI. */
  recordCompression(beforeBytes: number, afterBytes: number): void {
    this.state.totalBeforeBytes += beforeBytes
    this.state.totalAfterBytes += afterBytes
  }

  /** Record compiler included/omitted section counts for the UI. */
  recordSections(included: number, omitted: number): void {
    this.state.sectionStats = { included, omitted }
  }

  /** Record fill ratio from Context Packer decisions (M7). */
  recordPackerFillRatio(fillRatio: number): void {
    this.state.fillRatio = fillRatio
    this.state.estimatedTokens = Math.round(fillRatio * this.state.maxTokens)
  }

  /**
   * Returns a transformContext function suitable for AgentLoopConfig.
   *
   * Called before each LLM request. Checks fill ratio and prunes if needed.
   */
  get transformContext(): NonNullable<AgentLoopConfig['transformContext']> {
    return async (messages, _signal) => {
      this.state.emergencyShrunk = false
      const tokens = estimateTokensFromMessages(messages)
      this.state.estimatedTokens = tokens
      this.state.fillRatio = tokens / this.state.maxTokens

      // Emergency shrink: 80%+ → drop oldest tool results
      if (this.state.fillRatio >= 0.8) {
        const pruned = this.emergencyShrink(messages)
        this.state.emergencyShrunk = true
        this.state.shrinkCount++
        this.state.lastShrinkAt = Date.now()
        this.state.estimatedTokens = estimateTokensFromMessages(pruned)
        this.state.fillRatio = this.state.estimatedTokens / this.state.maxTokens
        return pruned
      }

      // Soft shrink: 40%+ → handled by implementer (freeze + repack with reduced budgets).
      // This transformContext hook only handles the 80% emergency fallback.
      // See xuanpu-agent-implementer.ts prompt path for the primary soft shrink logic.

      return messages
    }
  }

  /** Drop oldest tool result messages until under 60% fill. */
  private emergencyShrink(messages: AgentMessage[]): AgentMessage[] {
    const targetTokens = Math.floor(this.state.maxTokens * 0.6)
    const result: AgentMessage[] = []
    let toolResultsDropped = 0

    // Preserve message ordering and never remove user/current-request messages.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.role === 'toolResult' && toolResultsDropped < 50) {
        console.warn('[ContextBudgetManager] emergencyShrink: pruning tool result', { index: i, role: msg.role })
        result.unshift({
          ...msg,
          role: 'toolResult',
          content: [
            {
              type: 'text',
              text: '[Tool result pruned by auto-compaction; raw output is available via command trace.]'
            }
          ],
          prunedAt: Date.now(),
          timestamp: msg.timestamp ?? Date.now()
        })
        toolResultsDropped++
        continue
      }
      result.unshift(msg)
    }

    if (estimateTokensFromMessages(result) > targetTokens) {
      console.warn('[ContextBudgetManager] emergencyShrink: still over target, compacting text', {
        toolResultsDropped,
        resultTokens: estimateTokensFromMessages(result),
        targetTokens
      })
      return result.map((msg) => {
        if (msg.role !== 'assistant' || typeof msg.content === 'string') return msg
        return {
          ...msg,
          content: msg.content.map((part) => {
            if (part.type !== 'text') return part
            const text = part.text
            if (text.length <= 4000) return part
            return {
              ...part,
              text: `${text.slice(0, 2000)}\n\n... [assistant text compacted by ContextBudgetManager] ...\n\n${text.slice(-2000)}`
            }
          })
        }
      })
    }

    return result
  }
}
