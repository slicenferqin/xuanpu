import { installBunCompatGlobal } from './bun-compat'

export interface PiAgentCoreLoadResult {
  exportedKeys: string[]
}

export async function loadPiAgentCoreModule(): Promise<Record<string, unknown>> {
  installBunCompatGlobal()
  return import('@oh-my-pi/pi-agent-core')
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
