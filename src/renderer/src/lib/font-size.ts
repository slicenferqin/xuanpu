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
