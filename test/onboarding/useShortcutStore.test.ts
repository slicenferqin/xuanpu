import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useShortcutStore } from '../../src/renderer/src/stores/useShortcutStore'
import { DEFAULT_KEYMAP_PRESET } from '../../src/renderer/src/lib/keyboard-shortcuts'

// Avoid the SQLite IPC layer leaking into tests
beforeEach(() => {
  vi.stubGlobal('window', {
    ...((globalThis as { window?: object }).window ?? {}),
    db: {
      setting: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined)
      }
    }
  })

  // Clear localStorage so persist middleware starts clean each test
  localStorage.clear()

  // Reset store to a clean baseline
  useShortcutStore.setState({
    customBindings: {},
    activePreset: DEFAULT_KEYMAP_PRESET
  })
})

describe('useShortcutStore — preset switching', () => {
  test('default activePreset is xuanpu-default', () => {
    expect(useShortcutStore.getState().activePreset).toBe('xuanpu-default')
  })

  test('setActivePreset updates state and reports zero collisions when no customBindings', () => {
    const result = useShortcutStore.getState().setActivePreset('vscode')
    expect(result.customCollisions).toEqual([])
    expect(useShortcutStore.getState().activePreset).toBe('vscode')
  })

  test('after switching to vscode, getEffectiveBinding returns Cmd+Shift+P for command palette', () => {
    useShortcutStore.getState().setActivePreset('vscode')
    const binding = useShortcutStore.getState().getEffectiveBinding('nav:command-palette')
    expect(binding).toEqual({ key: 'p', modifiers: ['meta', 'shift'] })
  })

  test('after switching to jetbrains, file search is Cmd+Shift+O (Search Everywhere)', () => {
    useShortcutStore.getState().setActivePreset('jetbrains')
    const binding = useShortcutStore.getState().getEffectiveBinding('nav:file-search')
    expect(binding).toEqual({ key: 'o', modifiers: ['meta', 'shift'] })
  })

  test('shortcut not in preset overrides falls back to DEFAULT_SHORTCUTS', () => {
    useShortcutStore.getState().setActivePreset('vscode')
    // session:new is not in any preset override
    const binding = useShortcutStore.getState().getEffectiveBinding('session:new')
    expect(binding).toEqual({ key: 't', modifiers: ['meta'] })
  })
})

describe('useShortcutStore — custom bindings keep priority over preset', () => {
  test('customBindings remain active after switching preset', () => {
    // User customizes command-palette to something completely different
    const customBinding = { key: 'q', modifiers: ['meta', 'alt'] as const }
    useShortcutStore.setState({
      customBindings: { 'nav:command-palette': customBinding }
    })

    // Switch to vscode preset
    useShortcutStore.getState().setActivePreset('vscode')

    // The custom binding should still win
    const binding = useShortcutStore.getState().getEffectiveBinding('nav:command-palette')
    expect(binding).toEqual(customBinding)
  })

  test('setActivePreset reports collisions when customBindings differ from preset overrides', () => {
    // User customized command-palette; vscode preset also remaps it (but to a different value)
    useShortcutStore.setState({
      customBindings: {
        'nav:command-palette': { key: 'q', modifiers: ['meta', 'alt'] }
      }
    })

    const result = useShortcutStore.getState().setActivePreset('vscode')
    expect(result.customCollisions).toContain('nav:command-palette')
  })

  test('setActivePreset reports no collision when custom equals preset override', () => {
    // User happens to have customized to the same value vscode would set
    useShortcutStore.setState({
      customBindings: {
        'nav:command-palette': { key: 'p', modifiers: ['meta', 'shift'] }
      }
    })

    const result = useShortcutStore.getState().setActivePreset('vscode')
    expect(result.customCollisions).toEqual([])
  })

  test('setActivePreset ignores customBindings on shortcuts the preset does not remap', () => {
    // User customizes session:new (not in any preset) — switching preset should not flag it
    useShortcutStore.setState({
      customBindings: {
        'session:new': { key: 'q', modifiers: ['meta'] }
      }
    })

    const result = useShortcutStore.getState().setActivePreset('vscode')
    expect(result.customCollisions).toEqual([])
  })
})

describe('useShortcutStore — getAllEffectiveBindings includes preset overrides', () => {
  test('vscode preset shifts command-palette and file-search into resolved map', () => {
    useShortcutStore.getState().setActivePreset('vscode')
    const all = useShortcutStore.getState().getAllEffectiveBindings()
    expect(all.get('nav:command-palette')).toEqual({ key: 'p', modifiers: ['meta', 'shift'] })
    expect(all.get('nav:file-search')).toEqual({ key: 'p', modifiers: ['meta'] })
  })
})

describe('useShortcutStore — resetToDefaults', () => {
  test('clears customBindings and resets preset to xuanpu-default', () => {
    useShortcutStore.setState({
      customBindings: { 'session:new': { key: 'q', modifiers: ['meta'] } },
      activePreset: 'vscode'
    })

    useShortcutStore.getState().resetToDefaults()

    const state = useShortcutStore.getState()
    expect(state.customBindings).toEqual({})
    expect(state.activePreset).toBe('xuanpu-default')
  })
})

describe('useShortcutStore — conflict detection respects active preset', () => {
  test('cannot set custom binding that collides with preset override on a sibling', () => {
    // Under vscode preset, nav:command-palette = Cmd+Shift+P. Trying to assign the
    // same combo to git:push must be rejected.
    useShortcutStore.getState().setActivePreset('vscode')

    const result = useShortcutStore
      .getState()
      .setCustomBinding('git:push', { key: 'p', modifiers: ['meta', 'shift'] })

    expect(result.success).toBe(false)
    expect(result.conflicts).toContain('nav:command-palette')
  })
})
