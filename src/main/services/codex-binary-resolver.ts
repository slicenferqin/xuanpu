import { createLogger } from './logger'
import {
  executeLaunchSpec,
  resolveCommandLaunchSpec,
  type CommandLaunchSpec
} from './command-launch-utils'

const log = createLogger({ component: 'CodexBinaryResolver' })

export type CodexLaunchSpec = CommandLaunchSpec

export interface CodexLaunchInfo {
  spec: CodexLaunchSpec | null
  version: string | null
  supportsAppServer: boolean
}

function parseVersionOutput(output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed) return null

  const prefixed = trimmed.match(/codex[\s/]+(\S+)/i)
  if (prefixed) return prefixed[1]

  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? ''
  const versionMatch = firstLine.match(/(\d+\.\d+\.\d+[\w.-]*)/)
  return versionMatch ? versionMatch[1] : firstLine || null
}

export async function resolveCodexLaunchSpec(): Promise<CodexLaunchSpec | null> {
  const spec = await resolveCommandLaunchSpec('codex')
  if (!spec) {
    log.warn('Could not resolve Codex binary')
    return null
  }

  log.info('Resolved Codex binary', { command: spec.command, shell: spec.shell })
  return spec
}

export async function getCodexVersion(spec?: CodexLaunchSpec | null): Promise<string | null> {
  const resolved = spec ?? (await resolveCodexLaunchSpec())
  if (!resolved) return null

  try {
    const { stdout, stderr } = await executeLaunchSpec(resolved, ['--version'])
    return parseVersionOutput(`${stdout}\n${stderr}`)
  } catch (error) {
    log.debug('Codex version check failed', {
      command: resolved.command,
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

export async function probeCodexAppServerSupport(
  spec?: CodexLaunchSpec | null
): Promise<boolean> {
  const resolved = spec ?? (await resolveCodexLaunchSpec())
  if (!resolved) return false

  try {
    const { stdout, stderr } = await executeLaunchSpec(resolved, ['app-server', '--help'], {
      timeoutMs: 8000
    })
    const output = `${stdout}\n${stderr}`.toLowerCase()
    return output.includes('app-server') || output.includes('json-rpc') || output.includes('usage')
  } catch (error) {
    log.warn('Codex app-server capability probe failed', {
      command: resolved.command,
      error: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

export async function getCodexLaunchInfo(): Promise<CodexLaunchInfo> {
  const spec = await resolveCodexLaunchSpec()
  if (!spec) {
    return { spec: null, version: null, supportsAppServer: false }
  }

  const [version, supportsAppServer] = await Promise.all([
    getCodexVersion(spec),
    probeCodexAppServerSupport(spec)
  ])

  return { spec, version, supportsAppServer }
}

export async function ensureCodexAppServerLaunchSpec(): Promise<CodexLaunchSpec> {
  const info = await getCodexLaunchInfo()
  if (!info.spec) {
    throw new Error('Codex CLI not found on PATH')
  }

  if (!info.supportsAppServer) {
    const versionLabel = info.version ? ` (${info.version})` : ''
    throw new Error(
      `Codex CLI${versionLabel} does not support \`codex app-server\`. Upgrade @openai/codex and try again.`
    )
  }

  return info.spec
}
