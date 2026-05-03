import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import {
  type KeyBinding,
  type KeymapPresetId,
  DEFAULT_SHORTCUTS,
  DEFAULT_KEYMAP_PRESET,
  KEYMAP_PRESETS,
  detectConflicts,
  formatBinding,
  resolveBindingForPreset,
  serializeBinding
} from '@/lib/keyboard-shortcuts'

const SHORTCUTS_SETTING_KEY = 'keyboard_shortcuts'
const KEYMAP_PRESET_SETTING_KEY = 'keymap_preset'

export interface ShortcutImportEntry {
  shortcutId: string
  binding: KeyBinding
}

export interface ShortcutImportApplyResult {
  applied: number
  /** Pairs of shortcut ids that share the same effective binding after import. */
  conflicts: Array<[string, string]>
}

interface ShortcutState {
  // Custom bindings - keyed by shortcut ID. Always wins over preset overrides.
  customBindings: Record<string, KeyBinding>

  // Currently selected keymap preset. Lives between DEFAULT_SHORTCUTS and customBindings.
  activePreset: KeymapPresetId

  // Actions
  setCustomBinding: (
    shortcutId: string,
    binding: KeyBinding
  ) => { success: boolean; conflicts?: string[] }
  removeCustomBinding: (shortcutId: string) => void
  resetToDefaults: () => void
  setActivePreset: (preset: KeymapPresetId) => { customCollisions: string[] }
  /**
   * Bulk-apply imported keybindings (e.g. from VS Code / Cursor). Bypasses the
   * standard conflict guard — the import is treated as user intent and wins
   * over earlier customizations. Conflicts that result are surfaced in the
   * return value so the UI can warn the user.
   */
  applyImportEntries: (entries: ShortcutImportEntry[]) => ShortcutImportApplyResult
  getEffectiveBinding: (shortcutId: string) => KeyBinding | null
  getAllEffectiveBindings: () => Map<string, KeyBinding>
  getConflicts: (shortcutId: string, binding: KeyBinding) => string[]
  getDisplayString: (shortcutId: string) => string
  loadFromDatabase: () => Promise<void>
}

