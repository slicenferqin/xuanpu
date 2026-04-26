import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSession = vi.fn()
const getWorktree = vi.fn()

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('../../src/main/db/database', () => ({
  getDatabase: () => ({
    getDb: () => ({
      prepare: () => ({
        get: () => undefined
      })
    }),
    getSession,
    getWorktree
  })
}))

vi.mock('../../src/main/services/hub/hub-bridge', () => ({
  createHubBridge: () => ({}),
  wrapBrowserWindow: (window: unknown) => window
}))

vi.mock('../../src/main/services/hub/hub-server', () => ({
  DEFAULT_HUB_PORT: 8317,
  createHubServer: () => ({
    start: vi.fn(async () => ({ running: true, port: 8317, host: '127.0.0.1' })),
    stop: vi.fn(async () => undefined),
    status: vi.fn(() => ({ running: true, port: 8317, host: '127.0.0.1' })),
    ensureSetupKey: vi.fn(() => 'setup-key')
  }),
  setHubAuthMode: vi.fn(),
  setHubCfAccessEmails: vi.fn(),
  setHubTunnelUrl: vi.fn()
}))

vi.mock('../../src/main/services/hub/tunnel-service', () => ({
  TunnelService: class {
    on = vi.fn()
    start = vi.fn()
    stop = vi.fn(async () => undefined)
  }
}))

import { HubController } from '../../src/main/services/hub/hub-controller'

function makeController(runtimeManager: { getImplementer: ReturnType<typeof vi.fn> }): HubController {
  return new HubController({
    runtimeManager: runtimeManager as never,
    mainWindow: {
      webContents: { send: vi.fn(), isDestroyed: () => false },
      isDestroyed: () => false
    } as never
  })
}

describe('hub-controller: lazyMaterialize', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when reconnect reports success=false', async () => {
    getSession.mockReturnValue({
      id: 'hive-1',
      worktree_id: 'wt-1',
      agent_sdk: 'codex',
      opencode_session_id: 'thread-1'
    })
    getWorktree.mockReturnValue({
      id: 'wt-1',
      path: '/tmp/wt-1'
    })

    const reconnect = vi.fn(async () => ({ success: false }))
    const controller = makeController({
      getImplementer: vi.fn(() => ({ reconnect }))
    })

    const result = await (
      controller as unknown as {
        lazyMaterialize: (
          mgr: unknown,
          hiveSessionId: string
        ) => Promise<{ worktreePath: string; agentSessionId: string; runtimeId: string } | null>
      }
    ).lazyMaterialize({ getImplementer: vi.fn(() => ({ reconnect })) }, 'hive-1')

    expect(reconnect).toHaveBeenCalledWith('/tmp/wt-1', 'thread-1', 'hive-1')
    expect(result).toBeNull()
  })
})
