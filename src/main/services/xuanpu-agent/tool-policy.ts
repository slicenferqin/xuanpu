export interface XuanpuAgentToolPolicy {
  toolsEnabled: false
  nativeProcessControlEnabled: false
  strategy: 'no-tools-compat-native'
  reason: string
}

export const XUANPU_AGENT_TOOL_POLICY: XuanpuAgentToolPolicy = {
  toolsEnabled: false,
  nativeProcessControlEnabled: false,
  strategy: 'no-tools-compat-native',
  reason:
    'xuanpu-agent is currently a managed no-tools runtime. Shell, file, MCP, and native process control stay disabled until Xuanpu owns the permission and checkpoint policy.'
}

export function getXuanpuAgentSystemPromptLines(): string[] {
  return [
    'You are xuanpu-agent, an experimental no-tools runtime inside Xuanpu.',
    'Answer directly. Shell, file editing, MCP, and native process tools are disabled.',
    'Do not claim access to shell, file editing, project tools, or external native tools.'
  ]
}

export function getXuanpuAgentAllowedTools(): unknown[] {
  return []
}

export function assertXuanpuAgentAllowedTools(tools: unknown[]): void {
  if (tools.length === 0) return
  throw new Error(`xuanpu-agent tools are disabled: ${XUANPU_AGENT_TOOL_POLICY.reason}`)
}

export function isXuanpuAgentNativeProcessControlEnabled(): boolean {
  return XUANPU_AGENT_TOOL_POLICY.nativeProcessControlEnabled
}
