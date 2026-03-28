import { execFile, spawn } from 'node:child_process'

import { checkCodexHealth } from './codex-health'
import { createLogger } from './logger'
import { checkClaudeAuth } from './usage-service'

const log = createLogger({ component: 'OnboardingDoctor' })

const EXEC_TIMEOUT_MS = 5000

type OnboardingStatus = 'ready' | 'warning' | 'missing'
type EnvironmentReason = 'installed' | 'missing' | 'outdated'
type AgentReason = 'ready' | 'missing' | 'login_required' | 'auth_unknown'
type AgentAuthStatus = 'authenticated' | 'unauthenticated' | 'unknown' | 'not_applicable'

export interface OnboardingEnvironmentCheck {
  id: 'git' | 'node' | 'homebrew' | 'xcode-cli'
  status: OnboardingStatus
  reason: EnvironmentReason
  version: string | null
}

export interface OnboardingAgentStatus {
  id: 'claude-code' | 'codex' | 'opencode'
  status: OnboardingStatus
  reason: AgentReason
  installed: boolean
  selectable: boolean
  version: string | null
  authStatus: AgentAuthStatus
}

export interface OnboardingDoctorResult {
  platform: NodeJS.Platform
  environmentChecks: OnboardingEnvironmentCheck[]
  agents: OnboardingAgentStatus[]
  recommendedAgent: 'claude-code' | 'codex' | 'opencode' | 'terminal'
}

function execCommand(command: string, args: string[], timeout = EXEC_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf-8',
        timeout,
        env: process.env
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }

        const output = `${stdout ?? ''}${stderr ?? ''}`.trim()
        resolve(output)
      }
    )
  })
}

async function resolveBinary(binary: string): Promise<string | null> {
  const whichCommand = process.platform === 'win32' ? 'where' : 'which'

  try {
    const output = await execCommand(whichCommand, [binary])
    const resolved = output
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean)

    return resolved || null
  } catch {
    return null
  }
}

function parseVersionOutput(output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed) return null

  const firstLine = trimmed.split('\n')[0].trim()
  const match = firstLine.match(/v?\d+\.\d+\.\d+(?:[-+.\w]*)?/)

  return match ? match[0] : firstLine || null
}

async function getBinaryVersion(binary: string, args: string[] = ['--version']): Promise<string | null> {
  const resolved = await resolveBinary(binary)
  if (!resolved) return null

  try {
    const output = await execCommand(binary, args)
    return parseVersionOutput(output)
  } catch (error) {
    log.debug(`${binary} version check failed`, { error })
    return null
  }
}

function parseNodeMajor(version: string | null): number | null {
  if (!version) return null
  const match = version.match(/v?(\d+)/)
  if (!match) return null
  const parsed = Number.parseInt(match[1], 10)
  return Number.isNaN(parsed) ? null : parsed
}

async function checkGit(): Promise<OnboardingEnvironmentCheck> {
  const version = await getBinaryVersion('git')

  return {
    id: 'git',
    status: version ? 'ready' : 'missing',
    reason: version ? 'installed' : 'missing',
    version
  }
}

async function checkNode(): Promise<OnboardingEnvironmentCheck> {
  const version = await getBinaryVersion('node')
  const major = parseNodeMajor(version)

  if (!version) {
    return {
      id: 'node',
      status: 'missing',
      reason: 'missing',
      version: null
    }
  }

  if (major !== null && major < 18) {
    return {
      id: 'node',
      status: 'warning',
      reason: 'outdated',
      version
    }
  }

  return {
    id: 'node',
    status: 'ready',
    reason: 'installed',
    version
  }
}

async function checkHomebrew(): Promise<OnboardingEnvironmentCheck | null> {
  if (process.platform !== 'darwin') return null

  const version = await getBinaryVersion('brew', ['--version'])

  return {
    id: 'homebrew',
    status: version ? 'ready' : 'warning',
    reason: version ? 'installed' : 'missing',
    version
  }
}

async function checkXcodeCli(): Promise<OnboardingEnvironmentCheck | null> {
  if (process.platform !== 'darwin') return null

  try {
    const output = await execCommand('xcode-select', ['-p'])
    return {
      id: 'xcode-cli',
      status: 'ready',
      reason: 'installed',
      version: output.split('\n')[0].trim() || null
    }
  } catch {
    return {
      id: 'xcode-cli',
      status: 'warning',
      reason: 'missing',
      version: null
    }
  }
}