export const useShortcutStore = create<ShortcutState>()(
  persist(
    (set, get) => ({
      customBindings: {},
      activePreset: DEFAULT_KEYMAP_PRESET,

      setCustomBinding: (shortcutId: string, binding: KeyBinding) => {
        const allBindings = get().getAllEffectiveBindings()
        const conflicts = detectConflicts(binding, allBindings, shortcutId)

        if (conflicts.length > 0) {
          return { success: false, conflicts }
        }

        set((state) => {
          const newBindings = { ...state.customBindings, [shortcutId]: binding }
          // Persist to database async
          saveBindingsToDatabase(newBindings)
          return { customBindings: newBindings }
        })

        return { success: true }
      },

      removeCustomBinding: (shortcutId: string) => {
        set((state) => {
          const newBindings = { ...state.customBindings }
          delete newBindings[shortcutId]
          saveBindingsToDatabase(newBindings)
          return { customBindings: newBindings }
        })
      },

      resetToDefaults: () => {
        set({ customBindings: {}, activePreset: DEFAULT_KEYMAP_PRESET })
        saveBindingsToDatabase({})
        savePresetToDatabase(DEFAULT_KEYMAP_PRESET)
      },

      setActivePreset: (preset: KeymapPresetId) => {
        // Detect which custom bindings would now mask non-default preset overrides
        // (i.e., user customized a shortcut that this preset also remaps).
        const customBindings = get().customBindings
        const overrides = KEYMAP_PRESETS[preset]?.overrides ?? {}
        const customCollisions: string[] = []

        for (const id of Object.keys(customBindings)) {
          const presetBinding = overrides[id]
          if (!presetBinding) continue
          // If the customization actually differs from what the preset would set,
          // the user's choice will override the preset and is worth flagging.
          if (serializeBinding(customBindings[id]) !== serializeBinding(presetBinding)) {
            customCollisions.push(id)
          }
        }

        set({ activePreset: preset })
        savePresetToDatabase(preset)

        return { customCollisions }
      },

      applyImportEntries: (entries: ShortcutImportEntry[]) => {
        if (entries.length === 0) {
          return { applied: 0, conflicts: [] }
        }

        const newBindings: Record<string, KeyBinding> = { ...get().customBindings }
        for (const entry of entries) {
          newBindings[entry.shortcutId] = entry.binding
        }

        set({ customBindings: newBindings })
        saveBindingsToDatabase(newBindings)

        // Post-apply conflict scan: walk the new effective binding map and
        // surface any duplicate (key, modifiers) pairs across shortcut ids.
        const effective = new Map<string, KeyBinding>()
        const { activePreset } = get()
        for (const def of DEFAULT_SHORTCUTS) {
          const binding = resolveBindingForPreset(def.id, activePreset, newBindings[def.id])
          if (binding) effective.set(def.id, binding)
        }

        const seen = new Map<string, string>()
        const conflicts: Array<[string, string]> = []
        for (const [id, binding] of effective) {
          const key = serializeBinding(binding)
          const prior = seen.get(key)
          if (prior) {
            conflicts.push([prior, id])
          } else {
            seen.set(key, id)
          }
        }

        return { applied: entries.length, conflicts }
      },

      getEffectiveBinding: (shortcutId: string) => {
        const { customBindings, activePreset } = get()
        return resolveBindingForPreset(shortcutId, activePreset, customBindings[shortcutId])
      },

      getAllEffectiveBindings: () => {
        const bindings = new Map<string, KeyBinding>()
        const { customBindings, activePreset } = get()

        for (const shortcut of DEFAULT_SHORTCUTS) {
          const binding = resolveBindingForPreset(
            shortcut.id,
            activePreset,
            customBindings[shortcut.id]
          )
          if (binding) bindings.set(shortcut.id, binding)
        }

        return bindings
      },

      getConflicts: (shortcutId: string, binding: KeyBinding) => {
        const allBindings = get().getAllEffectiveBindings()
        return detectConflicts(binding, allBindings, shortcutId)
      },

      getDisplayString: (shortcutId: string) => {
        const binding = get().getEffectiveBinding(shortcutId)
        if (!binding) return ''
        return formatBinding(binding)
      },

      loadFromDatabase: async () => {
        try {
          if (typeof window === 'undefined' || !window.db?.setting) return

          const [rawBindings, rawPreset] = await Promise.all([
            window.db.setting.get(SHORTCUTS_SETTING_KEY),
            window.db.setting.get(KEYMAP_PRESET_SETTING_KEY)
          ])

          const update: Partial<ShortcutState> = {}

          if (rawBindings) {
            update.customBindings = JSON.parse(rawBindings) as Record<string, KeyBinding>
          }

          if (rawPreset && isKeymapPresetId(rawPreset)) {
            update.activePreset = rawPreset
          }

          if (Object.keys(update).length > 0) {
            set(update)
          }
        } catch (error) {
          console.error('Failed to load shortcuts from database:', error)
        }
      }
    }),
    {
      name: 'hive-shortcuts',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        customBindings: state.customBindings,
        activePreset: state.activePreset
      })
    }
  )
)

function isKeymapPresetId(value: string): value is KeymapPresetId {
  return value in KEYMAP_PRESETS
}

// Save to SQLite database (async, non-blocking)
async function saveBindingsToDatabase(bindings: Record<string, KeyBinding>): Promise<void> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      await window.db.setting.set(SHORTCUTS_SETTING_KEY, JSON.stringify(bindings))
    }
  } catch (error) {
    console.error('Failed to save shortcuts to database:', error)
  }
}

async function savePresetToDatabase(preset: KeymapPresetId): Promise<void> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      await window.db.setting.set(KEYMAP_PRESET_SETTING_KEY, preset)
    }
  } catch (error) {
    console.error('Failed to save keymap preset to database:', error)
  }
}

// Load from database on startup
if (typeof window !== 'undefined') {
  setTimeout(() => {
    useShortcutStore.getState().loadFromDatabase()
  }, 150)
}
