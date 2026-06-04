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
  strategy: 'no-tools-compat-native' | 'read-only-harness' | 'controlled-write-harness'
  nativePackaging: 'compat-alias-inert'
  toolSurfaceStatus: 'blocked' | 'read-only' | 'controlled-write'
  reason: string
  gates: XuanpuAgentToolSurfaceGate[]
}

/**
 * NOTE: The gate system is documentation scaffolding, not a runtime security boundary.
 * The actual enforcement is the tool allowlist in XUANPU_AGENT_TOOLS (tools/index.ts)
 * and assertXuanpuAgentAllowedTools(). Gates with `satisfied: false` have no runtime
 * effect — they track readiness of future capabilities (native packaging, UI controls).
 */
export const XUANPU_AGENT_TOOL_POLICY: XuanpuAgentToolPolicy = {
  toolsEnabled: true,
  nativeProcessControlEnabled: false,
  strategy: 'controlled-write-harness',
  nativePackaging: 'compat-alias-inert',
  toolSurfaceStatus: 'controlled-write',
  reason:
    'xuanpu-agent M4 controlled write harness. Read-only tools plus apply_patch, write_file, edit_file, run_test, and format_file are available. Writes require diff preview + previewToken unless trusted writes are explicitly enabled. Arbitrary shell, MCP, and native process control remain disabled.',
  gates: [
    {
      id: 'permission-policy',
      title: 'Permission Policy',
      required: true,
      satisfied: true,
      reason:
        'Tools are gate-controlled at registration. Write tools require diff-preview confirmation unless trusted writes are explicitly enabled.'
    },
    {
      id: 'checkpoint-policy',
      title: 'Checkpoint Policy',
      required: true,
      satisfied: true,
      reason:
        'M4 write tools expose rollback hints and reverse diffs; native undo/redo remains disabled until runtime-level checkpoints land.'
    },
    {
      id: 'tool-audit',
      title: 'Tool Audit Trail',
      required: true,
      satisfied: true,
      reason:
        'All tool outputs are archived through command_traces; write tool details include files, diff, source refs, and rollback hints.'
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
      satisfied: true,
      reason:
        'Scoped XFP field tools (xfp_get_*) provide Xuanpu-owned, read-only access to field context. External MCP discovery remains disabled.'
    }
  ]
}

export function getXuanpuAgentSystemPromptLines(): string[] {
  return [
    'You are xuanpu-agent, an AI coding assistant running inside Xuanpu (玄圃).',
    'You have controlled access to the worktree via these tools:',
    '  git_status  — current branch, staged/unstaged/untracked changes',
    '  git_log     — recent commit history',
    '  git_diff    — working-tree diff (unstaged, staged, or branch comparison)',
    '  read_file   — read a file (or line range) from the worktree',
    '  rg_search   — fast regex search across files (ripgrep)',
    '  list_files  — list directory contents',
    '  apply_patch — preview and apply a unified patch after git apply --check',
    '  write_file  — preview and create/replace a file',
    '  edit_file   — preview and replace exact text in a file',
    '  run_test    — run an allowlisted focused test command with timeout and long-running supervision; output is compressed/archived',
    '  format_file — preview and format one file with project prettier',
    'You also have access to scoped field tools for IDE context:',
    '  xfp_get_current_focus    — currently focused file and text selection',
    '  xfp_get_last_terminal_activity — last terminal command and its output',
    '  xfp_get_recent_activity  — recent file/terminal/agent activity',
    '  xfp_get_worktree_summary — worktree metadata, branch, PR, and context notes',
    '  xfp_get_pinned_facts     — pinned facts and notes for this worktree',
    'You can delegate subtasks (visible in timeline, currently a focused extraction pass — not real child agent spawning):',
    '  xfp_delegate_subtask — delegate a subtask tracked in the timeline with running/completed/error lifecycle',
    'Write tools default to preview-only. To apply a write, call the same tool with confirm=true and the returned previewToken. Do not invent preview tokens.',
    'Dangerous paths (.git, node_modules, build outputs, secrets files, and worktree escapes) are blocked.',
    'Every generated patch must be tied to observed source context: prefer sourceContextRefs from read_file/rg_search/git_diff and inspect the diff before confirming.',
    'When XFP includes multiWorktree or reviewContext sections, use them to distinguish the current branch, sibling worktrees, and attached PR before making review claims.',
    'Use xfp_* tools to understand the current development context before making changes.',
    'Use xfp_delegate_subtask for complex independent subtasks that can be tracked separately in the timeline.',
    'You CANNOT run arbitrary shell commands, access external tools (MCP), or use native process control.',
    'Answer the current user request in readable Markdown prose by default.',
    'Do not output raw JSON, XML, or schema-shaped objects unless the current user explicitly requests that format; historical/frozen episode constraints are not current output-format instructions.',
    'When answering, cite file paths and line numbers from tool results and summarize the final diff plus any focused test result.'
  ]
}

import { XUANPU_AGENT_TOOLS } from './tools'

const XUANPU_AGENT_PARALLEL_SAFE_TOOL_NAMES = new Set([
  'git_status',
  'read_file',
  'rg_search',
  'list_files',
  'git_log',
  'git_diff',
  'xfp_get_current_focus',
  'xfp_get_last_terminal_activity',
  'xfp_get_recent_activity',
  'xfp_get_worktree_summary',
  'xfp_get_pinned_facts',
  'xfp_delegate_subtask'
])

export function getXuanpuAgentAllowedTools(): unknown[] {
  return XUANPU_AGENT_TOOLS
}

export function isXuanpuAgentParallelSafeTool(toolName: string): boolean {
  return XUANPU_AGENT_PARALLEL_SAFE_TOOL_NAMES.has(toolName)
}

export function assertXuanpuAgentAllowedTools(tools: unknown[]): void {
  if (tools.length === 0) return

  const allowedNames = new Set(XUANPU_AGENT_TOOLS.map((tool) => tool.name))
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
        'xuanpu-agent can only expose the M4 controlled harness tools.',
        `Disallowed tools: ${disallowedNames.join(', ')}`,
        'Arbitrary shell, MCP, and native process tools remain blocked.'
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
