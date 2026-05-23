export type XuanpuAgentToolSurfaceGateId =
  | 'permission-policy'
  | 'checkpoint-policy'
  | 'tool-audit'
  | 'native-packaging'
  | 'ui-capability-gate'
  | 'mcp-boundary'

export interface XuanpuAgentToolSurfaceGate {
  id: XuanpuAgentToolSurfaceGateId
  title: string
  required: true
  satisfied: false
  reason: string
}

export interface XuanpuAgentToolPolicy {
  toolsEnabled: false
  nativeProcessControlEnabled: false
  strategy: 'no-tools-compat-native'
  nativePackaging: 'compat-alias-inert'
  toolSurfaceStatus: 'blocked'
  reason: string
  gates: XuanpuAgentToolSurfaceGate[]
}

export const XUANPU_AGENT_TOOL_POLICY: XuanpuAgentToolPolicy = {
  toolsEnabled: false,
  nativeProcessControlEnabled: false,
  strategy: 'no-tools-compat-native',
  nativePackaging: 'compat-alias-inert',
  toolSurfaceStatus: 'blocked',
  reason:
    'xuanpu-agent is currently a managed no-tools runtime. Shell, file, MCP, and native process control stay disabled until Xuanpu owns the permission and checkpoint policy.',
  gates: [
    {
      id: 'permission-policy',
      title: 'Permission Policy',
      required: true,
      satisfied: false,
      reason: 'Xuanpu has not mapped shell/file/MCP operations to a runtime-owned approval policy.'
    },
    {
      id: 'checkpoint-policy',
      title: 'Checkpoint Policy',
      required: true,
      satisfied: false,
      reason: 'Xuanpu has not mapped write operations to a checkpoint/restore policy.'
    },
    {
      id: 'tool-audit',
      title: 'Tool Audit Trail',
      required: true,
      satisfied: false,
      reason:
        'Tool inputs, outputs, approvals, and file mutations do not have a committed audit schema.'
    },
    {
      id: 'native-packaging',
      title: 'Native Packaging',
      required: true,
      satisfied: false,
      reason: 'The current pi-natives compatibility alias is intentionally inert.'
    },
    {
      id: 'ui-capability-gate',
      title: 'UI Capability Gate',
      required: true,
      satisfied: false,
      reason: 'Session HQ has no xuanpu-agent tool/permission controls to expose safely.'
    },
    {
      id: 'mcp-boundary',
      title: 'MCP Boundary',
      required: true,
      satisfied: false,
      reason: 'MCP server discovery and permission scoping are not defined for this runtime.'
    }
  ]
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
  assertXuanpuAgentToolSurfaceReady()
}

export function isXuanpuAgentNativeProcessControlEnabled(): boolean {
  return XUANPU_AGENT_TOOL_POLICY.nativeProcessControlEnabled
}

export function getXuanpuAgentToolSurfaceGates(): XuanpuAgentToolSurfaceGate[] {
  return XUANPU_AGENT_TOOL_POLICY.gates
}

export function assertXuanpuAgentToolSurfaceReady(): never {
  const blockedGateIds = XUANPU_AGENT_TOOL_POLICY.gates
    .filter((gate) => !gate.satisfied)
    .map((gate) => gate.id)

  throw new Error(
    [
      `xuanpu-agent tools are disabled: ${XUANPU_AGENT_TOOL_POLICY.reason}`,
      `Unmet gates: ${blockedGateIds.join(', ')}`
    ].join('\n')
  )
}
