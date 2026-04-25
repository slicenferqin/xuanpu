import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createLogger } from './logger'
import type { ModelProfile } from '@shared/types/model-profile'

const log = createLogger({ component: 'ModelProfileSync' })

/**
 * Sync resolved model profile env vars to `<cwd>/.claude/settings.local.json`
 * so the Claude CLI picks them up natively via its settingSources config.
 * Merges into existing settings — only touches ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL.
 */
export function syncProfileToClaudeSettings(
  targetPath: string,
  profile: ModelProfile | null
): void {
  const claudeDir = join(targetPath, '.claude')
  const settingsPath = join(claudeDir, 'settings.local.json')

  // Read existing settings (preserve user-set keys like permissions)
  let settings: Record<string, unknown> = {}
  try {
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    }
  } catch {
    settings = {}
  }

  // Ensure env section exists
  const env: Record<string, string> =
    settings.env && typeof settings.env === 'object'
      ? { ...(settings.env as Record<string, string>) }
      : {}

  // Set or clear managed keys
  if (profile?.api_key) {
    env.ANTHROPIC_API_KEY = profile.api_key
  } else {
    delete env.ANTHROPIC_API_KEY
  }

  if (profile?.base_url) {
    env.ANTHROPIC_BASE_URL = profile.base_url
  } else {
    delete env.ANTHROPIC_BASE_URL
  }

  // Merge settings_json env if present
  if (profile?.settings_json) {
    try {
      const profileSettings = JSON.parse(profile.settings_json)
      if (profileSettings.env && typeof profileSettings.env === 'object') {
        Object.assign(env, profileSettings.env as Record<string, string>)
      }
    } catch {
      // invalid JSON, skip
    }
  }

  settings.env = env

  // Write back with restrictive permissions (contains API key)
  mkdirSync(claudeDir, { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 })

  log.info('Synced model profile to .claude/settings.local.json', {
    path: settingsPath,
    hasApiKey: !!env.ANTHROPIC_API_KEY,
    baseUrl: env.ANTHROPIC_BASE_URL ?? '(not set)',
    envKeys: Object.keys(env)
  })
}
