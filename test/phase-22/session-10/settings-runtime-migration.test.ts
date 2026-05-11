import { describe, expect, it } from 'vitest'
import {
  mergeCommandFilterSettings,
  migrateSettingsShape
} from '../../../src/renderer/src/stores/useSettingsStore'

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

  it('upgrades the legacy default command filter allowlist', () => {
    const merged = mergeCommandFilterSettings({
      allowlist: ['edit: **', 'write: **'],
      blocklist: ['bash: rm -rf *'],
      defaultBehavior: 'ask',
      enabled: true
    })

    expect(merged.allowlist).toEqual([
      'edit: **',
      'write: **',
      'read: **',
      'grep: * in *',
      'glob: *'
    ])
    expect(merged.blocklist).toEqual(['bash: rm -rf *'])
    expect(merged.defaultBehavior).toBe('ask')
    expect(merged.enabled).toBe(true)
  })

  it('preserves customized command filter allowlists', () => {
    const merged = mergeCommandFilterSettings({
      allowlist: ['bash: git status *'],
      blocklist: ['bash: rm -rf *'],
      defaultBehavior: 'ask',
      enabled: true
    })

    expect(merged.allowlist).toEqual(['bash: git status *'])
    expect(merged.blocklist).toEqual(['bash: rm -rf *'])
    expect(merged.defaultBehavior).toBe('ask')
    expect(merged.enabled).toBe(true)
  })
})
