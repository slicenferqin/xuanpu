import { describe, expect, it } from 'vitest'
import { migrateSettingsShape } from '../../../src/renderer/src/stores/useSettingsStore'

describe('settings runtime migration', () => {
  it('migrates legacy defaultAgentSdk to defaultRuntimeId', () => {
    const migrated = migrateSettingsShape({
      autoStartSession: false,
      defaultAgentSdk: 'codex'
    })

    expect(migrated.autoStartSession).toBe(false)
    expect(migrated.defaultRuntimeId).toBe('codex')
    expect('defaultAgentSdk' in migrated).toBe(false)
  })

  it('prefers defaultRuntimeId when both new and legacy fields are present', () => {
    const migrated = migrateSettingsShape({
      defaultAgentSdk: 'opencode',
      defaultRuntimeId: 'claude-code'
    })

    expect(migrated.defaultRuntimeId).toBe('claude-code')
  })
})
