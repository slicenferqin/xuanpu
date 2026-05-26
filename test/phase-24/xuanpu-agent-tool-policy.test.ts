import { describe, expect, it } from 'vitest'
import { XUANPU_AGENT_CAPABILITIES } from '../../src/main/services/agent-runtime-types'
import {
  assertXuanpuAgentAllowedTools,
  assertXuanpuAgentToolSurfaceReady,
  getXuanpuAgentAllowedTools,
  getXuanpuAgentSystemPromptLines,
  getXuanpuAgentToolSurfaceGates,
  XUANPU_AGENT_TOOL_POLICY
} from '../../src/main/services/xuanpu-agent/tool-policy'
import { Process } from '../../src/main/services/xuanpu-agent/pi-natives-compat'
import { Database } from '../../src/main/services/xuanpu-agent/bun-sqlite-compat'

describe('xuanpu-agent native and tool policy', () => {
  it('keeps agent runtime capabilities aligned with the read-only tool policy', () => {
    expect(XUANPU_AGENT_TOOL_POLICY).toMatchObject({
      toolsEnabled: true,
      nativeProcessControlEnabled: false,
      strategy: 'read-only-harness',
      nativePackaging: 'compat-alias-inert',
      toolSurfaceStatus: 'read-only'
    })
    expect(XUANPU_AGENT_CAPABILITIES.supportsCommands).toBe(false)
    expect(XUANPU_AGENT_CAPABILITIES.supportsPermissionRequests).toBe(false)
    expect(XUANPU_AGENT_CAPABILITIES.supportsQuestionPrompts).toBe(false)
    expect(XUANPU_AGENT_CAPABILITIES.supportsUndo).toBe(false)
    expect(XUANPU_AGENT_CAPABILITIES.supportsRedo).toBe(false)
  })

  it('allows only the read-only oh-my-pi tool list', () => {
    const tools = getXuanpuAgentAllowedTools()
    expect(tools.map((tool) => (tool as { name: string }).name)).toEqual([
      'git_status',
      'read_file',
      'rg_search',
      'list_files',
      'git_log',
      'git_diff'
    ])
    expect(() => assertXuanpuAgentAllowedTools(tools)).not.toThrow()
    expect(() => assertXuanpuAgentAllowedTools([{ name: 'shell' }])).toThrow(
      /can only expose read-only M2 tools/
    )
  })

  it('requires explicit safety gates before shell/file/MCP tools can be exposed', () => {
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
    expect(
      gates
        .filter((gate) => gate.id !== 'permission-policy')
        .every((gate) => gate.required && !gate.satisfied)
    ).toBe(true)

    expect(() => assertXuanpuAgentToolSurfaceReady()).toThrow(
      [
        `xuanpu-agent tools are disabled: ${XUANPU_AGENT_TOOL_POLICY.reason}`,
        'Unmet gates: checkpoint-policy, tool-audit, native-packaging, ui-capability-gate, mcp-boundary'
      ].join('\n')
    )
    expect(() => assertXuanpuAgentAllowedTools([{ name: 'write' }])).toThrow(
      /Disallowed tools: write/
    )
  })

  it('keeps the system prompt explicit about read-only tools and unavailable writes', () => {
    const prompt = getXuanpuAgentSystemPromptLines().join('\n')
    expect(prompt).toContain('read-only access')
    expect(prompt).toContain('git_status')
    expect(prompt).toContain('rg_search')
    expect(prompt).toContain('run shell commands')
    expect(prompt).toContain('edit files')
    expect(prompt).toContain('MCP')
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
