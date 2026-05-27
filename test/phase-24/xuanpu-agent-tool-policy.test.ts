import { describe, expect, it } from 'vitest'
import { XUANPU_AGENT_CAPABILITIES } from '../../src/main/services/agent-runtime-types'
import {
  assertXuanpuAgentAllowedTools,
  assertXuanpuAgentToolSurfaceReady,
  getXuanpuAgentAllowedTools,
  getXuanpuAgentSystemPromptLines,
  getXuanpuAgentToolSurfaceGates,
  isXuanpuAgentParallelSafeTool,
  XUANPU_AGENT_TOOL_POLICY
} from '../../src/main/services/xuanpu-agent/tool-policy'
import { Process } from '../../src/main/services/xuanpu-agent/pi-natives-compat'
import { Database } from '../../src/main/services/xuanpu-agent/bun-sqlite-compat'

describe('xuanpu-agent native and tool policy', () => {
  it('keeps agent runtime capabilities aligned with the controlled write tool policy', () => {
    expect(XUANPU_AGENT_TOOL_POLICY).toMatchObject({
      toolsEnabled: true,
      nativeProcessControlEnabled: false,
      strategy: 'controlled-write-harness',
      nativePackaging: 'compat-alias-inert',
      toolSurfaceStatus: 'controlled-write'
    })
    expect(XUANPU_AGENT_CAPABILITIES.supportsCommands).toBe(false)
    expect(XUANPU_AGENT_CAPABILITIES.supportsPermissionRequests).toBe(false)
    expect(XUANPU_AGENT_CAPABILITIES.supportsQuestionPrompts).toBe(false)
    expect(XUANPU_AGENT_CAPABILITIES.supportsUndo).toBe(false)
    expect(XUANPU_AGENT_CAPABILITIES.supportsRedo).toBe(false)
  })

  it('allows only the M4 controlled harness tool list', () => {
    const tools = getXuanpuAgentAllowedTools()
    expect(tools.map((tool) => (tool as { name: string }).name)).toEqual([
      'git_status',
      'read_file',
      'rg_search',
      'list_files',
      'git_log',
      'git_diff',
      'apply_patch',
      'write_file',
      'edit_file',
      'run_test',
      'format_file',
      'xfp_get_current_focus',
      'xfp_get_last_terminal',
      'xfp_get_recent_activity',
      'xfp_get_worktree_summary',
      'xfp_get_pinned_facts',
      'xfp_delegate_subtask'
    ])
    expect(() => assertXuanpuAgentAllowedTools(tools)).not.toThrow()
    expect(() => assertXuanpuAgentAllowedTools([{ name: 'shell' }])).toThrow(
      /can only expose the M4 controlled harness tools/
    )
    expect(isXuanpuAgentParallelSafeTool('read_file')).toBe(true)
    expect(isXuanpuAgentParallelSafeTool('write_file')).toBe(false)
    expect(isXuanpuAgentParallelSafeTool('xfp_get_current_focus')).toBe(true)
    expect(isXuanpuAgentParallelSafeTool('xfp_get_pinned_facts')).toBe(true)
    expect(isXuanpuAgentParallelSafeTool('xfp_delegate_subtask')).toBe(true)
  })

  it('keeps native process and MCP gates closed after controlled writes are enabled', () => {
    const gates = getXuanpuAgentToolSurfaceGates()
    expect(gates.map((gate) => gate.id)).toEqual([
      'permission-policy',
      'checkpoint-policy',
      'tool-audit',
      'native-packaging',
      'ui-capability-gate',
      'mcp-boundary'
    ])
    expect(gates.find((gate) => gate.id === 'permission-policy')?.satisfied).toBe(true)
    expect(gates.find((gate) => gate.id === 'checkpoint-policy')?.satisfied).toBe(true)
    expect(gates.find((gate) => gate.id === 'tool-audit')?.satisfied).toBe(true)
    expect(gates.find((gate) => gate.id === 'mcp-boundary')?.satisfied).toBe(true)
    expect(
      gates
        .filter(
          (gate) =>
            !['permission-policy', 'checkpoint-policy', 'tool-audit', 'mcp-boundary'].includes(
              gate.id
            )
        )
        .every((gate) => gate.required && !gate.satisfied)
    ).toBe(true)

    expect(() => assertXuanpuAgentToolSurfaceReady()).toThrow(
      [
        `xuanpu-agent tools are disabled: ${XUANPU_AGENT_TOOL_POLICY.reason}`,
        'Unmet gates: native-packaging, ui-capability-gate'
      ].join('\n')
    )
    expect(() => assertXuanpuAgentAllowedTools([{ name: 'Bash' }])).toThrow(
      /Disallowed tools: Bash/
    )
  })

  it('keeps the system prompt explicit about preview-gated writes and unavailable arbitrary shell', () => {
    const prompt = getXuanpuAgentSystemPromptLines().join('\n')
    expect(prompt).toContain('controlled access')
    expect(prompt).toContain('git_status')
    expect(prompt).toContain('rg_search')
    expect(prompt).toContain('write_file')
    expect(prompt).toContain('previewToken')
    expect(prompt).toContain('arbitrary shell commands')
    expect(prompt).toContain('MCP')
    expect(prompt).toContain('xfp_get_current_focus')
    expect(prompt).toContain('xfp_get_pinned_facts')
    expect(prompt).toContain('scoped field tools')
    expect(prompt).toContain('xfp_delegate_subtask')
    expect(prompt).toContain('delegate subtask')
  })

  it('keeps pi-natives process control inert in the compatibility alias', async () => {
    const currentProcess = Process.fromPid(process.pid)
    expect(currentProcess).not.toBeNull()
    expect(currentProcess?.killTree('SIGTERM')).toBe(0)
    await expect(currentProcess?.terminate({ gracefulMs: 1 })).resolves.toBe(false)
    expect(Process.fromPath('/bin/sh')).toEqual([])
  })

  it('keeps bun:sqlite compatibility inert for pi-ai cache imports', () => {
    const db = new Database(':memory:', { create: true })
    const statement = db.prepare<{ name: string }>('SELECT name FROM sqlite_master')

    expect(statement.all()).toEqual([])
    expect(statement.get()).toBeNull()
    expect(statement.run()).toEqual({ changes: 0, lastInsertRowid: 0 })
    expect(db.query('SELECT 1').all()).toEqual([])
    expect(db.run('CREATE TABLE auth_credentials (id INTEGER)')).toEqual({
      changes: 0,
      lastInsertRowid: 0
    })

    db.close()
  })
})
