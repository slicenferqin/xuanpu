import { useState, useCallback, useEffect } from 'react'
import { useShortcutStore } from '@/stores/useShortcutStore'
import {
  DEFAULT_SHORTCUTS,
  KEYMAP_PRESETS,
  KEYMAP_PRESET_ORDER,
  shortcutCategoryLabels,
  shortcutCategoryOrder,
  formatBinding,
  type KeyBinding,
  type KeymapPresetId,
  type ModifierKey,
  type ShortcutCategory,
  getShortcutsByCategory
} from '@/lib/keyboard-shortcuts'
import { Button } from '@/components/ui/button'
import { Check, Download, Loader2, RotateCcw, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n/useI18n'

export function SettingsShortcuts(): React.JSX.Element {
  const {
    customBindings,
    activePreset,
    setActivePreset,
    setCustomBinding,
    removeCustomBinding,
    resetToDefaults,
    getDisplayString
  } = useShortcutStore()
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [conflicts, setConflicts] = useState<string[]>([])
  const { t } = useI18n()

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!recordingId) return
      e.preventDefault()
      e.stopPropagation()

      // Ignore modifier-only presses
      if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return

      // Escape cancels recording
      if (e.key === 'Escape') {
        setRecordingId(null)
        setConflicts([])
        return
      }

      const modifiers: ModifierKey[] = []
      if (e.metaKey) modifiers.push('meta')
      if (e.ctrlKey) modifiers.push('ctrl')
      if (e.altKey) modifiers.push('alt')
      if (e.shiftKey) modifiers.push('shift')

      // Require at least one modifier for safety
      if (modifiers.length === 0) {
        toast.error(t('settings.shortcuts.modifierRequired'))
        return
      }

      const binding: KeyBinding = {
        key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
        modifiers
      }

      const result = setCustomBinding(recordingId, binding)
      if (result.success) {
        setRecordingId(null)
        setConflicts([])
        toast.success(t('settings.shortcuts.updated', { binding: formatBinding(binding) }))
      } else {
        setConflicts(result.conflicts || [])
      }
    },
    [recordingId, setCustomBinding, t]
  )

  const handleResetShortcut = (shortcutId: string): void => {
    removeCustomBinding(shortcutId)
    toast.success(t('settings.shortcuts.resetOneSuccess'))
  }

  const handleResetAll = (): void => {
    resetToDefaults()
    toast.success(t('settings.shortcuts.resetAllSuccess'))
  }

  const handleSelectPreset = (id: KeymapPresetId): void => {
    if (id === activePreset) return
    const { customCollisions } = setActivePreset(id)
    const presetLabel = t(KEYMAP_PRESETS[id].labelKey)
    if (customCollisions.length === 0) {
      toast.success(t('onboardingWizard.keymap.toast.switched', { preset: presetLabel }))
    } else {
      toast.warning(
        t('onboardingWizard.keymap.toast.conflicts', {
          preset: presetLabel,
          count: customCollisions.length
        })
      )
    }
  }

  // Count of custom bindings that are masking the active preset's overrides on
  // the same shortcut id. Surfaced as a "FYI" line under the preset chips.
  const customOverridingCount = Object.keys(customBindings).filter((id) => {
    const presetBinding = KEYMAP_PRESETS[activePreset]?.overrides[id]
    return presetBinding !== undefined
  }).length

  return (
    <div className="space-y-6" onKeyDown={handleKeyDown}>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium mb-1">{t('settings.shortcuts.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('settings.shortcuts.description')}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleResetAll}
          data-testid="reset-all-shortcuts"
        >
          <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
          {t('settings.shortcuts.resetAll')}
        </Button>
      </div>

      <PresetSwitcher
        activePreset={activePreset}
        onSelect={handleSelectPreset}
        customOverridingCount={customOverridingCount}
        t={t}
      />

      <ImportFromEditorRow />

      {conflicts.length > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/30 text-sm">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-destructive">{t('settings.shortcuts.conflictTitle')}</p>
            <p className="text-muted-foreground">
              {t('settings.shortcuts.conflictDescription')}{' '}
              {conflicts
                .map((id) => {
                  const shortcut = DEFAULT_SHORTCUTS.find((s) => s.id === id)
                  return shortcut?.label || id
                })
                .join(', ')}
            </p>
          </div>
        </div>
      )}

      {shortcutCategoryOrder.map((category) => (
        <ShortcutCategorySection
          key={category}
          category={category}
          recordingId={recordingId}
          customBindings={customBindings}
          getDisplayString={getDisplayString}
          onStartRecording={(id) => {
            setRecordingId(id)
            setConflicts([])
          }}
          onResetShortcut={handleResetShortcut}
          t={t}
        />
      ))}
    </div>
  )
}

interface PresetSwitcherProps {
  activePreset: KeymapPresetId
  onSelect: (id: KeymapPresetId) => void
  customOverridingCount: number
  t: (key: string, params?: Record<string, string | number | boolean>) => string
}

function PresetSwitcher({
  activePreset,
  onSelect,
  customOverridingCount,
  t
}: PresetSwitcherProps): React.JSX.Element {
  return (
    <div className="rounded-xl border border-border/70 bg-card/40 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">
            {t('settings.shortcuts.preset.label')}
          </div>
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {t('settings.shortcuts.preset.description')}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {KEYMAP_PRESET_ORDER.map((presetId) => {
            const meta = KEYMAP_PRESETS[presetId]
            const isActive = presetId === activePreset
            return (
              <button
                key={presetId}
                type="button"
                onClick={() => onSelect(presetId)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  isActive
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'border-border/70 bg-background text-muted-foreground hover:text-foreground hover:border-border'
                )}
              >
                {isActive && <Check className="h-3 w-3" />}
                {t(meta.labelKey)}
              </button>
            )
          })}
        </div>
      </div>

      {customOverridingCount > 0 && (
        <div className="mt-2 text-[11px] leading-5 text-muted-foreground">
          {t('settings.shortcuts.preset.customNotice', { count: customOverridingCount })}
        </div>
      )}
    </div>
  )
}

