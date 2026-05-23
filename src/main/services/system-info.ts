import { app } from 'electron'
import { getLogDir } from './logger'
import { resolveClaudeBinaryPath } from './claude-binary-resolver'
import { getCodexLaunchInfo } from './codex-binary-resolver'
import { canLaunchOpenCode } from './opencode-binary-resolver'
import {
  getXuanpuAgentProviderCredentialRequirement,
  resolveXuanpuAgentModelRef,
  type XuanpuAgentModelRef
} from './xuanpu-agent/model-config'
import {
  getXuanpuAgentToolSurfaceGates,
  XUANPU_AGENT_TOOL_POLICY
} from './xuanpu-agent/tool-policy'

export interface AgentSdkDetection {
  opencode: boolean
  claude: boolean
  codex: boolean
  xuanpuAgent: boolean
}

export interface AppPaths {
  userData: string
  home: string
  logs: string
}

export interface XuanpuAgentRuntimeStatus {
  enabled: boolean
  status: 'disabled' | 'missing-credentials' | 'mock-ready' | 'ready'
  runtimeGateEnv: 'XUANPU_AGENT_RUNTIME'
  mockMode: boolean
  providerReady: boolean
  providerID: string
  modelID: string
  credential: {
    providerID: string
    required: boolean
    present: boolean
    envKeys: string[]
  }
  toolSurface: {
    status: typeof XUANPU_AGENT_TOOL_POLICY.toolSurfaceStatus
    toolsEnabled: boolean
    nativeProcessControlEnabled: boolean
    unmetGateIds: string[]
  }
}

export async function detectAgentSdks(): Promise<AgentSdkDetection> {
  const [opencode, codex] = await Promise.all([canLaunchOpenCode(), getCodexLaunchInfo()])
  return {
    opencode,
    claude: !!resolveClaudeBinaryPath(),
    codex: !!codex.spec && codex.supportsAppServer,
    xuanpuAgent: process.env.XUANPU_AGENT_RUNTIME === '1'
  }
}

export function getXuanpuAgentRuntimeStatus(
  modelOverride?: XuanpuAgentModelRef | null
): XuanpuAgentRuntimeStatus {
  const enabled = process.env.XUANPU_AGENT_RUNTIME === '1'
  const mockMode = process.env.XUANPU_AGENT_MOCK_RESPONSE !== undefined
  const modelRef = resolveXuanpuAgentModelRef(modelOverride ?? undefined)
  const requirement = getXuanpuAgentProviderCredentialRequirement(modelRef.providerID)
  const credentialPresent = requirement?.present ?? true
  const providerReady = enabled && (mockMode || credentialPresent)
  const status: XuanpuAgentRuntimeStatus['status'] = !enabled
    ? 'disabled'
    : mockMode
      ? 'mock-ready'
      : credentialPresent
        ? 'ready'
        : 'missing-credentials'
  const unmetGateIds = getXuanpuAgentToolSurfaceGates()
    .filter((gate) => gate.required && !gate.satisfied)
    .map((gate) => gate.id)

  return {
    enabled,
    status,
    runtimeGateEnv: 'XUANPU_AGENT_RUNTIME',
    mockMode,
    providerReady,
    providerID: modelRef.providerID,
    modelID: modelRef.modelID,
    credential: {
      providerID: requirement?.providerID ?? modelRef.providerID,
      required: Boolean(requirement),
      present: mockMode || credentialPresent,
      envKeys: requirement?.envKeys ?? []
    },
    toolSurface: {
      status: XUANPU_AGENT_TOOL_POLICY.toolSurfaceStatus,
      toolsEnabled: XUANPU_AGENT_TOOL_POLICY.toolsEnabled,
      nativeProcessControlEnabled: XUANPU_AGENT_TOOL_POLICY.nativeProcessControlEnabled,
      unmetGateIds
    }
  }
}

export function getAppPaths(): AppPaths {
  return {
    userData: app.getPath('userData'),
    home: app.getPath('home'),
    logs: getLogDir()
  }
}

export function getAppVersion(): string {
  return app.getVersion()
}
