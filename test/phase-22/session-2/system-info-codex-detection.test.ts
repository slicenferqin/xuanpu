import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockCanLaunchOpenCode, mockGetCodexLaunchInfo, mockResolveClaudeBinaryPath } = vi.hoisted(
  () => ({
    mockCanLaunchOpenCode: vi.fn(),
    mockGetCodexLaunchInfo: vi.fn(),
    mockResolveClaudeBinaryPath: vi.fn()
  })
)

vi.mock('../../../src/main/services/opencode-binary-resolver', () => ({
  canLaunchOpenCode: mockCanLaunchOpenCode
}))

vi.mock('../../../src/main/services/codex-binary-resolver', () => ({
  getCodexLaunchInfo: mockGetCodexLaunchInfo
}))

vi.mock('../../../src/main/services/claude-binary-resolver', () => ({
  resolveClaudeBinaryPath: mockResolveClaudeBinaryPath
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '1.0.0')
  }
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }),
  getLogDir: vi.fn(() => '/tmp/logs')
}))

import { detectAgentSdks } from '../../../src/main/services/system-info'

describe('system-info: detectAgentSdks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns false for every runtime when no launch capability is available', async () => {
    mockCanLaunchOpenCode.mockResolvedValue(false)
    mockGetCodexLaunchInfo.mockResolvedValue({
      spec: null,
      version: null,
      supportsAppServer: false
    })
    mockResolveClaudeBinaryPath.mockReturnValue(null)

    await expect(detectAgentSdks()).resolves.toEqual({
      opencode: false,
      claude: false,
      codex: false
    })
  })

  it('requires codex app-server capability before reporting codex as available', async () => {
    mockCanLaunchOpenCode.mockResolvedValue(true)
    mockResolveClaudeBinaryPath.mockReturnValue('/usr/local/bin/claude')

    mockGetCodexLaunchInfo.mockResolvedValueOnce({
      spec: { command: '/usr/local/bin/codex', shell: false },
      version: '0.36.0',
      supportsAppServer: false
    })

    await expect(detectAgentSdks()).resolves.toEqual({
      opencode: true,
      claude: true,
      codex: false
    })

    mockGetCodexLaunchInfo.mockResolvedValueOnce({
      spec: { command: '/usr/local/bin/codex', shell: false },
      version: '0.36.0',
      supportsAppServer: true
    })

    await expect(detectAgentSdks()).resolves.toEqual({
      opencode: true,
      claude: true,
      codex: true
    })
  })

  it('keeps the existing boolean return shape for renderer and headless callers', async () => {
    mockCanLaunchOpenCode.mockResolvedValue(true)
    mockGetCodexLaunchInfo.mockResolvedValue({
      spec: { command: '/usr/local/bin/codex', shell: false },
      version: '0.36.0',
      supportsAppServer: true
    })
    mockResolveClaudeBinaryPath.mockReturnValue('/usr/local/bin/claude')

    const result = await detectAgentSdks()

    expect(result).toHaveProperty('opencode', true)
    expect(result).toHaveProperty('claude', true)
    expect(result).toHaveProperty('codex', true)
  })
})
