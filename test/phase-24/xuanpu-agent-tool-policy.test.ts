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

describe('xuanpu-agent native and tool policy', () => {
  it('keeps agent runtime capabilities aligned with the no-tools policy', () => {
    expect(XUANPU_AGENT_TOOL_POLICY).toMatchObject({
      toolsEnabled: false,
      nativeProcessControlEnabled: false,
      strategy: 'no-tools-compat-native',
      nativePackaging: 'compat-alias-inert',
      toolSurfaceStatus: 'blocked'
    })
    expect(XUANPU_AGENT_CAPABILITIES.supportsCommands).toBe(false)
    expect(XUANPU_AGENT_CAPABILITIES.supportsPermissionRequests).toBe(false)
    expect(XUANPU_AGENT_CAPABILITIES.supportsQuestionPrompts).toBe(false)
    expect(XUANPU_AGENT_CAPABILITIES.supportsUndo).toBe(false)
    expect(XUANPU_AGENT_CAPABILITIES.supportsRedo).toBe(false)
  })

  it('allows only an empty oh-my-pi tool list', () => {
    const tools = getXuanpuAgentAllowedTools()
    expect(tools).toEqual([])
    expect(() => assertXuanpuAgentAllowedTools(tools)).not.toThrow()
    expect(() => assertXuanpuAgentAllowedTools([{ name: 'shell' }])).toThrow(
      /xuanpu-agent tools are disabled/
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
    expect(gates.every((gate) => gate.required && !gate.satisfied)).toBe(true)

    expect(() => assertXuanpuAgentToolSurfaceReady()).toThrow(
      [
        `xuanpu-agent tools are disabled: ${XUANPU_AGENT_TOOL_POLICY.reason}`,
        'Unmet gates: permission-policy, checkpoint-policy, tool-audit, native-packaging, ui-capability-gate, mcp-boundary'
      ].join('\n')
    )
    expect(() => assertXuanpuAgentAllowedTools([{ name: 'write' }])).toThrow(
      /Unmet gates: permission-policy, checkpoint-policy, tool-audit, native-packaging, ui-capability-gate, mcp-boundary/
    )
  })

  it('keeps the system prompt explicit about unavailable tools', () => {
    const prompt = getXuanpuAgentSystemPromptLines().join('\n')
    expect(prompt).toContain('no-tools')
    expect(prompt).toContain('Shell')
    expect(prompt).toContain('file editing')
    expect(prompt).toContain('native process tools are disabled')
  })

  it('keeps pi-natives process control inert in the compatibility alias', async () => {
    const currentProcess = Process.fromPid(process.pid)
    expect(currentProcess).not.toBeNull()
    expect(currentProcess?.killTree('SIGTERM')).toBe(0)
    await expect(currentProcess?.terminate({ gracefulMs: 1 })).resolves.toBe(false)
    expect(Process.fromPath('/bin/sh')).toEqual([])
  })
})
