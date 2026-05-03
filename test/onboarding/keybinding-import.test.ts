import { describe, test, expect, vi, beforeEach } from 'vitest'

import {
  stripJsonc,
  stripTrailingCommas,
  parseKeyString,
  parseImportSource,
  detectImportSources,
  VSCODE_COMMAND_TO_SHORTCUT
} from '../../src/main/services/keybinding-import'

// fs mock — every test resets the mock state
vi.mock('node:fs/promises', () => ({
  default: {},
  access: vi.fn(),
  readFile: vi.fn()
}))

// minimal logger mock so we don't try to write to disk
vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import * as fs from 'node:fs/promises'

beforeEach(() => {
  vi.clearAllMocks()
})

// ============================================================================
// JSONC parser
// ============================================================================

describe('stripJsonc', () => {
  test('removes line comments', () => {
    expect(stripJsonc('// hi\n{"a":1}')).toBe('\n{"a":1}')
  })

  test('removes block comments', () => {
    expect(stripJsonc('/* hi */{"a":1}')).toBe('{"a":1}')
  })

  test('keeps comment-like substrings inside strings', () => {
    expect(stripJsonc('{"key":"// not a comment"}')).toBe('{"key":"// not a comment"}')
  })

  test('handles escaped quotes inside strings', () => {
    expect(stripJsonc('{"key":"a\\"b // c"}')).toBe('{"key":"a\\"b // c"}')
  })

  test('removes both line and block comments interleaved', () => {
    const input = `[
      // first
      { "key": "a" },
      /* between */
      { "key": "b" } // trailing
    ]`
    const out = stripJsonc(input)
    expect(out).not.toContain('// first')
    expect(out).not.toContain('/* between */')
    expect(out).not.toContain('// trailing')
  })
})

describe('stripTrailingCommas', () => {
  test('removes trailing comma before closing brace', () => {
    expect(stripTrailingCommas('{"a":1,}')).toBe('{"a":1}')
  })
  test('removes trailing comma before closing bracket', () => {
    expect(stripTrailingCommas('[1,2,]')).toBe('[1,2]')
  })
  test('preserves valid commas', () => {
    expect(stripTrailingCommas('[1,2,3]')).toBe('[1,2,3]')
  })
})

// ============================================================================
// parseKeyString
// ============================================================================

describe('parseKeyString', () => {
  test('parses cmd+shift+p', () => {
    expect(parseKeyString('cmd+shift+p')).toEqual({
      key: 'p',
      modifiers: ['meta', 'shift']
    })
  })

  test('parses ctrl+f', () => {
    expect(parseKeyString('ctrl+f')).toEqual({
      key: 'f',
      modifiers: ['ctrl']
    })
  })

  test('parses alt+enter and normalizes the key name', () => {
    expect(parseKeyString('alt+enter')).toEqual({
      key: 'Enter',
      modifiers: ['alt']
    })
  })

  test('parses chord shortcut by taking only the first chord', () => {
    expect(parseKeyString('ctrl+k ctrl+s')).toEqual({
      key: 'k',
      modifiers: ['ctrl']
    })
  })

  test('handles uppercase mixed input', () => {
    expect(parseKeyString('CMD+SHIFT+P')).toEqual({
      key: 'p',
      modifiers: ['meta', 'shift']
    })
  })

  test('treats win/super as meta', () => {
    expect(parseKeyString('win+a')).toEqual({ key: 'a', modifiers: ['meta'] })
    expect(parseKeyString('super+a')).toEqual({ key: 'a', modifiers: ['meta'] })
  })

  test('treats option as alt', () => {
    expect(parseKeyString('option+t')).toEqual({ key: 't', modifiers: ['alt'] })
  })

  test('returns null when there is no non-modifier key', () => {
    expect(parseKeyString('cmd+shift')).toBeNull()
  })

  test('returns null on empty string', () => {
    expect(parseKeyString('')).toBeNull()
  })

  test('normalizes arrow keys', () => {
    expect(parseKeyString('cmd+up')).toEqual({ key: 'ArrowUp', modifiers: ['meta'] })
  })

  test('does not duplicate modifiers when listed twice', () => {
    expect(parseKeyString('cmd+meta+a')).toEqual({ key: 'a', modifiers: ['meta'] })
  })
})

// ============================================================================
// VSCODE_COMMAND_TO_SHORTCUT mapping
// ============================================================================