async function checkClaudeCode(): Promise<OnboardingAgentStatus> {
  const version = await getBinaryVersion('claude')

  if (!version) {
    return {
      id: 'claude-code',
      status: 'missing',
      reason: 'missing',
      installed: false,
      selectable: false,
      version: null,
      authStatus: 'not_applicable'
    }
  }

  const authStatus = await checkClaudeAuth()
  const isReady = authStatus === 'authenticated'

  return {
    id: 'claude-code',
    status: isReady ? 'ready' : 'warning',
    reason: isReady ? 'ready' : 'login_required',
    installed: true,
    selectable: isReady,
    version,
    authStatus
  }
}

async function checkCodex(): Promise<OnboardingAgentStatus> {
  const health = await checkCodexHealth()

  if (!health.available) {
    return {
      id: 'codex',
      status: 'missing',
      reason: 'missing',
      installed: false,
      selectable: false,
      version: null,
      authStatus: 'not_applicable'
    }
  }

  if (health.authStatus === 'unauthenticated') {
    return {
      id: 'codex',
      status: 'warning',
      reason: 'login_required',
      installed: true,
      selectable: false,
      version: health.version ?? null,
      authStatus: health.authStatus
    }
  }

  return {
    id: 'codex',
    status: health.authStatus === 'unknown' ? 'warning' : 'ready',
    reason: health.authStatus === 'unknown' ? 'auth_unknown' : 'ready',
    installed: true,
    selectable: true,
    version: health.version ?? null,
    authStatus: health.authStatus
  }
}

async function checkOpencode(): Promise<OnboardingAgentStatus> {
  const version = await getBinaryVersion('opencode')

  if (!version) {
    return {
      id: 'opencode',
      status: 'missing',
      reason: 'missing',
      installed: false,
      selectable: false,
      version: null,
      authStatus: 'not_applicable'
    }
  }

  return {
    id: 'opencode',
    status: 'ready',
    reason: 'ready',
    installed: true,
    selectable: true,
    version,
    authStatus: 'unknown'
  }
}

function pickRecommendedAgent(
  agents: OnboardingAgentStatus[]
): OnboardingDoctorResult['recommendedAgent'] {
  const priority: Array<OnboardingAgentStatus['id']> = ['claude-code', 'codex', 'opencode']

  const readyAgent = priority.find((id) => agents.some((agent) => agent.id === id && agent.selectable))
  if (readyAgent) return readyAgent

  const installedAgent = priority.find((id) => agents.some((agent) => agent.id === id && agent.installed))
  if (installedAgent) return installedAgent

  return 'terminal'
}

export async function runOnboardingDoctor(): Promise<OnboardingDoctorResult> {
  const [gitCheck, nodeCheck, homebrewCheck, xcodeCheck, claudeCheck, codexCheck, opencodeCheck] =
    await Promise.all([
      checkGit(),
      checkNode(),
      checkHomebrew(),
      checkXcodeCli(),
      checkClaudeCode(),
      checkCodex(),
      checkOpencode()
    ])

  const environmentChecks = [gitCheck, nodeCheck, homebrewCheck, xcodeCheck].filter(
    (check): check is OnboardingEnvironmentCheck => check !== null
  )

  const agents = [claudeCheck, codexCheck, opencodeCheck]

  return {
    platform: process.platform,
    environmentChecks,
    agents,
    recommendedAgent: pickRecommendedAgent(agents)
  }
}

function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export async function openCommandInSystemTerminal(
  command: string,
  options: { cwd?: string } = {}
): Promise<void> {
  const trimmed = command.trim()

  if (!trimmed) {
    throw new Error('Command is required')
  }

  const prefix = options.cwd ? `cd ${escapeShellArg(options.cwd)} && ` : ''
  const fullCommand = `${prefix}${trimmed}`

  if (process.platform === 'darwin') {
    await execCommand('osascript', [
      '-e',
      'tell application "Terminal" to activate',
      '-e',
      `tell application "Terminal" to do script "${escapeAppleScript(fullCommand)}"`
    ])
    return
  }

  if (process.platform === 'win32') {
    const cwdCommand = options.cwd
      ? `Set-Location '${options.cwd.replace(/'/g, "''")}'; `
      : ''
    const child = spawn('powershell.exe', ['-NoExit', '-Command', `${cwdCommand}${trimmed}`], {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    return
  }

  const child = spawn(
    'x-terminal-emulator',
    ['-e', 'bash', '-lc', `${fullCommand}; exec bash`],
    {
      detached: true,
      stdio: 'ignore'
    }
  )
  child.unref()
}
