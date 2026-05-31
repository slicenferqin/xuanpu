import { app } from 'electron'
import { getLogDir } from './logger'
import { resolveClaudeBinaryPath } from './claude-binary-resolver'
import { getCodexLaunchInfo } from './codex-binary-resolver'
import { canLaunchOpenCode } from './opencode-binary-resolver'
import {
  getXuanpuAgentProviderCredentialRequirement,
  getXuanpuAgentOpenAIBaseUrlOverride,
  resolveXuanpuAgentModelRef,
  type XuanpuAgentModelRef,
  type CredentialSource
} from './xuanpu-agent/model-config'
import {
  getXuanpuAgentToolSurfaceGates,
  XUANPU_AGENT_TOOL_POLICY
} from './xuanpu-agent/tool-policy'
import {
  loadXuanpuAgentConfig,
  type XuanpuAgentConfig,
  type XuanpuAgentConfigSource
} from './xuanpu-agent/config-loader'

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
  status: 'disabled' | 'missing-credentials' | 'mock-ready' | 'ready' | 'config-error'
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
    source: CredentialSource
    maskedKey: string | null
  }
  toolSurface: {
    status: typeof XUANPU_AGENT_TOOL_POLICY.toolSurfaceStatus
    toolsEnabled: boolean
    nativeProcessControlEnabled: boolean
    unmetGateIds: string[]
  }
  configPath: string
  configLoaded: boolean
  configSource: XuanpuAgentConfigSource
  baseUrl: string | null
  baseUrlSource: 'env' | 'config' | null
}

export async function detectAgentSdks(): Promise<AgentSdkDetection> {
  const [opencode, codex] = await Promise.all([canLaunchOpenCode(), getCodexLaunchInfo()])
  let xuanpuAgent = process.env.XUANPU_AGENT_RUNTIME === '1'
  if (!xuanpuAgent) {
    try {
      const result = loadXuanpuAgentConfig()
      xuanpuAgent = result.config.enabled
    } catch {
      // Config error — treat as not available
    }
  }
  return {
    opencode,
    claude: !!resolveClaudeBinaryPath(),
    codex: !!codex.spec && codex.supportsAppServer,
    xuanpuAgent
  }
}

export function getXuanpuAgentRuntimeStatus(
  modelOverride?: XuanpuAgentModelRef | null
): XuanpuAgentRuntimeStatus {
  // Load config (non-throwing for missing file; throw on parse error)
  let config: XuanpuAgentConfig | undefined
  let configSource: XuanpuAgentConfigSource = 'env-only'
  let configPath = ''
  let configLoaded = false

  try {
    const result = loadXuanpuAgentConfig()
    config = result.config
    configSource = result.configSource
    configPath = result.configPath
    configLoaded = result.configLoaded
  } catch {
    // Config parse/validation error
    return {
      enabled: process.env.XUANPU_AGENT_RUNTIME === '1',
      status: 'config-error',
      runtimeGateEnv: 'XUANPU_AGENT_RUNTIME',
      mockMode: process.env.XUANPU_AGENT_MOCK_RESPONSE !== undefined,
      providerReady: false,
      providerID: modelOverride?.providerID ?? config?.mainModel?.providerID ?? 'anthropic',
      modelID: modelOverride?.modelID ?? config?.mainModel?.modelID ?? 'claude-haiku-4-5',
      credential: {
        providerID: '',
        required: false,
        present: false,
        envKeys: [],
        source: 'missing',
        maskedKey: null
      },
      toolSurface: {
        status: XUANPU_AGENT_TOOL_POLICY.toolSurfaceStatus,
        toolsEnabled: XUANPU_AGENT_TOOL_POLICY.toolsEnabled,
        nativeProcessControlEnabled: XUANPU_AGENT_TOOL_POLICY.nativeProcessControlEnabled,
        unmetGateIds: []
      },
      configPath: configPath || '',
      configLoaded: false,
      configSource: 'config-error',
      baseUrl: null,
      baseUrlSource: null
    }
  }

  const envEnabled = process.env.XUANPU_AGENT_RUNTIME === '1'
  const configEnabled = config?.enabled === true
  const enabled = envEnabled || configEnabled
  const mockMode = process.env.XUANPU_AGENT_MOCK_RESPONSE !== undefined
  const modelRef = resolveXuanpuAgentModelRef(modelOverride ?? undefined, undefined, config)
  const requirement = getXuanpuAgentProviderCredentialRequirement(modelRef.providerID, config)
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

  const baseUrlOverride = getXuanpuAgentOpenAIBaseUrlOverride(config)

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
      envKeys: requirement?.envKeys ?? [],
      source: requirement?.source ?? 'missing',
      maskedKey: mockMode ? null : (requirement?.maskedKey ?? null)
    },
    toolSurface: {
      status: XUANPU_AGENT_TOOL_POLICY.toolSurfaceStatus,
      toolsEnabled: XUANPU_AGENT_TOOL_POLICY.toolsEnabled,
      nativeProcessControlEnabled: XUANPU_AGENT_TOOL_POLICY.nativeProcessControlEnabled,
      unmetGateIds
    },
    configPath,
    configLoaded,
    configSource,
    baseUrl: baseUrlOverride?.baseUrl ?? null,
    baseUrlSource: baseUrlOverride?.source ?? null
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
