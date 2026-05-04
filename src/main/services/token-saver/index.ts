/**
 * Token Saver — public entry point.
 *
 * Stage 1: pipeline + strategies.
 * Stage 2a: ContextOffloadStore + BashCommandRunner.
 * Stage 2b: MCP server factory + claude-code-implementer integration (next).
 * Stage 3: UI metadata.
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

export type { OffloadRecord, OffloadInput, ContextOffloadStoreOptions } from './offload-store'
export { ContextOffloadStore } from './offload-store'

export type { RunBashOptions, RunBashResult } from './bash-runner'
export { runBashCommand } from './bash-runner'

import { OutputCompressionPipeline } from './pipeline'
import { DEFAULT_STRATEGIES } from './strategies'

let cachedDefault: OutputCompressionPipeline | null = null

/**
 * Returns a memoised default pipeline with all 5 built-in strategies in order.
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
