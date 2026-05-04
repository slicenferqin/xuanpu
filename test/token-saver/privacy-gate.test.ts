/**
 * Tests for `isTokenSaverEnabled` privacy gate (Token Saver stage 2b).
 *
 * Default ON: any value other than the literal string 'false' enables it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const getSettingMock = vi.fn<(key: string) => string | null | undefined>()

vi.mock('../../src/main/db', () => ({
  getDatabase: () => ({
    getSetting: getSettingMock
  })
}))

import {
  isTokenSaverEnabled,
  setTokenSaverEnabledCache,
  invalidatePrivacyCache,
  TOKEN_SAVER_ENABLED_SETTING_KEY
} from '../../src/main/field/privacy'

beforeEach(() => {
  invalidatePrivacyCache()
  getSettingMock.mockReset()
})

describe('isTokenSaverEnabled', () => {
  it('default ON when setting is absent (null)', () => {
    getSettingMock.mockReturnValue(null)
    expect(isTokenSaverEnabled()).toBe(true)
  })

  it('default ON when setting is undefined', () => {
    getSettingMock.mockReturnValue(undefined)
    expect(isTokenSaverEnabled()).toBe(true)
  })

  it('default ON for any value other than literal "false"', () => {
    for (const v of ['true', 'yes', '1', 'TRUE', '', 'enabled']) {
      invalidatePrivacyCache()
      getSettingMock.mockReturnValue(v)
      expect(isTokenSaverEnabled()).toBe(true)
    }
  })

  it('OFF only when setting is the literal string "false"', () => {
    getSettingMock.mockReturnValue('false')
    expect(isTokenSaverEnabled()).toBe(false)
  })

  it('caches after first lookup', () => {
    getSettingMock.mockReturnValue(null)
    expect(isTokenSaverEnabled()).toBe(true)
    expect(isTokenSaverEnabled()).toBe(true)
    expect(getSettingMock).toHaveBeenCalledTimes(1)
  })

  it('setTokenSaverEnabledCache updates the cache in-band', () => {
    getSettingMock.mockReturnValue(null)
    expect(isTokenSaverEnabled()).toBe(true)
    setTokenSaverEnabledCache(false)
    expect(isTokenSaverEnabled()).toBe(false)
    setTokenSaverEnabledCache(true)
    expect(isTokenSaverEnabled()).toBe(true)
  })

  it('invalidatePrivacyCache forces re-read', () => {
    getSettingMock.mockReturnValueOnce('false').mockReturnValueOnce('true')
    expect(isTokenSaverEnabled()).toBe(false)
    expect(isTokenSaverEnabled()).toBe(false) // cached
    invalidatePrivacyCache()
    expect(isTokenSaverEnabled()).toBe(true) // re-read
  })

  it('exports the setting key', () => {
    expect(TOKEN_SAVER_ENABLED_SETTING_KEY).toBe('token_saver_enabled')
  })
})
