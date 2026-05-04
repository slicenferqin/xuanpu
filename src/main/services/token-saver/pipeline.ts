/**
 * OutputCompressionPipeline — Token Saver stage 1.
 *
 * Generic, tool-agnostic pipeline that transforms verbose tool output into a
 * compact form before it reaches the agent's API call. The pipeline holds an
 * ordered list of `OutputStrategy` instances; each strategy may pass-through
 * (no-op) or transform the text. Strategies record their hit in `ruleHits`
 * so the UI can surface "what compressed this".
 *
 * Pipeline guarantees:
 *   - Idempotent: passing the same input through the same pipeline twice
 *     produces the same final text.
 *   - Failure-isolated: if a strategy throws, it is logged and skipped; the
 *     pipeline continues with the previous text. A bad strategy never blocks
 *     the agent.
 *   - Non-allocating on no-op: strategies that decide not to change the text
 *     should return `{ changed: false, text }` to avoid copying.
 *
 * NOT included here:
 *   - I/O / archive writing  → caller's responsibility (ContextOffloadStore)
 *   - Per-tool dispatch      → done by MCP Bash interceptor (stage 2)
 *   - UI metadata rendering  → renderer-side (stage 3)
 *
 * See docs/plans/2026-05-04-token-saver-pipeline.md §五 阶段 1.
 */

export interface CompressionContext {
  /** Original command (for Bash tool); helps strategies decide. */
  command?: string
  /** Exit code if known; non-zero biases towards FailureFocus. */
  exitCode?: number
  /** Wall-clock duration in milliseconds. */
  durationMs?: number
  /** Loose hint about the source: 'bash' | 'read' | 'grep' | 'mcp' | ... */
  source?: string
}

export interface StrategyResult {
  /** Whether this strategy modified the text. */
  changed: boolean
  /** New text (same as input if `changed === false`). */
  text: string
  /** Optional human-readable reason for telemetry / UI tooltip. */
  hint?: string
}

export interface OutputStrategy {
  /** Stable identifier — used in `ruleHits` and tests. */
  readonly name: string
  /**
   * Apply this strategy to `text`. Must return a result; throwing is allowed
   * but the pipeline will catch and skip. Strategies should be pure functions
   * of (text, ctx).
   */
  apply(text: string, ctx: CompressionContext): StrategyResult
}

export interface PipelineRuleHit {
  name: string
  hint?: string
}

export interface PipelineResult {
  /** Final compressed text after all strategies. */
  text: string
  /** UTF-8 byte length of the original input. */
  beforeBytes: number
  /** UTF-8 byte length of the final output. */
  afterBytes: number
  /** Strategies that fired, in execution order. */
  ruleHits: PipelineRuleHit[]
}

/**
 * Type guard to validate a value is a real OutputStrategy. Useful when a
 * pipeline is constructed from user-provided / plugin-provided strategies.
 */
export function isOutputStrategy(value: unknown): value is OutputStrategy {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.name === 'string' && typeof v.apply === 'function'
}

/**
 * Logger contract — keeps the pipeline free of a hard dependency on the
 * project's `logger.ts` so it can be unit-tested in isolation.
 */
export interface PipelineLogger {
  warn(msg: string, meta?: Record<string, unknown>): void
}

const noopLogger: PipelineLogger = { warn: () => {} }

export class OutputCompressionPipeline {
  private readonly strategies: ReadonlyArray<OutputStrategy>
  private readonly log: PipelineLogger

  constructor(strategies: OutputStrategy[], logger: PipelineLogger = noopLogger) {
    for (const s of strategies) {
      if (!isOutputStrategy(s)) {
        throw new Error(`OutputCompressionPipeline: invalid strategy ${String(s)}`)
      }
    }
    this.strategies = Object.freeze([...strategies])
    this.log = logger
  }

  run(input: string, ctx: CompressionContext = {}): PipelineResult {
    const beforeBytes = Buffer.byteLength(input ?? '', 'utf8')
    const hits: PipelineRuleHit[] = []
    let current = input ?? ''

    for (const strategy of this.strategies) {
      let result: StrategyResult
      try {
        result = strategy.apply(current, ctx)
      } catch (err) {
        this.log.warn('OutputCompressionPipeline: strategy threw, skipping', {
          name: strategy.name,
          error: err instanceof Error ? err.message : String(err)
        })
        continue
      }
      if (!result || typeof result.text !== 'string') {
        this.log.warn('OutputCompressionPipeline: strategy returned malformed result, skipping', {
          name: strategy.name
        })
        continue
      }
      if (result.changed && result.text !== current) {
        current = result.text
        hits.push({ name: strategy.name, hint: result.hint })
      }
    }

    return {
      text: current,
      beforeBytes,
      afterBytes: Buffer.byteLength(current, 'utf8'),
      ruleHits: hits
    }
  }

  /** For tests: expose strategy names in order. */
  get strategyNames(): string[] {
    return this.strategies.map((s) => s.name)
  }
}