describe('VSCODE_COMMAND_TO_SHORTCUT', () => {
  test('maps the most-used commands to Xuanpu shortcuts', () => {
    expect(VSCODE_COMMAND_TO_SHORTCUT['workbench.action.showCommands']).toBe('nav:command-palette')
    expect(VSCODE_COMMAND_TO_SHORTCUT['workbench.action.quickOpen']).toBe('nav:file-search')
    expect(VSCODE_COMMAND_TO_SHORTCUT['workbench.action.terminal.new']).toBe('terminal:new-tab')
    expect(VSCODE_COMMAND_TO_SHORTCUT['git.push']).toBe('git:push')
  })

  test('does not contain values that point at non-existent shortcut categories', () => {
    // crude sanity: every value uses the {category}:{action} convention
    for (const value of Object.values(VSCODE_COMMAND_TO_SHORTCUT)) {
      expect(value).toMatch(/^[a-z]+(?:-[a-z]+)*:[a-z-]+$/)
    }
  })
})

// ============================================================================
// parseImportSource (full pipeline)
// ============================================================================

describe('parseImportSource', () => {
  test('returns errors when the file does not exist', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'))

    const result = await parseImportSource('vscode')

    expect(result.entries).toEqual([])
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toMatch(/Failed to read/)
  })

  test('returns errors when the file is not a JSON array', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('{"key":"value"}')

    const result = await parseImportSource('vscode')

    expect(result.errors).toContain('keybindings.json is not a JSON array')
  })

  test('returns errors when the file is malformed JSONC', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('this is not json at all')

    const result = await parseImportSource('vscode')

    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toMatch(/Could not parse keybindings\.json/)
  })

  test('maps known commands and skips unmapped ones', async () => {
    const file = `[
      // mapped — VS Code default for the command palette
      { "key": "cmd+shift+p", "command": "workbench.action.showCommands" },
      // mapped — terminal new tab
      { "key": "cmd+shift+grave", "command": "workbench.action.terminal.new" },
      // unmapped — editor-internal
      { "key": "cmd+d", "command": "editor.action.addSelectionToNextFindMatch" },
    ]`
    vi.mocked(fs.readFile).mockResolvedValue(file)

    const result = await parseImportSource('vscode')

    expect(result.parsedRows).toBe(3)
    expect(result.entries.length).toBe(2)
    expect(result.entries.map((e) => e.shortcutId).sort()).toEqual([
      'nav:command-palette',
      'terminal:new-tab'
    ])
    expect(result.unmapped).toContain('editor.action.addSelectionToNextFindMatch')
  })

  test('skips rows with a `when` clause but counts them', async () => {
    const file = `[
      { "key": "cmd+shift+p", "command": "workbench.action.showCommands", "when": "editorTextFocus" }
    ]`
    vi.mocked(fs.readFile).mockResolvedValue(file)

    const result = await parseImportSource('vscode')

    expect(result.entries).toEqual([])
    expect(result.contextScoped).toBe(1)
  })

  test('skips VS Code "-command" unbinds', async () => {
    const file = `[
      { "key": "cmd+t", "command": "-workbench.action.tasks.runTask" }
    ]`
    vi.mocked(fs.readFile).mockResolvedValue(file)

    const result = await parseImportSource('vscode')

    expect(result.entries).toEqual([])
    expect(result.unmapped).toEqual([])
  })

  test('deduplicates by shortcutId — last entry wins', async () => {
    const file = `[
      { "key": "cmd+1", "command": "workbench.action.quickOpen" },
      { "key": "cmd+e", "command": "workbench.action.quickOpen" }
    ]`
    vi.mocked(fs.readFile).mockResolvedValue(file)

    const result = await parseImportSource('vscode')

    expect(result.entries.length).toBe(1)
    expect(result.entries[0].sourceKey).toBe('cmd+e')
  })

  test('sorts unmapped commands and dedupes them', async () => {
    const file = `[
      { "key": "cmd+a", "command": "z.command" },
      { "key": "cmd+b", "command": "a.command" },
      { "key": "cmd+c", "command": "z.command" }
    ]`
    vi.mocked(fs.readFile).mockResolvedValue(file)

    const result = await parseImportSource('vscode')

    expect(result.unmapped).toEqual(['a.command', 'z.command'])
  })
})

// ============================================================================
// detectImportSources
// ============================================================================

describe('detectImportSources', () => {
  test('reports both vscode and cursor entries with platform-aware paths', async () => {
    vi.mocked(fs.access).mockResolvedValue(undefined as unknown as void)

    const sources = await detectImportSources()

    expect(sources).toHaveLength(2)
    expect(sources.map((s) => s.id).sort()).toEqual(['cursor', 'vscode'])
    for (const s of sources) {
      expect(s.exists).toBe(true)
      expect(s.path.length).toBeGreaterThan(0)
    }
  })

  test('marks `exists: false` when the file is unreadable', async () => {
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'))

    const sources = await detectImportSources()

    expect(sources.every((s) => !s.exists)).toBe(true)
  })
})
