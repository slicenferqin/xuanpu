/**
 * Token Saver — public entry point.
 *
 * Stage 1: pipeline + strategies. Stage 2 will add the MCP Bash interceptor
 * + ContextOffloadStore. Stage 3 will add UI metadata.
 *
 * Consumers:
 *   import { OutputCompressionPipeline, defaultPipeline } from 'src/main/services/token-saver'
 */
export type {
  CompressionContext,
  StrategyResult,
  OutputStrategy,
  PipelineRuleHit,
  PipelineResult,
  PipelineLogger
} from './pipeline'

export { OutputCompressionPipeline, isOutputStrategy } from './pipeline'

export {
  ansiStripStrategy,
  progressDedupStrategy,
  ndjsonSummaryStrategy,
  failureFocusStrategy,
  statsExtractionStrategy,
  DEFAULT_STRATEGIES
} from './strategies'

import { OutputCompressionPipeline } from './pipeline'
import { DEFAULT_STRATEGIES } from './strategies'

let cachedDefault: OutputCompressionPipeline | null = null

/**
 * Returns a memoised default pipeline with all 5 built-in strategies in order.
 * Most consumers should use this. Tests and bespoke consumers can construct
 * their own pipeline with `new OutputCompressionPipeline([...])`.
 */
export function defaultPipeline(): OutputCompressionPipeline {
  if (!cachedDefault) {
    cachedDefault = new OutputCompressionPipeline([...DEFAULT_STRATEGIES])
  }
  return cachedDefault
}

/** Test-only: reset the cached default (forces fresh construction). */
export function __resetDefaultPipelineForTest(): void {
  cachedDefault = null
}
