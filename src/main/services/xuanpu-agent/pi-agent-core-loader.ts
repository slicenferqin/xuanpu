import { installBunCompatGlobal } from './bun-compat'

export interface PiAgentCoreLoadResult {
  exportedKeys: string[]
}

export async function loadPiAgentCore(): Promise<PiAgentCoreLoadResult> {
  installBunCompatGlobal()
  const piAgentCore = await import('@oh-my-pi/pi-agent-core')

  return {
    exportedKeys: Object.keys(piAgentCore).sort()
  }
}
