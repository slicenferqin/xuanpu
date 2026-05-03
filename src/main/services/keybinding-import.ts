import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

import { createLogger } from './logger'
import type {
  KeybindingImportBinding,
  KeybindingImportEntry,
  KeybindingImportResult,
  KeybindingImportSourceId,
  KeybindingImportSourceInfo,
  KeybindingModifier
} from '@shared/types/keybinding-import'

const log = createLogger({ component: 'KeybindingImport' })

// ============================================================================
// Mapping: VS Code / Cursor command ID  →  Xuanpu shortcut id.
//
// We intentionally only map app-level shortcuts that have a direct Xuanpu
// counterpart. Editor-internal commands (cursorMove, etc.) are out of scope
// and will land in `unmapped` so the user understands why they were skipped.
// ============================================================================

export const VSCODE_COMMAND_TO_SHORTCUT: Record<string, string> = {
  // Navigation
  'workbench.action.showCommands': 'nav:command-palette',
  'workbench.action.quickOpen': 'nav:file-search',
  'workbench.action.openRecent': 'nav:session-history',

  // Sidebars
  'workbench.action.toggleSidebarVisibility': 'sidebar:toggle-left',
  'workbench.action.toggleAuxiliaryBar': 'sidebar:toggle-right',
  'workbench.action.focusFirstEditorGroup': 'focus:main-pane',
  'workbench.action.focusSideBar': 'focus:left-sidebar',

  // Terminal
  'workbench.action.terminal.new': 'terminal:new-tab',
  'workbench.action.terminal.kill': 'terminal:close-tab',
  'workbench.action.terminal.focusNext': 'terminal:next-tab',
  'workbench.action.terminal.focusPrevious': 'terminal:prev-tab',

  // Git (VS Code's Source Control panel)
  'workbench.scm.focus': 'git:commit',
  'git.commit': 'git:commit',
  'git.commitStaged': 'git:commit',
  'git.push': 'git:push',
  'git.pull': 'git:pull',

  // Settings
  'workbench.action.openSettings': 'settings:open',
  'workbench.action.openSettingsJson': 'settings:open'
}

// ============================================================================
// Source path resolution
// ============================================================================

function getKeybindingsPath(
  source: KeybindingImportSourceId,
  platform: NodeJS.Platform = process.platform
): string {
  const home = os.homedir()
  const folder = source === 'vscode' ? 'Code' : 'Cursor'

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', folder, 'User', 'keybindings.json')
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    return path.join(appData, folder, 'User', 'keybindings.json')
  }
  // linux + everything else
  return path.join(home, '.config', folder, 'User', 'keybindings.json')
}

export async function detectImportSources(): Promise<KeybindingImportSourceInfo[]> {
  const sources: KeybindingImportSourceId[] = ['vscode', 'cursor']
  const platform = process.platform

  return Promise.all(
    sources.map(async (id) => {
      const filepath = getKeybindingsPath(id, platform)
      let exists = false
      try {
        await fs.access(filepath)
        exists = true
      } catch {
        // not present
      }
      return {
        id,
        path: filepath,
        exists,
        available: exists
      }
    })
  )
}

// ============================================================================
// JSONC parser — VS Code allows // comments, slash-star block comments, and
// trailing commas in keybindings.json / settings.json.
// ============================================================================

/**
 * Strip `//` line comments and slash-star block comments while preserving
 * string literals (so a `// not a comment` substring inside quotes survives).
 */
export function stripJsonc(input: string): string {
  let out = ''
  let i = 0
  let inString = false
  let stringQuote = ''
  let inLineComment = false
  let inBlockComment = false

  while (i < input.length) {
    const ch = input[i]
    const next = input[i + 1]

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
        out += ch
      }
      i++
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i += 2
      } else {
        i++
      }
      continue
    }
    if (inString) {
      if (ch === '\\') {
        out += ch
        if (next !== undefined) out += next
        i += 2
        continue
      }
      if (ch === stringQuote) {
        inString = false
      }
      out += ch
      i++
      continue
    }

    if (ch === '"') {
      inString = true
      stringQuote = ch
      out += ch
      i++
      continue
    }
    if (ch === '/' && next === '/') {
      inLineComment = true
      i += 2
      continue
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

/** Strip trailing commas before `]` or `}` (legal in JSONC, illegal in JSON). */
export function stripTrailingCommas(input: string): string {
  return input.replace(/,(\s*[}\]])/g, '$1')
}