function ImportFromEditorRow(): React.JSX.Element {
  const { t } = useI18n()
  const applyImportEntries = useShortcutStore((s) => s.applyImportEntries)
  const [sources, setSources] = useState<
    Array<{
      id: 'vscode' | 'cursor'
      path: string
      exists: boolean
      available: boolean
    }>
  >([])
  const [busySource, setBusySource] = useState<'vscode' | 'cursor' | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.systemOps
      .detectKeybindingImportSources()
      .then((result) => {
        if (cancelled) return
        setSources(result)
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const sourceLabels: Record<'vscode' | 'cursor', string> = {
    vscode: t('onboardingWizard.keymap.importSourceVscode'),
    cursor: t('onboardingWizard.keymap.importSourceCursor')
  }

  async function handleImport(sourceId: 'vscode' | 'cursor'): Promise<void> {
    setBusySource(sourceId)
    try {
      const parsed = await window.systemOps.parseKeybindingImportSource(sourceId)
      const sourceLabel = sourceLabels[sourceId]

      if (parsed.errors.length > 0 && parsed.entries.length === 0) {
        const message = parsed.errors[0]
        if (message?.startsWith('Failed to read')) {
          toast.warning(t('onboardingWizard.keymap.importToast.notFound', { source: sourceLabel }))
        } else {
          toast.error(
            t('onboardingWizard.keymap.importToast.error', {
              source: sourceLabel,
              message: message ?? ''
            })
          )
        }
        return
      }

      if (parsed.entries.length === 0) {
        toast.warning(t('onboardingWizard.keymap.importToast.empty', { source: sourceLabel }))
        return
      }

      const { applied, conflicts } = applyImportEntries(parsed.entries)

      if (conflicts.length === 0) {
        toast.success(
          t('onboardingWizard.keymap.importToast.success', {
            source: sourceLabel,
            count: applied
          })
        )
      } else {
        toast.warning(
          t('onboardingWizard.keymap.importToast.partial', {
            source: sourceLabel,
            applied,
            skipped: conflicts.length
          })
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(
        t('onboardingWizard.keymap.importToast.error', {
          source: sourceLabels[sourceId],
          message
        })
      )
    } finally {
      setBusySource(null)
    }
  }

  if (!loaded) return <></>

  const anyAvailable = sources.some((s) => s.available)

  return (
    <div className="rounded-xl border border-border/70 bg-card/40 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">
            {t('onboardingWizard.keymap.importTitle')}
          </div>
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {anyAvailable
              ? t('onboardingWizard.keymap.importDescription')
              : t('onboardingWizard.keymap.importEmpty')}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {sources.map((source) => {
            const label = sourceLabels[source.id]
            const isBusy = busySource === source.id
            const disabled = !source.available || busySource !== null
            return (
              <Button
                key={source.id}
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => handleImport(source.id)}
                title={
                  source.available
                    ? source.path
                    : t('onboardingWizard.keymap.importNotFound', { path: source.path })
                }
                className="rounded-full"
              >
                {isBusy ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5 mr-1.5" />
                )}
                {isBusy
                  ? t('onboardingWizard.keymap.importBusy')
                  : t('onboardingWizard.keymap.importApply', { source: label })}
              </Button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

interface ShortcutCategorySectionProps {
  category: ShortcutCategory
  recordingId: string | null
  customBindings: Record<string, KeyBinding>
  getDisplayString: (id: string) => string
  onStartRecording: (id: string) => void
  onResetShortcut: (id: string) => void
  t: (key: string, params?: Record<string, string>) => string
}

function ShortcutCategorySection({
  category,
  recordingId,
  customBindings,
  getDisplayString,
  onStartRecording,
  onResetShortcut,
  t
}: ShortcutCategorySectionProps): React.JSX.Element {
  const shortcuts = getShortcutsByCategory(category)

  return (
    <div>
      <h4 className="text-sm font-medium text-muted-foreground mb-2">
        {t(`settings.shortcuts.categories.${category}`) || shortcutCategoryLabels[category]}
      </h4>
      <div className="space-y-1">
        {shortcuts.map((shortcut) => {
          const isRecording = recordingId === shortcut.id
          const isCustomized = shortcut.id in customBindings
          const displayString = getDisplayString(shortcut.id)

          return (
            <div
              key={shortcut.id}
              className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-accent/30"
              data-testid={`shortcut-${shortcut.id}`}
            >
              <div className="flex-1">
                <span className="text-sm">{shortcut.label}</span>
                {shortcut.description && (
                  <span className="text-xs text-muted-foreground ml-2">{shortcut.description}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isCustomized && (
                  <button
                    onClick={() => onResetShortcut(shortcut.id)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                    title={t('settings.shortcuts.resetTitle')}
                  >
                    <RotateCcw className="h-3 w-3" />
                  </button>
                )}
                <button
                  onClick={() => onStartRecording(shortcut.id)}
                  className={cn(
                    'min-w-[100px] px-2.5 py-1 rounded border text-xs font-mono text-right transition-colors',
                    isRecording
                      ? 'border-primary bg-primary/10 text-primary animate-pulse'
                      : isCustomized
                        ? 'border-primary/50 bg-primary/5 text-foreground hover:border-primary'
                        : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                  )}
                  data-testid={`shortcut-binding-${shortcut.id}`}
                >
                  {isRecording ? t('settings.shortcuts.recording') : displayString}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
