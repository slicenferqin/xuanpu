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
import { buildImageObservationRefFromBase64, formatImageObservationRef } from '../media-offloader'

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
  /** Number of messages pruned by emergency shrink this turn (M7 fallback audit). */
  prunedMessageCount: number
  /** Unique image blocks observed in provider context. */
  imageBlocksSeen: number
  /** Repeated image blocks rewritten to ImageObservationRef. */
  imageBlocksOmitted: number
  /** Raw image bytes observed in provider context. */
  imageBytesSeen: number
  /** Raw image bytes omitted after first vision request. */
  imageBytesOmitted: number
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
        if (part.type === 'image' && typeof part.data === 'string') {
          total += estimateTokens(part.data)
        }
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
  maxTokens?: number
}

export class ContextBudgetManager {
  private profile: BudgetProfile
  private readonly seenImageHashes = new Set<string>()
  readonly state: BudgetState

  constructor(options: BudgetManagerOptions = {}) {
    this.profile = options.profile ?? 'balanced'
    this.state = {
      profile: this.profile,
      estimatedTokens: 0,
      maxTokens: options.maxTokens ?? BUDGET_TOKENS[this.profile],
      fillRatio: 0,
      lastShrinkAt: 0,
      emergencyShrunk: false,
      shrinkCount: 0,
      totalBeforeBytes: 0,
      totalAfterBytes: 0,
      sectionStats: { included: 0, omitted: 0 },
      prunedMessageCount: 0,
      imageBlocksSeen: 0,
      imageBlocksOmitted: 0,
      imageBytesSeen: 0,
      imageBytesOmitted: 0
    }
  }

  /** Update profile (e.g. from XFP compiler decision). */
  setProfile(profile: BudgetProfile): void {
    this.profile = profile
    this.state.profile = profile
    this.state.maxTokens = BUDGET_TOKENS[profile]
  }

  setMaxTokens(maxTokens: number): void {
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) return
    this.state.maxTokens = Math.floor(maxTokens)
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
  recordPackerFillRatio(fillRatio: number, estimatedTokens?: number): void {
    this.state.fillRatio = fillRatio
    this.state.estimatedTokens = Math.round(estimatedTokens ?? fillRatio * this.state.maxTokens)
  }

  /**
   * Returns a transformContext function suitable for AgentLoopConfig.
   *
   * Called before each LLM request. Checks fill ratio and prunes if needed.
   */
  get transformContext(): NonNullable<AgentLoopConfig['transformContext']> {
    return async (messages, _signal) => {
      this.state.emergencyShrunk = false
      this.state.prunedMessageCount = 0
      const mediaResult = this.rewriteRepeatedImages(messages)
      const contextMessages = mediaResult.messages
      const tokens = estimateTokensFromMessages(contextMessages)
      this.state.estimatedTokens = tokens
      this.state.fillRatio = tokens / this.state.maxTokens

      // Emergency shrink: 80%+ → drop oldest tool results
      if (this.state.fillRatio >= 0.8) {
        const pruned = this.emergencyShrink(contextMessages)
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

      return contextMessages
    }
  }

  private rewriteRepeatedImages(messages: AgentMessage[]): {
    messages: AgentMessage[]
    rewrittenCount: number
    omittedBytes: number
  } {
    let changed = false
    let rewrittenCount = 0
    let omittedBytes = 0

    const rewritten = messages.map((message) => {
      if (!message || typeof message !== 'object') return message
      const record = message as unknown as Record<string, unknown>
      if (!Array.isArray(record.content)) return message

      let messageChanged = false
      const content = record.content.map((part) => {
        if (!isImagePart(part)) return part

        const imageRef = buildImageObservationRefFromBase64({
          data: part.data,
          mimeType: part.mimeType,
          filename: typeof part.filename === 'string' ? part.filename : null
        })

        if (!this.seenImageHashes.has(imageRef.sha256)) {
          this.seenImageHashes.add(imageRef.sha256)
          this.state.imageBlocksSeen++
          this.state.imageBytesSeen += imageRef.bytes
          return part
        }

        messageChanged = true
        rewrittenCount++
        omittedBytes += imageRef.bytes
        this.state.imageBlocksOmitted++
        this.state.imageBytesOmitted += imageRef.bytes
        return {
          type: 'text',
          text: formatImageObservationRef(imageRef)
        }
      })

      if (!messageChanged) return message
      changed = true
      return {
        ...message,
        content
      } as AgentMessage
    })

    return {
      messages: changed ? rewritten : messages,
      rewrittenCount,
      omittedBytes
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
        console.warn('[ContextBudgetManager] emergencyShrink: pruning tool result', {
          index: i,
          role: msg.role
        })
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

    this.state.prunedMessageCount = toolResultsDropped

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

function isImagePart(part: unknown): part is {
  type: 'image'
  data: string
  mimeType: string
  filename?: string
} {
  if (!part || typeof part !== 'object') return false
  const record = part as Record<string, unknown>
  return (
    record.type === 'image' &&
    typeof record.data === 'string' &&
    typeof record.mimeType === 'string'
  )
}
