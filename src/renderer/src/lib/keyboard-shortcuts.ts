import { isMac as isMacFn } from './platform'

// ==========================================
// Types
// ==========================================

export type ModifierKey = 'ctrl' | 'meta' | 'alt' | 'shift'

export interface KeyBinding {
  key: string // The key to press (lowercase), e.g. 'n', 'tab', ','
  modifiers: ModifierKey[] // Required modifier keys
}

export interface ShortcutDefinition {
  id: string
  label: string // Human-readable name, e.g. "New Session"
  description?: string
  category: ShortcutCategory
  defaultBinding: KeyBinding
}

export type ShortcutCategory = 'session' | 'navigation' | 'git' | 'sidebar' | 'focus' | 'settings'

// ==========================================
// Default Shortcut Definitions
// ==========================================

export const DEFAULT_SHORTCUTS: ShortcutDefinition[] = [
  // Session shortcuts
  {
    id: 'session:new',
    label: 'New Session',
    description: 'Create a new chat session',
    category: 'session',
    defaultBinding: { key: 't', modifiers: ['meta'] }
  },
  {
    id: 'session:close',
    label: 'Close Session',
    description: 'Close the current session tab (noop if none open)',
    category: 'session',
    defaultBinding: { key: 'w', modifiers: ['meta'] }
  },
  {
    id: 'session:mode-toggle',
    label: 'Toggle Build/Plan Mode',
    description: 'Switch between build and plan mode',
    category: 'session',
    defaultBinding: { key: 'Tab', modifiers: [] }
  },
  {
    id: 'project:run',
    label: 'Run Project',
    description: 'Start or stop the project run script',
    category: 'session',
    defaultBinding: { key: 'r', modifiers: ['meta'] }
  },
  {
    id: 'model:cycle-variant',
    label: 'Cycle Model Variant',
    description: 'Cycle through thinking-level variants (e.g., high/max)',
    category: 'session',
    defaultBinding: { key: 't', modifiers: ['alt'] }
  },

  // Terminal tab shortcuts
  {
    id: 'terminal:new-tab',
    label: 'New Terminal Tab',
    description: 'Create a new terminal tab in the bottom panel',
    category: 'session',
    defaultBinding: { key: 't', modifiers: ['ctrl', 'shift'] }
  },
  {
    id: 'terminal:close-tab',
    label: 'Close Terminal Tab',
    description: 'Close the active terminal tab in the bottom panel',
    category: 'session',
    defaultBinding: { key: 'w', modifiers: ['ctrl', 'shift'] }
  },
  {
    id: 'terminal:next-tab',
    label: 'Next Terminal Tab',
    description: 'Switch to the next terminal tab',
    category: 'session',
    defaultBinding: { key: ']', modifiers: ['ctrl', 'shift'] }
  },
  {
    id: 'terminal:prev-tab',
    label: 'Previous Terminal Tab',
    description: 'Switch to the previous terminal tab',
    category: 'session',
    defaultBinding: { key: '[', modifiers: ['ctrl', 'shift'] }
  },

  // Navigation shortcuts
  {
    id: 'nav:file-search',
    label: 'Search Files',
    description: 'Open the file search dialog',
    category: 'navigation',
    defaultBinding: { key: 'd', modifiers: ['meta'] }
  },
  {
    id: 'nav:command-palette',
    label: 'Open Command Palette',
    description: 'Open the command palette',
    category: 'navigation',
    defaultBinding: { key: 'p', modifiers: ['meta'] }
  },
  {
    id: 'nav:session-history',
    label: 'Open Session History',
    description: 'Open the session history panel',
    category: 'navigation',
    defaultBinding: { key: 'k', modifiers: ['meta'] }
  },
  {
    id: 'nav:new-worktree',
    label: 'New Worktree',
    description: 'Create a new worktree for the current project',
    category: 'navigation',
    defaultBinding: { key: 'n', modifiers: ['meta', 'shift'] }
  },

  // Git shortcuts
  {
    id: 'git:commit',
    label: 'Focus Commit Form',
    description: 'Focus the git commit form',
    category: 'git',
    defaultBinding: { key: 'c', modifiers: ['meta', 'shift'] }
  },
  {
    id: 'git:push',
    label: 'Push to Remote',
    description: 'Push commits to the remote repository',
    category: 'git',
    defaultBinding: { key: 'p', modifiers: ['meta', 'shift'] }
  },
  {
    id: 'git:pull',
    label: 'Pull from Remote',
    description: 'Pull commits from the remote repository',
    category: 'git',
    defaultBinding: { key: 'l', modifiers: ['meta', 'shift'] }
  },
  {
    id: 'nav:filter-projects',
    label: 'Filter Projects',
    description: 'Focus the project filter input',
    category: 'navigation',
    defaultBinding: { key: 'g', modifiers: ['meta'] }
  },

  // Sidebar shortcuts
  {
    id: 'sidebar:toggle-left',
    label: 'Toggle Left Sidebar',
    description: 'Show or hide the left sidebar',
    category: 'sidebar',
    defaultBinding: { key: 'b', modifiers: ['meta'] }
  },
  {
    id: 'sidebar:toggle-right',
    label: 'Toggle Right Sidebar',
    description: 'Show or hide the right sidebar',
    category: 'sidebar',
    defaultBinding: { key: 'b', modifiers: ['meta', 'shift'] }
  },

  // Focus shortcuts
  {
    id: 'focus:left-sidebar',
    label: 'Focus Left Sidebar',
    description: 'Move focus to the left sidebar',
    category: 'focus',
    defaultBinding: { key: '1', modifiers: ['meta'] }
  },
  {
    id: 'focus:main-pane',
    label: 'Focus Main Pane',
    description: 'Move focus to the main chat pane',
    category: 'focus',
    defaultBinding: { key: '2', modifiers: ['meta'] }
  },

  // Settings shortcuts
  {
    id: 'settings:open',
    label: 'Open Settings',
    description: 'Open the settings panel',
    category: 'settings',
    defaultBinding: { key: ',', modifiers: ['meta'] }
  }
]

