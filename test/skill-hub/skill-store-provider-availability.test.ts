import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSkillStore } from '../../src/renderer/src/stores/useSkillStore'

describe('useSkillStore provider availability', () => {
  beforeEach(() => {
    useSkillStore.setState({
      hubs: [],
      selectedHubId: null,
      skillsByHub: {},
      installedByScope: {},
      selectedSkillId: null,
      scope: { provider: 'claude-code', kind: 'user' },
      providerAvailability: {
        'claude-code': false,
        codex: false,
        opencode: false
      },
      loading: false,
      refreshing: false,
      error: null
    })

    Object.defineProperty(window, 'skillOps', {
      configurable: true,
      value: {
        listInstalled: vi.fn().mockResolvedValue({
          success: true,
          skills: [{ id: 'installed-skill' }]
        })
      }
    })
  })

  it('marks the provider available when installed skills are found on disk', async () => {
    await useSkillStore.getState().loadInstalled({ provider: 'codex', kind: 'user' })

    expect(useSkillStore.getState().providerAvailability.codex).toBe(true)
  })
})
