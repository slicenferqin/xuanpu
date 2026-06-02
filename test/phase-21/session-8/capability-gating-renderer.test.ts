import { describe, it, expect } from 'vitest'
import {
  BUILT_IN_SLASH_COMMANDS,
  type SlashCommandInfo
} from '../../../src/renderer/src/lib/session-commands'

/**
 * Unit tests for slash-command filtering logic based on runtime capabilities.
 *
 * We extract the pure filtering logic from the session command menu so we can
 * test it without rendering the full component.
 */

interface Capabilities {
  supportsUndo: boolean
  supportsRedo: boolean
}

/**
 * Mirror of the filtering logic in the command menu's allSlashCommands useMemo.
 */
function filterSlashCommands(
  customCommands: SlashCommandInfo[],
  capabilities: Capabilities | null
): SlashCommandInfo[] {
  const seen = new Set<string>()
  const ordered = [...BUILT_IN_SLASH_COMMANDS, ...customCommands]
  return ordered.filter((command) => {
    const key = command.name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    if (key === 'undo' && capabilities && !capabilities.supportsUndo) return false
    if (key === 'redo' && capabilities && !capabilities.supportsRedo) return false
    return true
  })
}

describe('Slash command capability filtering', () => {
  it('shows all built-in commands when capabilities is null (not yet loaded)', () => {
    const result = filterSlashCommands([], null)
    const names = result.map((c) => c.name)
    expect(names).toContain('undo')
    expect(names).toContain('redo')
    expect(names).toContain('clear')
  })

  it('shows all commands when both undo and redo are supported', () => {
    const result = filterSlashCommands([], { supportsUndo: true, supportsRedo: true })
    const names = result.map((c) => c.name)
    expect(names).toContain('undo')
    expect(names).toContain('redo')
    expect(names).toContain('clear')
  })

  it('hides redo when supportsRedo is false', () => {
    const result = filterSlashCommands([], { supportsUndo: true, supportsRedo: false })
    const names = result.map((c) => c.name)
    expect(names).toContain('undo')
    expect(names).not.toContain('redo')
    expect(names).toContain('clear')
  })

  it('hides undo when supportsUndo is false', () => {
    const result = filterSlashCommands([], { supportsUndo: false, supportsRedo: true })
    const names = result.map((c) => c.name)
    expect(names).not.toContain('undo')
    expect(names).toContain('redo')
    expect(names).toContain('clear')
  })

  it('hides both undo and redo when neither is supported', () => {
    const result = filterSlashCommands([], { supportsUndo: false, supportsRedo: false })
    const names = result.map((c) => c.name)
    expect(names).not.toContain('undo')
    expect(names).not.toContain('redo')
    expect(names).toContain('clear')
  })

  it('deduplicates custom commands that overlap with built-ins', () => {
    const custom: SlashCommandInfo[] = [
      { name: 'undo', description: 'Custom undo', template: '/undo' }
    ]
    const result = filterSlashCommands(custom, { supportsUndo: true, supportsRedo: true })
    const undoCommands = result.filter((c) => c.name.toLowerCase() === 'undo')
    expect(undoCommands).toHaveLength(1)
    // Built-in comes first so it wins
    expect(undoCommands[0].builtIn).toBe(true)
  })

  it('preserves custom commands unrelated to undo/redo', () => {
    const custom: SlashCommandInfo[] = [
      { name: 'deploy', description: 'Deploy the app', template: '/deploy' }
    ]
    const result = filterSlashCommands(custom, { supportsUndo: false, supportsRedo: false })
    const names = result.map((c) => c.name)
    expect(names).toContain('deploy')
    expect(names).toContain('clear')
  })
})