// Build a map for fast lookup
const shortcutMap = new Map<string, ShortcutDefinition>()
DEFAULT_SHORTCUTS.forEach((s) => shortcutMap.set(s.id, s))

// ==========================================
// Keymap Presets
// ==========================================

export type KeymapPresetId = 'xuanpu-default' | 'vscode' | 'jetbrains'

export interface KeymapPresetMeta {
  id: KeymapPresetId
  /** i18n key under `onboardingWizard.keymap.presets.{id}.label` */
  labelKey: string
  /** i18n key under `onboardingWizard.keymap.presets.{id}.description` */
  descriptionKey: string
  /** Sparse map: only shortcuts that differ from DEFAULT_SHORTCUTS. */
  overrides: Partial<Record<string, KeyBinding>>
}

export const DEFAULT_KEYMAP_PRESET: KeymapPresetId = 'xuanpu-default'

export const KEYMAP_PRESETS: Record<KeymapPresetId, KeymapPresetMeta> = {
  'xuanpu-default': {
    id: 'xuanpu-default',
    labelKey: 'onboardingWizard.keymap.presets.xuanpu-default.label',
    descriptionKey: 'onboardingWizard.keymap.presets.xuanpu-default.description',
    overrides: {}
  },
  vscode: {
    id: 'vscode',
    labelKey: 'onboardingWizard.keymap.presets.vscode.label',
    descriptionKey: 'onboardingWizard.keymap.presets.vscode.description',
    overrides: {
      'nav:command-palette': { key: 'p', modifiers: ['meta', 'shift'] },
      'nav:file-search': { key: 'p', modifiers: ['meta'] },
      'git:push': { key: 'p', modifiers: ['alt', 'meta'] },
      'git:commit': { key: 'Enter', modifiers: ['meta'] },
      'git:pull': { key: 'l', modifiers: ['alt', 'meta'] },
      'nav:filter-projects': { key: 'f', modifiers: ['meta', 'shift'] },
      'terminal:new-tab': { key: '`', modifiers: ['ctrl', 'shift'] },
      'terminal:close-tab': { key: 'k', modifiers: ['ctrl', 'shift'] },
      'sidebar:toggle-right': { key: 'b', modifiers: ['alt', 'meta'] }
    }
  },
  jetbrains: {
    id: 'jetbrains',
    labelKey: 'onboardingWizard.keymap.presets.jetbrains.label',
    descriptionKey: 'onboardingWizard.keymap.presets.jetbrains.description',
    overrides: {
      'nav:command-palette': { key: 'a', modifiers: ['meta', 'shift'] },
      'nav:file-search': { key: 'o', modifiers: ['meta', 'shift'] },
      'nav:session-history': { key: 'e', modifiers: ['meta'] },
      'git:commit': { key: 'k', modifiers: ['meta'] },
      'git:push': { key: 'k', modifiers: ['meta', 'shift'] },
      'sidebar:toggle-left': { key: '1', modifiers: ['meta'] },
      'focus:left-sidebar': { key: '1', modifiers: ['alt'] },
      'focus:main-pane': { key: '2', modifiers: ['alt'] }
    }
  }
}

export const KEYMAP_PRESET_ORDER: KeymapPresetId[] = ['xuanpu-default', 'vscode', 'jetbrains']

/**
 * Resolve the effective binding for a shortcut under a preset, with optional custom override.
 * Priority: custom > preset.overrides > DEFAULT_SHORTCUTS.
 */
export function resolveBindingForPreset(
  shortcutId: string,
  preset: KeymapPresetId,
  custom?: KeyBinding
): KeyBinding | null {
  if (custom) return custom
  const override = KEYMAP_PRESETS[preset]?.overrides[shortcutId]
  if (override) return override
  return shortcutMap.get(shortcutId)?.defaultBinding ?? null
}

/**
 * Build a Map of every shortcut's effective binding for the given preset (no custom overlay).
 * Useful for conflict detection.
 */
export function buildPresetBindingMap(preset: KeymapPresetId): Map<string, KeyBinding> {
  const result = new Map<string, KeyBinding>()
  for (const def of DEFAULT_SHORTCUTS) {
    const binding = resolveBindingForPreset(def.id, preset)
    if (binding) result.set(def.id, binding)
  }
  return result
}

