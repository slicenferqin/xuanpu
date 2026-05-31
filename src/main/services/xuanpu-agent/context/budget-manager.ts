/**
 * ContextBudgetManager — M3 auto-compaction.
 *
 * Tracks estimated context window fill and triggers shrink/emergency compaction
 * when thresholds are crossed. Hooks into oh-my-pi's transformContext.
 *
 * Token estimation uses a fast heuristic: bytes / 4 ≈ tokens (conservative for
 * code-heavy contexts where the GPT tokenizer averages ~3.5 chars/token).
 *
 * Thresholds:
 *   - 40% fill → shrink: compress tool result content of prior turns
 *   - 80% fill → emergency shrink: drop oldest tool results entirely
 *
 * Budget profiles (from xfp/types.ts):
 *   focused  = 150K tokens (~600K chars)
 *   balanced = 300K tokens (~1.2M chars)
 *   extended = 500K tokens (~2.0M chars)
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
  focused: 150_000,
  balanced: 300_000,
  extended: 500_000
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

      // Soft shrink: 40%+ → mark but don't prune yet (afterToolCall handles per-tool compression)
      // The transformContext is the right place for cross-turn pruning

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
