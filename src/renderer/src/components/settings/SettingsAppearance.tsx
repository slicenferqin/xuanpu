import { Check } from 'lucide-react'
import { THEME_PRESETS, type ThemePreset } from '@/lib/themes'
import { useThemeStore } from '@/stores/useThemeStore'
import { useSettingsStore, applyFontScale } from '@/stores/useSettingsStore'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'

const FONT_SCALE_PRESETS = [
  { labelKey: 'small', scale: 0.9 },
  { labelKey: 'default', scale: 1.0 },
  { labelKey: 'medium', scale: 1.1 },
  { labelKey: 'large', scale: 1.2 },
  { labelKey: 'xlarge', scale: 1.35 }
] as const

const ZOOM_PRESETS = [
  { label: '80%', level: -1.22 },
  { label: '90%', level: -0.58 },
  { label: '100%', level: 0 },
  { label: '110%', level: 0.53 },
  { label: '120%', level: 1.0 },
  { label: '130%', level: 1.44 },
  { label: '150%', level: 2.22 }
] as const

function findClosestPreset<T extends { scale?: number; level?: number }>(
  presets: readonly T[],
  value: number,
  key: 'scale' | 'level'
): T {
  return presets.reduce((closest, preset) => {
    const currentDiff = Math.abs((preset[key] as number) - value)
    const closestDiff = Math.abs((closest[key] as number) - value)
    return currentDiff < closestDiff ? preset : closest
  })
}

function ThemeCard({
  preset,
  isActive
}: {
  preset: ThemePreset
  isActive: boolean
}): React.JSX.Element {
  const setTheme = useThemeStore((s) => s.setTheme)

  return (
    <button
      onClick={() => setTheme(preset.id)}
      className={cn(
        'group relative flex flex-col items-center gap-2 rounded-lg border p-3 transition-all',
        isActive
          ? 'border-primary ring-2 ring-primary/30'
          : 'border-border hover:border-muted-foreground/40'
      )}
      data-testid={`theme-card-${preset.id}`}
    >
      {/* Preview swatch */}
      <div
        className="w-full h-16 rounded-md overflow-hidden border border-border/50"
        style={{ backgroundColor: preset.colors.background }}
      >
        <div className="flex h-full">
          {/* Sidebar preview */}
          <div className="w-1/4 h-full" style={{ backgroundColor: preset.colors.sidebar }} />
          {/* Main area preview */}
          <div className="flex-1 flex flex-col items-center justify-center gap-1 px-2">
            <div
              className="w-full h-2 rounded-full"
              style={{ backgroundColor: preset.colors.primary }}
            />
            <div
              className="w-3/4 h-1.5 rounded-full opacity-50"
              style={{ backgroundColor: preset.colors['muted-foreground'] }}
            />
            <div
              className="w-1/2 h-1.5 rounded-full opacity-30"
              style={{ backgroundColor: preset.colors['muted-foreground'] }}
            />
          </div>
        </div>
      </div>

      {/* Theme name */}
      <span className="text-xs font-medium text-foreground">{preset.name}</span>

      {/* Active checkmark */}
      {isActive && (
        <div className="absolute top-1.5 right-1.5 h-4 w-4 rounded-full bg-primary flex items-center justify-center">
          <Check className="h-2.5 w-2.5 text-primary-foreground" />
        </div>
      )}
    </button>
  )
}

export function SettingsAppearance(): React.JSX.Element {
  const themeId = useThemeStore((s) => s.themeId)
  const uiFontScale = useSettingsStore((s) => s.uiFontScale)
  const uiZoomLevel = useSettingsStore((s) => s.uiZoomLevel)
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const { t } = useI18n()

  const darkThemes = THEME_PRESETS.filter((p) => p.type === 'dark')
  const lightThemes = THEME_PRESETS.filter((p) => p.type === 'light')

  const activeFontPreset = findClosestPreset(FONT_SCALE_PRESETS, uiFontScale, 'scale')
  const activeZoomPreset = findClosestPreset(ZOOM_PRESETS, uiZoomLevel, 'level')

  const handleFontScaleChange = (scale: number): void => {
    applyFontScale(scale)
    updateSetting('uiFontScale', scale)
  }

  const handleZoomChange = (level: number): void => {
    if (window.systemOps?.setZoomLevel) {
      window.systemOps.setZoomLevel(level)
    }
    updateSetting('uiZoomLevel', level)
  }

  return (
    <div className="space-y-6" data-testid="settings-appearance">
      <div>
        <h2 className="text-lg font-semibold mb-1">{t('settings.appearance.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.appearance.description')}</p>
      </div>

      {/* Dark Themes */}
      <div>
        <h3
          className="text-sm font-medium text-muted-foreground mb-3"
          data-testid="dark-themes-header"
        >
          {t('settings.appearance.darkThemes')}
        </h3>
        <div className="grid grid-cols-3 gap-3" data-testid="dark-themes-grid">
          {darkThemes.map((preset) => (
            <ThemeCard key={preset.id} preset={preset} isActive={themeId === preset.id} />
          ))}
        </div>
      </div>

      {/* Light Themes */}
      <div>
        <h3
          className="text-sm font-medium text-muted-foreground mb-3"
          data-testid="light-themes-header"
        >
          {t('settings.appearance.lightThemes')}
        </h3>
        <div className="grid grid-cols-3 gap-3" data-testid="light-themes-grid">
          {lightThemes.map((preset) => (
            <ThemeCard key={preset.id} preset={preset} isActive={themeId === preset.id} />
          ))}
        </div>
      </div>

      {/* Font Size */}
      <div>
        <h3 className="text-sm font-medium text-foreground mb-1">
          {t('settings.appearance.fontSize.title')}
        </h3>
        <p className="text-xs text-muted-foreground mb-3">
          {t('settings.appearance.fontSize.description')}
        </p>
        <div className="flex flex-wrap gap-2" data-testid="font-scale-presets">
          {FONT_SCALE_PRESETS.map((preset) => {
            const isActive = activeFontPreset.scale === preset.scale
            return (
              <button
                key={preset.labelKey}
                onClick={() => handleFontScaleChange(preset.scale)}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                  isActive
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-foreground hover:bg-muted'
                )}
                data-testid={`font-scale-${preset.labelKey}`}
              >
                {t(`settings.appearance.fontSize.presets.${preset.labelKey}`)}
              </button>
            )
          })}
        </div>
      </div>

      {/* UI Scale (Electron zoom) */}
      <div>
        <h3 className="text-sm font-medium text-foreground mb-1">
          {t('settings.appearance.uiScale.title')}
        </h3>
        <p className="text-xs text-muted-foreground mb-3">
          {t('settings.appearance.uiScale.description')}
        </p>
        <div className="flex flex-wrap gap-2" data-testid="ui-zoom-presets">
          {ZOOM_PRESETS.map((preset) => {
            const isActive = activeZoomPreset.level === preset.level
            return (
              <button
                key={preset.label}
                onClick={() => handleZoomChange(preset.level)}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                  isActive
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-foreground hover:bg-muted'
                )}
                data-testid={`ui-zoom-${preset.label}`}
              >
                {preset.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