// ============================================================================
// Key-string parser — normalize "cmd+shift+p" into our KeyBinding shape.
// ============================================================================

const KEY_NAME_OVERRIDES: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  space: ' ',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown'
}

export function parseKeyString(keyString: string): KeybindingImportBinding | null {
  if (!keyString) return null
  // VS Code allows chord shortcuts: "ctrl+k ctrl+s". We only honor the first
  // chord — Xuanpu doesn't support chord bindings yet, and silently dropping
  // the second half is friendlier than refusing the whole import.
  const firstChord = keyString.split(/\s+/)[0]?.trim()
  if (!firstChord) return null

  const parts = firstChord
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null

  const modifiers: KeybindingModifier[] = []
  let key: string | null = null

  for (const part of parts) {
    if (part === 'cmd' || part === 'meta' || part === 'win' || part === 'super') {
      if (!modifiers.includes('meta')) modifiers.push('meta')
    } else if (part === 'ctrl' || part === 'control') {
      if (!modifiers.includes('ctrl')) modifiers.push('ctrl')
    } else if (part === 'alt' || part === 'option' || part === 'opt') {
      if (!modifiers.includes('alt')) modifiers.push('alt')
    } else if (part === 'shift') {
      if (!modifiers.includes('shift')) modifiers.push('shift')
    } else {
      key = part
    }
  }

  if (!key) return null

  // Normalize special keys to the names `event.key` would produce at runtime.
  const overridden = KEY_NAME_OVERRIDES[key]
  if (overridden) key = overridden

  return { key, modifiers }
}

// ============================================================================
// Top-level parse — read keybindings.json, map, and return entries.
// ============================================================================

interface RawKeybinding {
  key?: string
  command?: string
  when?: string
}

export async function parseImportSource(
  source: KeybindingImportSourceId
): Promise<KeybindingImportResult> {
  const filepath = getKeybindingsPath(source)
  const result: KeybindingImportResult = {
    source,
    path: filepath,
    parsedRows: 0,
    entries: [],
    unmapped: [],
    contextScoped: 0,
    errors: []
  }

  let raw: string
  try {
    raw = await fs.readFile(filepath, 'utf-8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`Failed to read ${filepath}: ${message}`)
    result.errors.push(`Failed to read ${filepath}: ${message}`)
    return result
  }

  let parsed: unknown
  try {
    const cleaned = stripTrailingCommas(stripJsonc(raw))
    parsed = JSON.parse(cleaned)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`JSONC parse error in ${filepath}: ${message}`)
    result.errors.push(`Could not parse keybindings.json: ${message}`)
    return result
  }

  if (!Array.isArray(parsed)) {
    result.errors.push('keybindings.json is not a JSON array')
    return result
  }

  result.parsedRows = parsed.length
  const unmappedSet = new Set<string>()

  for (const item of parsed as RawKeybinding[]) {
    if (!item || typeof item !== 'object') continue
    if (!item.command || !item.key) continue

    // VS Code uses "-command" prefix to delete a default binding. We have no
    // notion of un-binding (we only set custom overrides), so skip these.
    if (item.command.startsWith('-')) continue

    const shortcutId = VSCODE_COMMAND_TO_SHORTCUT[item.command]
    if (!shortcutId) {
      unmappedSet.add(item.command)
      continue
    }

    // `when` clauses scope a binding to a specific UI context (editor focus,
    // terminal focus, etc.). Xuanpu shortcuts are global, so honoring them
    // would silently change behavior — skip and surface the count.
    if (item.when) {
      result.contextScoped++
      continue
    }

    const binding = parseKeyString(item.key)
    if (!binding) {
      result.errors.push(`Could not parse key "${item.key}" for ${item.command}`)
      continue
    }

    result.entries.push({
      shortcutId,
      binding,
      sourceCommand: item.command,
      sourceKey: item.key
    })
  }

  // Deduplicate entries by shortcutId — if the user customized the same
  // command twice in their keybindings.json, the *last* one wins (matches
  // VS Code's own resolution order).
  const finalById = new Map<string, KeybindingImportEntry>()
  for (const entry of result.entries) {
    finalById.set(entry.shortcutId, entry)
  }
  result.entries = Array.from(finalById.values())
  result.unmapped = Array.from(unmappedSet).sort()

  return result
}
