import { installBunCompatGlobal } from './bun-compat'

export interface PiAgentCoreLoadResult {
  exportedKeys: string[]
}

/**
 * Load the pi-agent-core module.
 *
 * Uses the Xuanpu workspace fork (@xuanpu/pi-agent-core) which re-exports
 * the upstream @oh-my-pi/pi-agent-core plus turn-scoped APIs (runTurn).
 */
export async function loadPiAgentCoreModule(): Promise<Record<string, unknown>> {
  installBunCompatGlobal()
  return import('@xuanpu/pi-agent-core') as Promise<Record<string, unknown>>
}

export async function loadPiAiModule(): Promise<Record<string, unknown>> {
  installBunCompatGlobal()
  return import('@oh-my-pi/pi-ai')
}

export async function loadPiAgentCore(): Promise<PiAgentCoreLoadResult> {
  const piAgentCore = await loadPiAgentCoreModule()

  return {
    exportedKeys: Object.keys(piAgentCore).sort()
  }
}

/** Re-export runTurn for direct use by turn runner. */
export { runTurn } from '@xuanpu/pi-agent-core'
