import { createLogger } from './logger'
import {
  executeLaunchSpec,
  resolveCommandLaunchSpec,
  type CommandLaunchSpec
} from './command-launch-utils'

const log = createLogger({ component: 'OpenCodeBinaryResolver' })

export type OpenCodeLaunchSpec = CommandLaunchSpec

function parseVersionOutput(output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed) return null

  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? ''
  const match = firstLine.match(/v?\d+\.\d+\.\d+(?:[-+.\w]*)?/)
  return match ? match[0] : firstLine || null
}

export async function resolveOpenCodeLaunchSpec(): Promise<OpenCodeLaunchSpec | null> {
  const spec = await resolveCommandLaunchSpec('opencode')
  if (!spec) {
    log.warn('Could not resolve OpenCode binary')
    return null
  }

  log.info('Resolved OpenCode binary', { command: spec.command, shell: spec.shell })
  return spec
}

export async function getOpenCodeVersion(
  spec?: OpenCodeLaunchSpec | null
): Promise<string | null> {
  const resolved = spec ?? (await resolveOpenCodeLaunchSpec())
  if (!resolved) return null

  try {
    const { stdout, stderr } = await executeLaunchSpec(resolved, ['--version'])
    return parseVersionOutput(`${stdout}\n${stderr}`)
  } catch (error) {
    log.debug('OpenCode version check failed', {
      command: resolved.command,
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

export async function canLaunchOpenCode(): Promise<boolean> {
  const spec = await resolveOpenCodeLaunchSpec()
  if (!spec) return false
  return (await getOpenCodeVersion(spec)) !== null
}
