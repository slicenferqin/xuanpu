import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { execFile } from 'child_process'
import { join } from 'path'
import { homedir, platform } from 'os'
import { createLogger } from './logger'
import type { UsageData, UsageResult } from '@shared/types/usage'

export type { UsageData, UsageResult }

const log = createLogger({ component: 'UsageService' })

/**
 * Read the OAuth access token from macOS Keychain.
 * Claude Code v2.x stores credentials in the keychain under
 * service "Claude Code-credentials".
 */
async function readFromKeychain(): Promise<string | null> {
  if (platform() !== 'darwin') return null
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { timeout: 5000 },
        (error, out) => {
          if (error) reject(error)
          else resolve(out.trim())
        }
      )
    })
    if (!stdout) return null
    const creds = JSON.parse(stdout)
    return creds?.claudeAiOauth?.accessToken || null
  } catch {
    return null
  }
}

/**
 * Read the OAuth access token from the legacy credentials file.
 * Older Claude Code versions stored credentials at ~/.claude/.credentials.json.
 */
async function readFromFile(): Promise<string | null> {
  const credsPath = join(homedir(), '.claude', '.credentials.json')
  if (!existsSync(credsPath)) return null
  try {
    const raw = await readFile(credsPath, 'utf-8')
    const creds = JSON.parse(raw)
    return creds?.claudeAiOauth?.accessToken || null
  } catch {
    return null
  }
}

/**
 * Read the Claude OAuth access token.
 * Tries macOS Keychain first (v2.x), then falls back to credentials file.
 */
async function readAccessToken(): Promise<string | null> {
  const token = await readFromKeychain()
  if (token) return token
  return readFromFile()
}

async function checkClaudeAuthStatusCommand(): Promise<'authenticated' | 'unauthenticated' | null> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile('claude', ['auth', 'status', '--json'], { timeout: 5000 }, (error, out) => {
        if (error) reject(error)
        else resolve(out.trim())
      })
    })

    if (!stdout) return null

    const parsed = JSON.parse(stdout) as { loggedIn?: boolean }
    if (typeof parsed.loggedIn === 'boolean') {
      return parsed.loggedIn ? 'authenticated' : 'unauthenticated'
    }
  } catch {
    // Fall through to legacy checks
  }

  return null
}

async function hasClaudeSettingsCredential(): Promise<boolean> {
  const candidates = [
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), '.claude', 'settings.local.json')
  ]

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue

    try {
      const raw = await readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as {
        env?: Record<string, string | null | undefined>
      }
      const env = parsed.env ?? {}

      if (
        typeof env.ANTHROPIC_API_KEY === 'string' ||
        typeof env.ANTHROPIC_AUTH_TOKEN === 'string'
      ) {
        if ((env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || '').trim().length > 0) {
          return true
        }
      }
    } catch {
      // Ignore malformed local config and continue
    }
  }

  return false
}

async function hasClaudeEnvCredential(): Promise<boolean> {
  const directCandidates = [process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN]
  return directCandidates.some((value) => typeof value === 'string' && value.trim().length > 0)
}

export async function checkClaudeAuth(): Promise<'authenticated' | 'unauthenticated'> {
  const statusFromCli = await checkClaudeAuthStatusCommand()
  if (statusFromCli) return statusFromCli

  if (await hasClaudeEnvCredential()) {
    return 'authenticated'
  }

  if (await hasClaudeSettingsCredential()) {
    return 'authenticated'
  }

  const token = await readAccessToken()
  return token ? 'authenticated' : 'unauthenticated'
}

export async function fetchClaudeUsage(): Promise<UsageResult> {
  const token = await readAccessToken()
  if (!token) {
    log.warn('No Claude OAuth access token found (checked keychain and credentials file)')
    return { success: false, error: 'No access token found' }
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const message = `Usage API returned ${response.status}: ${response.statusText}`
      log.warn(message)
      return { success: false, error: message }
    }

    const data = (await response.json()) as UsageData
    return { success: true, data }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('Failed to fetch Claude usage', { error: message })
    return { success: false, error: message }
  }
}
