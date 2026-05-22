import { afterEach, describe, expect, it } from 'vitest'
import { applyFontFamily, applyFontWeight, applyTypographySettings } from '@/lib/font-size'

describe('typography settings', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style')
  })

  it('applies built-in and custom UI font families', () => {
    applyFontFamily('mono')
    expect(document.documentElement.style.getPropertyValue('--xuanpu-ui-font-family')).toContain(
      'JetBrains Mono'
    )

    applyFontFamily('custom', '"LXGW WenKai", "SF Pro Text"')
    expect(document.documentElement.style.getPropertyValue('--xuanpu-ui-font-family')).toBe(
      '"LXGW WenKai", "SF Pro Text"'
    )

    applyFontFamily('system')
    expect(document.documentElement.style.getPropertyValue('--xuanpu-ui-font-family')).toBe('')
  })

  it('applies and clears the default UI font weight', () => {
    applyFontWeight('semibold')
    expect(document.documentElement.style.getPropertyValue('--xuanpu-ui-font-weight')).toBe('600')

    applyFontWeight('regular')
    expect(document.documentElement.style.getPropertyValue('--xuanpu-ui-font-weight')).toBe('')
  })

  it('applies typography settings together', () => {
    applyTypographySettings({
      uiFontScale: 1.1,
      uiFontFamily: 'serif',
      uiFontWeight: 'medium'
    })

    expect(document.documentElement.style.getPropertyValue('--text-sm')).toBe('0.9625rem')
    expect(document.documentElement.style.getPropertyValue('--xuanpu-ui-font-family')).toContain(
      'Charter'
    )
    expect(document.documentElement.style.getPropertyValue('--xuanpu-ui-font-weight')).toBe('500')
  })
})
