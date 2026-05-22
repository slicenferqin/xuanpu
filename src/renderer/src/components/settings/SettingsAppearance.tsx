import { useMemo, useState } from 'react'
import { Check, Loader2, Monitor, RefreshCw } from 'lucide-react'
import { THEME_PRESETS, type ThemePreset } from '@/lib/themes'
import { useThemeStore } from '@/stores/useThemeStore'
import {
  useSettingsStore,
  applyFontFamily,
  applyFontScale,
  applyFontWeight
} from '@/stores/useSettingsStore'
import type { UiFontFamily, UiFontWeight } from '@/lib/font-size'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

const FONT_SCALE_PRESETS = [
  { labelKey: 'small', scale: 0.9 },
  { labelKey: 'default', scale: 1.0 },
  { labelKey: 'medium', scale: 1.1 },
  { labelKey: 'large', scale: 1.2 },
  { labelKey: 'xlarge', scale: 1.35 }
] as const

const FONT_FAMILY_PRESETS: Array<{
  id: UiFontFamily
  labelKey: string
  previewFontFamily?: string
}> = [
  { id: 'system', labelKey: 'system' },
  {
    id: 'serif',
    labelKey: 'serif',
    previewFontFamily: 'Charter, "Iowan Old Style", "Songti SC", Georgia, serif'
  },
  {
    id: 'mono',
    labelKey: 'mono',
    previewFontFamily:
      '"JetBrains Mono", "SF Mono", SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace'
  },
  {
    id: 'rounded',
    labelKey: 'rounded',
    previewFontFamily:
      '"SF Pro Rounded", "Avenir Next", "PingFang SC", ui-rounded, system-ui, sans-serif'
  },
  { id: 'custom', labelKey: 'custom' }
]

const COMMON_SYSTEM_FONTS = [
  'SF Pro Text',
  'SF Pro Display',
  'PingFang SC',
  'Hiragino Sans GB',
  'Helvetica Neue',
  'Avenir Next',
  'Menlo',
  'Monaco',
  'Songti SC'
]

const FONT_WEIGHT_PRESETS: Array<{
  id: UiFontWeight
  labelKey: string
  previewWeight: number
}> = [
  { id: 'regular', labelKey: 'regular', previewWeight: 400 },
  { id: 'medium', labelKey: 'medium', previewWeight: 500 },
  { id: 'semibold', labelKey: 'semibold', previewWeight: 600 }
]

const ZOOM_PRESETS = [
  { label: '80%', level: -1.22 },
  { label: '90%', level: -0.58 },
  { label: '100%', level: 0 },
  { label: '110%', level: 0.53 },
  { label: '120%', level: 1.0 },
  { label: '130%', level: 1.44 },
  { label: '150%', level: 2.22 }
] as const

type LocalFontData = {
  family: string
  fullName?: string
  postscriptName?: string
  style?: string
}

type FontLoadStatus = 'idle' | 'loading' | 'loaded' | 'unavailable' | 'denied' | 'error'

