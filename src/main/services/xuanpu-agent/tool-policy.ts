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
  satisfied: boolean
  reason: string
}

export interface XuanpuAgentToolPolicy {
  toolsEnabled: boolean
  nativeProcessControlEnabled: boolean
  strategy: 'no-tools-compat-native' | 'read-only-harness'
  nativePackaging: 'compat-alias-inert'
  toolSurfaceStatus: 'blocked' | 'read-only'
  reason: string
  gates: XuanpuAgentToolSurfaceGate[]
}

export const XUANPU_AGENT_TOOL_POLICY: XuanpuAgentToolPolicy = {
  toolsEnabled: true,
  nativeProcessControlEnabled: false,
  strategy: 'read-only-harness',
  nativePackaging: 'compat-alias-inert',
  toolSurfaceStatus: 'read-only',
  reason:
    'xuanpu-agent M2 read-only harness. git_status, git_log, git_diff, read_file, rg_search, and list_files are available. Shell, file editing, MCP, and native process control remain disabled.',
  gates: [
    {
      id: 'permission-policy',
      title: 'Permission Policy',
      required: true,
      satisfied: true,
      reason:
        'Read-only tools are gate-controlled at tool registration. Write operations remain blocked until checkpoint-policy is satisfied.'
    },
    {
      id: 'checkpoint-policy',
      title: 'Checkpoint Policy',
      required: true,
      satisfied: false,
      reason:
        'Xuanpu has not mapped write operations to a checkpoint/restore policy. Required before registering write tools (M4).'
    },
    {
      id: 'tool-audit',
      title: 'Tool Audit Trail',
      required: true,
      satisfied: false,
      reason:
        'M2 adds command_traces table for tool output archival. Full audit (inputs, approvals, file mutations) deferred to M4.'
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
    'You are xuanpu-agent, an AI coding assistant running inside Xuanpu (玄圃).',
    'You have read-only access to the worktree via these tools:',
    '  git_status  — current branch, staged/unstaged/untracked changes',
    '  git_log     — recent commit history',
    '  git_diff    — working-tree diff (unstaged, staged, or branch comparison)',
    '  read_file   — read a file (or line range) from the worktree',
    '  rg_search   — fast regex search across files (ripgrep)',
    '  list_files  — list directory contents',
    'You CANNOT edit files, run shell commands, or access external tools (MCP).',
    'When answering, cite file paths and line numbers from tool results.'
  ]
}

import { READ_ONLY_TOOLS } from './tools'

export function getXuanpuAgentAllowedTools(): unknown[] {
  return READ_ONLY_TOOLS
}

export function assertXuanpuAgentAllowedTools(tools: unknown[]): void {
  if (tools.length === 0) return

  const allowedNames = new Set(READ_ONLY_TOOLS.map((tool) => tool.name))
  const disallowedNames = tools
    .map((tool) =>
      tool && typeof tool === 'object' && 'name' in tool
        ? String((tool as { name: unknown }).name)
        : '(unknown)'
    )
    .filter((name) => !allowedNames.has(name))

  if (disallowedNames.length > 0) {
    throw new Error(
      [
        'xuanpu-agent can only expose read-only M2 tools.',
        `Disallowed tools: ${disallowedNames.join(', ')}`,
        'Write, shell, MCP, and native process tools remain blocked until M4 gates are satisfied.'
      ].join('\n')
    )
  }

  if (XUANPU_AGENT_TOOL_POLICY.nativeProcessControlEnabled) {
    assertXuanpuAgentToolSurfaceReady()
  }
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
