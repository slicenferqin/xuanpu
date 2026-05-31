/**
 * Compaction model resolver for xuanpu-agent M7.
 *
 * Resolves the lightweight model used for episode summarization.
 * Priority: explicit config > provider-auto candidate > rule-based fallback.
 */
import type { XuanpuAgentModelRef } from '../model-config'
import { resolveConfiguredApiKey } from '../model-config'
import type { XuanpuAgentConfig } from '../config-loader'
import { loadPiAiModule } from '../pi-agent-core-loader'

export interface CompactionModelResolution {
  kind: 'model' | 'rule-based'
  source: 'explicit' | 'provider-default' | 'fallback'
  modelRef?: XuanpuAgentModelRef
  model?: unknown
  streamFn?: unknown
  /** API key resolved from config (env or auth file) for this model's provider. */
  resolvedApiKey?: string
  /** Set when explicit config was requested but not honored (probe failed). */
  degradedReason?: string
}

// Provider → candidate list, cheapest first
const PROVIDER_COMPACTION_CANDIDATES: Record<string, string[]> = {
  anthropic: ['claude-haiku-4-5'],
  openai: ['gpt-5.4-mini', 'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4.1'],
  google: ['gemini-2.5-flash', 'gemini-2.5-pro']
}

const PROVIDER_ALIASES: Record<string, string> = {
  'claude-code': 'anthropic',
  codex: 'openai',
  gemini: 'google'
}

function canonicalizeProvider(providerID: string): string {
  return PROVIDER_ALIASES[providerID] ?? providerID
}

let _getBundledModel: ((provider: string, modelId: string) => unknown) | null = null

async function ensurePiAi(): Promise<void> {
  if (_getBundledModel) return
  const piAi = await loadPiAiModule()
  const fn = piAi.getBundledModel as
    | ((provider: string, modelId: string) => unknown)
    | undefined
  if (!fn) {
    throw new Error('@oh-my-pi/pi-ai getBundledModel is not available')
  }
  _getBundledModel = fn
}

function probeModel(providerID: string, modelID: string): { model: unknown; streamFn?: unknown } | null {
  if (!_getBundledModel) return null
  const model = _getBundledModel(providerID, modelID)
  if (!model) return null
  return { model }
}

export async function resolveCompactionModel(
  configuredCompactionModel?: XuanpuAgentModelRef | null,
  mainModelRef?: XuanpuAgentModelRef,
  config?: XuanpuAgentConfig
): Promise<CompactionModelResolution> {
  await ensurePiAi()

  let degradedReason: string | undefined

  // 1. Explicit config — user selected a compaction model in settings
  if (configuredCompactionModel) {
    const providerID = canonicalizeProvider(configuredCompactionModel.providerID)
    const probed = probeModel(providerID, configuredCompactionModel.modelID)
    if (probed) {
      return {
        kind: 'model',
        source: 'explicit',
        modelRef: { ...configuredCompactionModel, providerID },
        model: probed.model,
        streamFn: probed.streamFn,
        resolvedApiKey: resolveConfiguredApiKey(providerID, config)
      }
    }
    // Explicit model not available — mark degraded, fall through to auto-detect
    degradedReason = 'explicit-model-unavailable'
  }

  // 2. Provider-auto: derive from main model's provider
  if (mainModelRef) {
    const providerID = canonicalizeProvider(mainModelRef.providerID)
    const candidates = PROVIDER_COMPACTION_CANDIDATES[providerID]
    if (candidates) {
      for (const candidateModelID of candidates) {
        // Skip if it's the same as the main model (no point compacting with the same model)
        if (candidateModelID === mainModelRef.modelID) continue
        const probed = probeModel(providerID, candidateModelID)
        if (probed) {
          return {
            kind: 'model',
            source: 'provider-default',
            modelRef: { providerID, modelID: candidateModelID },
            model: probed.model,
            streamFn: probed.streamFn,
            resolvedApiKey: resolveConfiguredApiKey(providerID, config),
            degradedReason
          }
        }
      }
    }
  }

  // 3. Cross-provider fallback: try anthropic haiku if main model isn't anthropic
  if (!mainModelRef || canonicalizeProvider(mainModelRef.providerID) !== 'anthropic') {
    const probed = probeModel('anthropic', 'claude-haiku-4-5')
    if (probed) {
      return {
        kind: 'model',
        source: 'provider-default',
        modelRef: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' },
        model: probed.model,
        streamFn: probed.streamFn,
        resolvedApiKey: resolveConfiguredApiKey('anthropic', config),
        degradedReason
      }
    }
  }

  // 4. Rule-based fallback — no model available
  return { kind: 'rule-based', source: 'fallback', degradedReason }
}
