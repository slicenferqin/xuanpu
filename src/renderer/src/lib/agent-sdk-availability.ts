import type { AgentSdkAvailability } from '@/stores/useSettingsStore'

export type SessionAgentSdk = 'opencode' | 'claude-code' | 'codex' | 'terminal' | 'xuanpu-agent'

export function getEnabledSessionAgentSdks(
  availableAgentSdks: AgentSdkAvailability | null
): SessionAgentSdk[] {
  const list: SessionAgentSdk[] = []
  if (availableAgentSdks?.opencode) list.push('opencode')
  if (availableAgentSdks?.claude) list.push('claude-code')
  if (availableAgentSdks?.codex) list.push('codex')
  if (availableAgentSdks?.xuanpuAgent) list.push('xuanpu-agent')
  list.push('terminal')
  return list
}