function quoteFontFamily(family: string): string {
  const trimmed = family.trim()
  if (!trimmed) return ''
  if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) return trimmed
  return `"${trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function buildSystemFontStack(family: string): string {
  return `${quoteFontFamily(family)}, system-ui, sans-serif`
}

function getQueryLocalFonts(): (() => Promise<LocalFontData[]>) | null {
  const maybeWindow = window as Window & {
    queryLocalFonts?: () => Promise<LocalFontData[]>
  }
  return typeof maybeWindow.queryLocalFonts === 'function'
    ? maybeWindow.queryLocalFonts.bind(maybeWindow)
    : null
}

function normalizeFontName(value: string): string {
  return value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase()
}

function getSelectedSystemFont(customFontFamily: string, systemFonts: string[]): string | null {
  const trimmed = customFontFamily.trim()
  if (!trimmed) return null

  return (
    systemFonts.find((family) => {
      const quoted = quoteFontFamily(family)
      const normalizedFamily = normalizeFontName(family)
      return (
        trimmed === buildSystemFontStack(family) ||
        trimmed === quoted ||
        trimmed === family ||
        trimmed.startsWith(`${quoted},`) ||
        normalizeFontName(trimmed.split(',')[0] ?? '') === normalizedFamily
      )
    }) ?? null
  )
}

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
  const followSystem = useThemeStore((s) => s.followSystem)
  const setFollowSystem = useThemeStore((s) => s.setFollowSystem)
  const uiFontScale = useSettingsStore((s) => s.uiFontScale)
  const uiFontFamily = useSettingsStore((s) => s.uiFontFamily)
  const uiCustomFontFamily = useSettingsStore((s) => s.uiCustomFontFamily)
  const uiFontWeight = useSettingsStore((s) => s.uiFontWeight)
  const uiZoomLevel = useSettingsStore((s) => s.uiZoomLevel)
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const { t } = useI18n()
  const [localFontFamilies, setLocalFontFamilies] = useState<string[]>([])
  const [fontLoadStatus, setFontLoadStatus] = useState<FontLoadStatus>('idle')

  const darkThemes = THEME_PRESETS.filter((p) => p.type === 'dark')
  const lightThemes = THEME_PRESETS.filter((p) => p.type === 'light')

  const activeFontPreset = findClosestPreset(FONT_SCALE_PRESETS, uiFontScale, 'scale')
  const activeZoomPreset = findClosestPreset(ZOOM_PRESETS, uiZoomLevel, 'level')
  const systemFontOptions = useMemo(() => {
    const families = [...COMMON_SYSTEM_FONTS, ...localFontFamilies]
    return Array.from(new Set(families.map((family) => family.trim()).filter(Boolean))).sort(
      (a, b) => a.localeCompare(b)
    )
  }, [localFontFamilies])
  const selectedSystemFont =
    uiFontFamily === 'custom' ? getSelectedSystemFont(uiCustomFontFamily, systemFontOptions) : null
  const fontSelectValue =
    uiFontFamily === 'custom'
      ? selectedSystemFont
        ? `system:${selectedSystemFont}`
        : 'preset:custom'
      : `preset:${uiFontFamily}`

  const handleFontFamilyChange = (family: UiFontFamily): void => {
    applyFontFamily(family, uiCustomFontFamily)
    updateSetting('uiFontFamily', family)
  }

  const loadSystemFonts = async (): Promise<void> => {
    if (fontLoadStatus === 'loading') return

    const queryLocalFonts = getQueryLocalFonts()
    if (!queryLocalFonts) {
      setFontLoadStatus('unavailable')
      return
    }

    setFontLoadStatus('loading')
    try {
      const fonts = await queryLocalFonts()
      const families = Array.from(
        new Set(fonts.map((font) => font.family.trim()).filter(Boolean))
      ).sort((a, b) => a.localeCompare(b))
      setLocalFontFamilies(families)
      setFontLoadStatus('loaded')
    } catch (error) {
      const name = error instanceof DOMException ? error.name : ''
      setFontLoadStatus(name === 'NotAllowedError' ? 'denied' : 'error')
    }
  }

  const handleFontSelectChange = (value: string): void => {
    if (value.startsWith('system:')) {
      const family = value.slice('system:'.length)
      const fontStack = buildSystemFontStack(family)
      applyFontFamily('custom', fontStack)
      updateSetting('uiCustomFontFamily', fontStack)
      updateSetting('uiFontFamily', 'custom')
      return
    }

    const family = value.replace('preset:', '') as UiFontFamily
    if (family === 'custom') {
      applyFontFamily('custom', uiCustomFontFamily)
      updateSetting('uiFontFamily', 'custom')
      return
    }
    handleFontFamilyChange(family)
  }

  const handleCustomFontFamilyChange = (fontFamily: string): void => {
    applyFontFamily('custom', fontFamily)
    updateSetting('uiCustomFontFamily', fontFamily)
  }

  const handleFontScaleChange = (scale: number): void => {
    applyFontScale(scale)
    updateSetting('uiFontScale', scale)
  }

  const handleFontWeightChange = (weight: UiFontWeight): void => {
    applyFontWeight(weight)
    updateSetting('uiFontWeight', weight)
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

      {/* Follow System Toggle */}
      <button
        onClick={() => setFollowSystem(!followSystem)}
        className={cn(
          'flex items-center gap-3 w-full rounded-lg border px-4 py-3 text-left transition-colors',
          followSystem
            ? 'border-primary/50 bg-primary/5'
            : 'border-border/50 bg-card/50 hover:border-border'
        )}
      >
        <Monitor
          className={cn(
            'h-4 w-4 shrink-0',
            followSystem ? 'text-primary' : 'text-muted-foreground'
          )}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">跟随系统</div>
          <div className="text-xs text-muted-foreground">自动跟随操作系统的浅色/深色模式</div>
        </div>
        <div
          className={cn(
            'relative h-5 w-9 shrink-0 rounded-full transition-colors',
            followSystem ? 'bg-primary' : 'bg-muted'
          )}
        >
          <div
            className={cn(
              'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
              followSystem ? 'translate-x-4' : 'translate-x-0.5'
            )}
          />
        </div>
      </button>

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

      {/* Font Family */}
      <div>
        <h3 className="text-sm font-medium text-foreground mb-1">
          {t('settings.appearance.fontFamily.title')}
        </h3>
        <p className="text-xs text-muted-foreground mb-3">
          {t('settings.appearance.fontFamily.description')}
        </p>
        <div className="flex flex-col gap-2" data-testid="font-family-picker">
          <div className="flex gap-2">
            <select
              value={fontSelectValue}
              onChange={(event) => handleFontSelectChange(event.target.value)}
              onFocus={() => {
                if (fontLoadStatus === 'idle') {
                  void loadSystemFonts()
                }
              }}
              className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors hover:bg-muted/45 focus:border-primary focus:ring-2 focus:ring-primary/20"
              data-testid="font-family-select"
            >
              <optgroup label={t('settings.appearance.fontFamily.presetsGroup')}>
                {FONT_FAMILY_PRESETS.map((preset) => (
                  <option key={preset.id} value={`preset:${preset.id}`}>
                    {t(`settings.appearance.fontFamily.presets.${preset.labelKey}`)}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t('settings.appearance.fontFamily.systemGroup')}>
                {systemFontOptions.map((family) => (
                  <option key={family} value={`system:${family}`}>
                    {family}
                  </option>
                ))}
              </optgroup>
            </select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 shrink-0 rounded-lg px-3 text-xs"
              onClick={() => void loadSystemFonts()}
              disabled={fontLoadStatus === 'loading'}
              data-testid="load-system-fonts"
            >
              {fontLoadStatus === 'loading' ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t('settings.appearance.fontFamily.loadSystemFonts')}
            </Button>
          </div>
          <div className="flex min-h-5 items-center justify-between gap-2">
            <div
              className="truncate text-xs text-muted-foreground"
              data-testid="font-family-preview"
              style={{
                fontFamily:
                  uiFontFamily === 'custom'
                    ? uiCustomFontFamily
                    : FONT_FAMILY_PRESETS.find((preset) => preset.id === uiFontFamily)
                        ?.previewFontFamily
              }}
            >
              {t('settings.appearance.fontFamily.preview')}
            </div>
            <div className="shrink-0 text-[11px] text-muted-foreground">
              {fontLoadStatus === 'loaded' &&
                t('settings.appearance.fontFamily.systemFontsLoaded', {
                  count: localFontFamilies.length
                })}
              {fontLoadStatus === 'unavailable' &&
                t('settings.appearance.fontFamily.systemFontsUnavailable')}
              {fontLoadStatus === 'denied' && t('settings.appearance.fontFamily.systemFontsDenied')}
              {fontLoadStatus === 'error' && t('settings.appearance.fontFamily.systemFontsError')}
            </div>
          </div>
        </div>
        {uiFontFamily === 'custom' && (
          <div className="mt-3" data-testid="custom-font-family-row">
            <Input
              value={uiCustomFontFamily}
              onChange={(event) => handleCustomFontFamilyChange(event.target.value)}
              placeholder={t('settings.appearance.fontFamily.customPlaceholder')}
              data-testid="custom-font-family-input"
            />
          </div>
        )}
      </div>

      {/* Font Weight */}
      <div>
        <h3 className="text-sm font-medium text-foreground mb-1">
          {t('settings.appearance.fontWeight.title')}
        </h3>
        <p className="text-xs text-muted-foreground mb-3">
          {t('settings.appearance.fontWeight.description')}
        </p>
        <div className="flex flex-wrap gap-2" data-testid="font-weight-presets">
          {FONT_WEIGHT_PRESETS.map((preset) => {
            const isActive = uiFontWeight === preset.id
            return (
              <button
                key={preset.id}
                onClick={() => handleFontWeightChange(preset.id)}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-xs transition-colors',
                  isActive
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-foreground hover:bg-muted'
                )}
                data-testid={`font-weight-${preset.id}`}
                style={{ fontWeight: preset.previewWeight }}
              >
                {t(`settings.appearance.fontWeight.presets.${preset.labelKey}`)}
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
