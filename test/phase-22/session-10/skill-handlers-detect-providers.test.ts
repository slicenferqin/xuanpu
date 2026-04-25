import { beforeEach, describe, expect, it, vi } from 'vitest'

const { detectAgentSdks, listInstalledSkills } = vi.hoisted(() => ({
  detectAgentSdks: vi.fn(),
  listInstalledSkills: vi.fn()
}))

type IpcCallback = (event: unknown, ...args: unknown[]) => unknown
const invokeHandlers = new Map<string, IpcCallback>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, cb: IpcCallback) => invokeHandlers.set(channel, cb)
  },
  shell: {
    showItemInFolder: vi.fn()
  }
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('../../../src/main/services/system-info', () => ({
  detectAgentSdks
}))

vi.mock('../../../src/main/services/skill-service', () => ({
  installSkill: vi.fn(),
  listHubSkills: vi.fn(),
  listInstalledSkills,
  readSkillContent: vi.fn(),
  uninstallSkill: vi.fn()
}))

vi.mock('../../../src/main/services/hub-service', () => ({
  addRemoteHub: vi.fn(),
  listHubs: vi.fn(),
  refreshHub: vi.fn(),
  removeRemoteHub: vi.fn()
}))

import { registerSkillHandlers } from '../../../src/main/ipc/skill-handlers'

describe('skill-handlers detectProviders', () => {
  beforeEach(() => {
    invokeHandlers.clear()
    vi.clearAllMocks()
    registerSkillHandlers()
  })

  async function invokeDetectProviders() {
    const cb = invokeHandlers.get('skill:detectProviders')
    if (!cb) throw new Error('handler not registered')
    return cb({}) as Promise<{ success: true; availability: Record<string, boolean> }>
  }

  it('marks a provider available when skills exist even if CLI detection is false', async () => {
    detectAgentSdks.mockResolvedValue({ claude: false, codex: false, opencode: false })
    listInstalledSkills.mockImplementation(async (scope: { provider: string; kind: string }) => {
      if (scope.provider === 'codex' && scope.kind === 'user') {
        return [{ id: 'my-skill' }]
      }
      return []
    })

    await expect(invokeDetectProviders()).resolves.toEqual({
      success: true,
      availability: {
        'claude-code': false,
        codex: true,
        opencode: false
      }
    })
  })

  it('falls back to CLI detection when listing installed skills throws', async () => {
    detectAgentSdks.mockResolvedValue({ claude: true, codex: false, opencode: false })
    listInstalledSkills.mockRejectedValue(new Error('boom'))

    await expect(invokeDetectProviders()).resolves.toEqual({
      success: true,
      availability: {
        'claude-code': true,
        codex: false,
        opencode: false
      }
    })
  })
})
