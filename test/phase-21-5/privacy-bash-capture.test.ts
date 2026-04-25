/**
 * Phase 21.5 — isBashOutputCaptureEnabled privacy gate tests.
 *
 * Default OFF (must be literally 'true' to enable) — validates that secrets
 * in bash output don't leak to the DB unless the user explicitly opts in.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const getSettingMock = vi.fn<(key: string) => string | null | undefined>()

vi.mock('../../src/main/db', () => ({
  getDatabase: () => ({
    getSetting: getSettingMock
  })
}))

import {
  isBashOutputCaptureEnabled,
  setBashOutputCaptureEnabledCache,
  invalidatePrivacyCache,
  BASH_OUTPUT_CAPTURE_SETTING_KEY
} from '../../src/main/field/privacy'

beforeEach(() => {
  invalidatePrivacyCache()
  getSettingMock.mockReset()
})

describe('isBashOutputCaptureEnabled (Phase 21.5)', () => {
  it('default OFF when setting is absent (null from DB)', () => {
    getSettingMock.mockReturnValue(null)
    expect(isBashOutputCaptureEnabled()).toBe(false)
  })

  it('default OFF when setting is undefined', () => {
    getSettingMock.mockReturnValue(undefined)
    expect(isBashOutputCaptureEnabled()).toBe(false)
  })

  it('OFF when setting is the literal string "false"', () => {
    getSettingMock.mockReturnValue('false')
    expect(isBashOutputCaptureEnabled()).toBe(false)
  })

  it('OFF when setting is any string other than "true"', () => {
    for (const val of ['yes', '1', 'True', 'TRUE', '']) {
      invalidatePrivacyCache()
      getSettingMock.mockReturnValue(val)
      expect(isBashOutputCaptureEnabled()).toBe(false)
    }
  })

  it('ON only when setting is the literal string "true"', () => {
    getSettingMock.mockReturnValue('true')
    expect(isBashOutputCaptureEnabled()).toBe(true)
  })

  it('caches the value after first lookup', () => {
    getSettingMock.mockReturnValue('true')
    expect(isBashOutputCaptureEnabled()).toBe(true)
    expect(isBashOutputCaptureEnabled()).toBe(true)
    // Should only have queried the DB once
    expect(getSettingMock).toHaveBeenCalledTimes(1)
  })

  it('setBashOutputCaptureEnabledCache updates the cache in-band', () => {
    getSettingMock.mockReturnValue(null)
    expect(isBashOutputCaptureEnabled()).toBe(false)
    setBashOutputCaptureEnabledCache(true)
    expect(isBashOutputCaptureEnabled()).toBe(true)
    setBashOutputCaptureEnabledCache(false)
    expect(isBashOutputCaptureEnabled()).toBe(false)
  })

  it('invalidatePrivacyCache forces re-read from DB next call', () => {
    getSettingMock.mockReturnValueOnce('true').mockReturnValueOnce('false')
    expect(isBashOutputCaptureEnabled()).toBe(true) // 1st read
    expect(isBashOutputCaptureEnabled()).toBe(true) // cached
    invalidatePrivacyCache()
    expect(isBashOutputCaptureEnabled()).toBe(false) // 2nd read
    expect(getSettingMock).toHaveBeenCalledTimes(2)
  })

  it('exports the setting key for IPC handlers', () => {
    expect(BASH_OUTPUT_CAPTURE_SETTING_KEY).toBe('agent_bash_capture_output')
  })
})
