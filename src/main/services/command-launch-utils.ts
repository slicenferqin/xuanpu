import { execFile, spawn, type ChildProcess, type ExecFileOptions, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'

export interface CommandLaunchSpec {
  command: string
  shell: boolean
}

export interface CommandExecutionResult {
  stdout: string
  stderr: string
}

const RESOLVE_TIMEOUT_MS = 5000

function normalizeOutputLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function looksLikePath(command: string): boolean {
  return isAbsolute(command) || command.includes('/') || command.includes('\\')
}

export function shouldUseShellForCommand(command: string): boolean {
  if (process.platform !== 'win32') return false
  return ['.cmd', '.bat', '.com'].includes(extname(command).toLowerCase())
}

export function buildLaunchSpec(command: string): CommandLaunchSpec {
  return {
    command,
    shell: shouldUseShellForCommand(command)
  }
}

async function execFileCapture(
  command: string,
  args: string[],
  options: ExecFileOptions
): Promise<CommandExecutionResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? ''
      })
    })
  })
}

export async function executeLaunchSpec(
  spec: CommandLaunchSpec,
  args: string[],
  options: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<CommandExecutionResult> {
  return execFileCapture(spec.command, args, {
    encoding: 'utf-8',
    timeout: options.timeoutMs ?? RESOLVE_TIMEOUT_MS,
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: spec.shell,
    windowsHide: true
  })
}

export function spawnLaunchSpec(
  spec: CommandLaunchSpec,
  args: string[],
  options: SpawnOptions = {}
): ChildProcess {
  return spawn(spec.command, args, {
    ...options,
    shell: spec.shell
  })
}

async function resolveCommandCandidates(binary: string): Promise<string[]> {
  const resolver = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout, stderr } = await execFileCapture(resolver, [binary], {
      encoding: 'utf-8',
      timeout: RESOLVE_TIMEOUT_MS,
      env: process.env,
      windowsHide: true
    })
    return Array.from(new Set(normalizeOutputLines(`${stdout}\n${stderr}`)))
  } catch {
    return []
  }
}

function scoreWindowsCandidate(candidate: string): number {
  const lower = candidate.toLowerCase()
  let score = 0

  if (lower.includes('\\windowsapps\\')) {
    score -= 100
  }

  const extension = extname(lower)
  if (extension === '.exe') score += 40
  if (extension === '.cmd') score += 30
  if (extension === '.bat') score += 20
  if (extension === '.com') score += 10

  if (lower.includes('\\appdata\\roaming\\npm\\')) score += 8
  if (lower.includes('\\nvm\\')) score += 4

  return score
}

function selectResolvedCommand(candidates: string[]): string | null {
  const existing = candidates.filter((candidate) => existsSync(candidate))
  if (existing.length === 0) return null

  if (process.platform !== 'win32') {
    return existing[0]
  }

  return [...existing].sort((left, right) => scoreWindowsCandidate(right) - scoreWindowsCandidate(left))[0]
}

export async function resolveCommandLaunchSpec(command: string): Promise<CommandLaunchSpec | null> {
  if (looksLikePath(command)) {
    return existsSync(command) ? buildLaunchSpec(command) : null
  }

  const candidates = await resolveCommandCandidates(command)
  const selected = selectResolvedCommand(candidates)
  return selected ? buildLaunchSpec(selected) : null
}