/**
 * Returns true if the preset's overrides reference only known shortcut ids.
 * Used by tests to ensure presets don't drift from DEFAULT_SHORTCUTS.
 */
export function presetOverridesAreValid(preset: KeymapPresetId): boolean {
  return Object.keys(KEYMAP_PRESETS[preset].overrides).every((id) => shortcutMap.has(id))
}

// ==========================================
// Utility Functions
// ==========================================

/**
 * Serialize a KeyBinding to a display string, e.g. "⌘N" or "Ctrl+Shift+N"
 */
export function formatBinding(binding: KeyBinding): string {
  const mac = isMacFn()
  const modSymbols = binding.modifiers.map((mod) => {
    switch (mod) {
      case 'meta':
        return mac ? '\u2318' : 'Ctrl'
      case 'ctrl':
        return mac ? '\u2303' : 'Ctrl'
      case 'alt':
        return mac ? '\u2325' : 'Alt'
      case 'shift':
        return mac ? '\u21E7' : 'Shift'
      default:
        return mod
    }
  })

  const keyDisplay = binding.key.length === 1 ? binding.key.toUpperCase() : binding.key
  return [...modSymbols, keyDisplay].join(mac ? '' : '+')
}

/**
 * Serialize a KeyBinding to a stable string for storage and comparison.
 * e.g. "meta+shift+n"
 */
export function serializeBinding(binding: KeyBinding): string {
  const sortedMods = [...binding.modifiers].sort()
  return [...sortedMods, binding.key.toLowerCase()].join('+')
}

/**
 * Deserialize a stored binding string back to a KeyBinding.
 */
export function deserializeBinding(serialized: string): KeyBinding {
  const parts = serialized.split('+')
  const key = parts.pop()!
  const modifiers = parts as ModifierKey[]
  return { key, modifiers }
}

/**
 * Check if a keyboard event matches a binding.
 * For cross-platform, treats both ctrl and meta as "command" when modifier is 'meta'.
 */
export function eventMatchesBinding(event: KeyboardEvent, binding: KeyBinding): boolean {
  // On macOS, Alt+key produces dead characters (e.g., Alt+T → †) so event.key
  // won't match. Fall back to event.code (physical key) when alt is involved.
  const altRequired = binding.modifiers.includes('alt')
  let keyMatches: boolean
  if (altRequired && event.altKey && event.code) {
    const codeKey = event.code
      .replace(/^Key/, '')
      .replace(/^Digit/, '')
      .toLowerCase()
    keyMatches = codeKey === binding.key.toLowerCase()
  } else {
    keyMatches = event.key.toLowerCase() === binding.key.toLowerCase()
  }
  if (!keyMatches) return false

  const ctrlRequired = binding.modifiers.includes('ctrl')
  const metaRequired = binding.modifiers.includes('meta')
  const shiftRequired = binding.modifiers.includes('shift')

  // For cross-platform, treat both ctrl and meta as the same "command" key
  const hasCtrlOrMeta = event.ctrlKey || event.metaKey
  const needsCtrlOrMeta = ctrlRequired || metaRequired

  if (needsCtrlOrMeta && !hasCtrlOrMeta) return false
  if (!needsCtrlOrMeta && hasCtrlOrMeta) return false
  if (altRequired && !event.altKey) return false
  if (!altRequired && event.altKey) return false
  if (shiftRequired && !event.shiftKey) return false
  if (!shiftRequired && event.shiftKey) return false

  return true
}

/**
 * Get a shortcut definition by ID.
 */
export function getShortcutDefinition(id: string): ShortcutDefinition | undefined {
  return shortcutMap.get(id)
}

/**
 * Get all shortcut definitions.
 */
export function getAllShortcutDefinitions(): ShortcutDefinition[] {
  return DEFAULT_SHORTCUTS
}

/**
 * Get shortcut definitions by category.
 */
export function getShortcutsByCategory(category: ShortcutCategory): ShortcutDefinition[] {
  return DEFAULT_SHORTCUTS.filter((s) => s.category === category)
}

/**
 * Detect conflicts between a proposed binding and existing bindings.
 * Returns the IDs of conflicting shortcuts.
 */
export function detectConflicts(
  proposedBinding: KeyBinding,
  currentBindings: Map<string, KeyBinding>,
  excludeId?: string
): string[] {
  const proposedSerialized = serializeBinding(proposedBinding)
  const conflicts: string[] = []

  for (const [id, binding] of currentBindings.entries()) {
    if (excludeId && id === excludeId) continue
    if (serializeBinding(binding) === proposedSerialized) {
      conflicts.push(id)
    }
  }

  return conflicts
}

// Category display labels
export const shortcutCategoryLabels: Record<ShortcutCategory, string> = {
  session: 'Sessions',
  navigation: 'Navigation',
  git: 'Git',
  sidebar: 'Sidebars',
  focus: 'Focus',
  settings: 'Settings'
}

// Category display order
export const shortcutCategoryOrder: ShortcutCategory[] = [
  'session',
  'navigation',
  'git',
  'sidebar',
  'focus',
  'settings'
]
