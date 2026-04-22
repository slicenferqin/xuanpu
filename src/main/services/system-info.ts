import { app } from 'electron'
import { getLogDir } from './logger'
import { resolveClaudeBinaryPath } from './claude-binary-resolver'
import { getCodexLaunchInfo } from './codex-binary-resolver'
import { canLaunchOpenCode } from './opencode-binary-resolver'

export interface AgentSdkDetection {
  opencode: boolean
  claude: boolean
  codex: boolean
}

export interface AppPaths {
  userData: string
  home: string
  logs: string
}

export async function detectAgentSdks(): Promise<AgentSdkDetection> {
  const [opencode, codex] = await Promise.all([canLaunchOpenCode(), getCodexLaunchInfo()])
  return {
    opencode,
    claude: !!resolveClaudeBinaryPath(),
    codex: !!codex.spec && codex.supportsAppServer
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
