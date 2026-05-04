import { describe, test, expect } from 'vitest'
import {
  DEFAULT_SHORTCUTS,
  KEYMAP_PRESETS,
  KEYMAP_PRESET_ORDER,
  buildPresetBindingMap,
  detectConflicts,
  presetOverridesAreValid,
  resolveBindingForPreset,
  serializeBinding,
  type KeymapPresetId
} from '../../src/renderer/src/lib/keyboard-shortcuts'

describe('Keymap Presets — structural integrity', () => {
  test('every preset id matches its key in KEYMAP_PRESETS', () => {
    for (const [id, meta] of Object.entries(KEYMAP_PRESETS)) {
      expect(meta.id).toBe(id)
    }
  })

  test('KEYMAP_PRESET_ORDER lists every preset exactly once', () => {
    const sortedKeys = [...Object.keys(KEYMAP_PRESETS)].sort()
    const sortedOrder = [...KEYMAP_PRESET_ORDER].sort()
    expect(sortedOrder).toEqual(sortedKeys)
  })

  test('preset overrides reference only known shortcut ids', () => {
    for (const presetId of KEYMAP_PRESET_ORDER) {
      expect(presetOverridesAreValid(presetId)).toBe(true)
    }
  })

  test('xuanpu-default preset has no overrides', () => {
    expect(KEYMAP_PRESETS['xuanpu-default'].overrides).toEqual({})
  })
})

describe('Keymap Presets — internal binding consistency', () => {
  // CRITICAL: Switching to any preset must not produce a self-conflict.
  // Otherwise Cmd+Shift+P would fire two shortcuts at once.
  for (const presetId of ['xuanpu-default', 'vscode', 'jetbrains'] as KeymapPresetId[]) {
    test(`preset "${presetId}" has zero internal conflicts`, () => {
      const bindings = buildPresetBindingMap(presetId)
      const seen = new Map<string, string>() // serialized binding -> shortcut id

      for (const [id, binding] of bindings) {
        const ser = serializeBinding(binding)
        if (seen.has(ser)) {
          throw new Error(
            `Preset "${presetId}" conflict: "${seen.get(ser)}" and "${id}" both bind to "${ser}"`
          )
        }
        seen.set(ser, id)
      }
    })
  }
})

describe('resolveBindingForPreset — priority', () => {
  test('returns custom binding when provided', () => {
    const custom = { key: 'q', modifiers: ['meta'] as const }
    const result = resolveBindingForPreset('nav:command-palette', 'vscode', {
      key: 'q',
      modifiers: ['meta']
    })
    expect(result).toEqual(custom)
  })

  test('returns preset override when no custom', () => {
    const result = resolveBindingForPreset('nav:command-palette', 'vscode')
    expect(result).toEqual({ key: 'p', modifiers: ['meta', 'shift'] })
  })

  test('returns DEFAULT_SHORTCUTS binding when preset has no override', () => {
    const result = resolveBindingForPreset('session:new', 'vscode')
    expect(result).toEqual({ key: 't', modifiers: ['meta'] })
  })

  test('returns null for unknown shortcut id', () => {
    expect(resolveBindingForPreset('does-not-exist', 'vscode')).toBeNull()
  })
})

describe('Preset content sanity (catches accidental drift)', () => {
  test('vscode preset overrides nav:command-palette to Cmd+Shift+P', () => {
    expect(KEYMAP_PRESETS.vscode.overrides['nav:command-palette']).toEqual({
      key: 'p',
      modifiers: ['meta', 'shift']
    })
  })

  test('jetbrains preset overrides nav:command-palette to Cmd+Shift+A (Find Action)', () => {
    expect(KEYMAP_PRESETS.jetbrains.overrides['nav:command-palette']).toEqual({
      key: 'a',
      modifiers: ['meta', 'shift']
    })
  })

  test('vscode preset frees Cmd+Shift+P from git:push (now alt+meta+p)', () => {
    expect(KEYMAP_PRESETS.vscode.overrides['git:push']).toEqual({
      key: 'p',
      modifiers: ['alt', 'meta']
    })
  })

  test('detectConflicts treats meta and ctrl as separate when serialized', () => {
    // Sanity: the conflict detector must distinguish ctrl-only vs meta-only,
    // even though eventMatchesBinding treats them as the same key at runtime.
    const map = new Map([
      ['a:1', { key: 't', modifiers: ['meta'] }],
      ['a:2', { key: 't', modifiers: ['ctrl'] }]
    ])
    const conflicts = detectConflicts({ key: 't', modifiers: ['meta'] }, map, 'a:1')
    expect(conflicts).toEqual([])
  })
})

describe('DEFAULT_SHORTCUTS still in sync with presets', () => {
  test('every shortcut id in DEFAULT_SHORTCUTS is unique', () => {
    const ids = DEFAULT_SHORTCUTS.map((s) => s.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  test('xuanpu-default applied = exactly DEFAULT_SHORTCUTS bindings', () => {
    const bindings = buildPresetBindingMap('xuanpu-default')
    expect(bindings.size).toBe(DEFAULT_SHORTCUTS.length)
    for (const def of DEFAULT_SHORTCUTS) {
      expect(bindings.get(def.id)).toEqual(def.defaultBinding)
    }
  })
})
