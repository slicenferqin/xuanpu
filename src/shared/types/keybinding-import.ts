/**
 * Shared types for the "Import keybindings from VS Code / Cursor" flow.
 *
 * The main process detects + parses the source JSONC file; the renderer then
 * walks the resulting entries and feeds them to `useShortcutStore.setCustomBinding`.
 * Keeping the binding shape primitive (no enum imports) lets the IPC layer
 * stay decoupled from the renderer keymap module.
 */

export type KeybindingImportSourceId = 'vscode' | 'cursor'

export type KeybindingModifier = 'ctrl' | 'meta' | 'alt' | 'shift'

export interface KeybindingImportBinding {
  /** lowercase key as `event.key`, or special name like 'Enter' / 'Tab' / 'Escape' */
  key: string
  modifiers: KeybindingModifier[]
}

export interface KeybindingImportSourceInfo {
  id: KeybindingImportSourceId
  /** Best-known absolute path to the source's keybindings.json (may not exist). */
  path: string
  /** True when the file is present and readable. */
  exists: boolean
  /** Convenience flag — same as `exists` for now, kept for future heuristics. */
  available: boolean
}

export interface KeybindingImportEntry {
  /** Xuanpu shortcut id this binding maps onto. */
  shortcutId: string
  binding: KeybindingImportBinding
  /** Original VS Code / Cursor command, e.g. "workbench.action.showCommands" */
  sourceCommand: string
  /** Original "key" string from the source, e.g. "cmd+shift+p" */
  sourceKey: string
}

export interface KeybindingImportResult {
  source: KeybindingImportSourceId
  /** Path that was read. */
  path: string
  /** Total raw rows in keybindings.json (including unmapped + skipped). */
  parsedRows: number
  /** Bindings ready to apply. */
  entries: KeybindingImportEntry[]
  /** VS Code commands without a Xuanpu equivalent (deduplicated). */
  unmapped: string[]
  /** Rows skipped due to a `when` context clause (we can't honor those). */
  contextScoped: number
  /** Parse / IO errors. */
  errors: string[]
}
