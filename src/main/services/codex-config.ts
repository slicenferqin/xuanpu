import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface CodexConfigSection {
  values: Record<string, string>
}

export interface CodexConfig {
  model?: string
  modelContextWindow?: number
  activeProfile?: string
  profiles: Record<string, CodexConfigSection>
}

function stripInlineComment(line: string): string {
  let inString = false
  let quote: '"' | "'" | null = null

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if ((ch === '"' || ch === "'") && line[i - 1] !== '\\') {
      if (!inString) {
        inString = true
        quote = ch
      } else if (quote === ch) {
        inString = false
        quote = null
      }
    }
    if (ch === '#' && !inString) {
      return line.slice(0, i).trim()
    }
  }

  return line.trim()
}

function parseTomlScalar(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function toPositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

export function getCodexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  return join(codexHome, 'config.toml')
}

export function parseCodexConfigToml(raw: string): CodexConfig {
  const root: Record<string, string> = {}
  const profiles: Record<string, CodexConfigSection> = {}
  let current: Record<string, string> = root

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = stripInlineComment(rawLine)
    if (!line) continue

    const sectionMatch = line.match(/^\[([^\]]+)\]$/)
    if (sectionMatch) {
      const section = sectionMatch[1]?.trim() ?? ''
      const profileMatch = section.match(/^profiles\.([A-Za-z0-9_.-]+)$/)
      if (profileMatch) {
        const profileName = profileMatch[1]!
        profiles[profileName] = profiles[profileName] ?? { values: {} }
        current = profiles[profileName].values
      } else {
        current = {}
      }
      continue
    }

    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/)
    if (!assignment) continue
    current[assignment[1]!] = parseTomlScalar(assignment[2]!)
  }

  const activeProfile = root.profile
  const profileValues = activeProfile ? profiles[activeProfile]?.values : undefined

  return {
    model: profileValues?.model ?? root.model,
    modelContextWindow:
      toPositiveInteger(profileValues?.model_context_window) ??
      toPositiveInteger(root.model_context_window),
    activeProfile,
    profiles
  }
}

export function readCodexConfig(): CodexConfig | null {
  const configPath = getCodexConfigPath()
  if (!existsSync(configPath)) return null
  try {
    return parseCodexConfigToml(readFileSync(configPath, 'utf-8'))
  } catch {
    return null
  }
}

export function getCodexConfiguredModel(): string | undefined {
  return readCodexConfig()?.model
}

export function getCodexConfiguredContextWindow(): number | undefined {
  return readCodexConfig()?.modelContextWindow
}
