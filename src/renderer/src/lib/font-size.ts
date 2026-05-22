/**
 * Font size scaling via Tailwind v4 CSS custom properties.
 *
 * Tailwind v4 compiles `text-sm` → `font-size: var(--text-sm)`, so
 * overriding `--text-sm` on `:root` changes all `text-sm` elements
 * without affecting spacing, icons, or layout.
 */

/** Tailwind v4 default text sizes in rem */
const BASE_TEXT_SIZES: Record<string, number> = {
  '--text-xs': 0.75,
  '--text-sm': 0.875,
  '--text-base': 1,
  '--text-lg': 1.125,
  '--text-xl': 1.25,
  '--text-2xl': 1.5
}

const ALL_FONT_VARS = Object.keys(BASE_TEXT_SIZES)

export type UiFontFamily = 'system' | 'serif' | 'mono' | 'rounded' | 'custom'
export type UiFontWeight = 'regular' | 'medium' | 'semibold'

const UI_FONT_FAMILY_VAR = '--xuanpu-ui-font-family'
const UI_FONT_WEIGHT_VAR = '--xuanpu-ui-font-weight'

const UI_FONT_FAMILY_STACKS: Record<Exclude<UiFontFamily, 'custom'>, string> = {
  system: '',
  serif: 'Charter, "Iowan Old Style", "Songti SC", Georgia, serif',
  mono: '"JetBrains Mono", "SF Mono", SFMono-Regular, ui-monospace, Menlo, Monaco, Consolas, monospace',
  rounded: '"SF Pro Rounded", "Avenir Next", "PingFang SC", ui-rounded, system-ui, sans-serif'
}

const UI_FONT_WEIGHT_VALUES: Record<UiFontWeight, string> = {
  regular: '400',
  medium: '500',
  semibold: '600'
}

/**
 * Apply a font scale multiplier by overriding Tailwind's --text-* CSS variables.
 * scale = 1 removes all overrides (restores Tailwind defaults).
 */
export function applyFontScale(scale: number): void {
  const root = document.documentElement
  if (scale === 1) {
    for (const key of ALL_FONT_VARS) {
      root.style.removeProperty(key)
    }
    return
  }
  for (const [key, base] of Object.entries(BASE_TEXT_SIZES)) {
    root.style.setProperty(key, `${(base * scale).toFixed(4)}rem`)
  }
}

export function applyFontFamily(family: UiFontFamily, customFamily = ''): void {
  const root = document.documentElement

  if (family === 'custom') {
    const trimmed = customFamily.trim()
    if (trimmed) {
      root.style.setProperty(UI_FONT_FAMILY_VAR, trimmed)
    } else {
      root.style.removeProperty(UI_FONT_FAMILY_VAR)
    }
    return
  }

  const stack = UI_FONT_FAMILY_STACKS[family]
  if (stack) {
    root.style.setProperty(UI_FONT_FAMILY_VAR, stack)
  } else {
    root.style.removeProperty(UI_FONT_FAMILY_VAR)
  }
}

export function applyFontWeight(weight: UiFontWeight): void {
  const root = document.documentElement
  const value = UI_FONT_WEIGHT_VALUES[weight]
  if (!value || weight === 'regular') {
    root.style.removeProperty(UI_FONT_WEIGHT_VAR)
    return
  }
  root.style.setProperty(UI_FONT_WEIGHT_VAR, value)
}

export function applyTypographySettings(settings: {
  uiFontScale?: number
  uiFontFamily?: UiFontFamily
  uiCustomFontFamily?: string
  uiFontWeight?: UiFontWeight
}): void {
  if (typeof settings.uiFontScale === 'number') {
    applyFontScale(settings.uiFontScale)
  }
  if (settings.uiFontFamily) {
    applyFontFamily(settings.uiFontFamily, settings.uiCustomFontFamily)
  }
  if (settings.uiFontWeight) {
    applyFontWeight(settings.uiFontWeight)
  }
}
