import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockExecFile, mockExistsSync } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockExistsSync: vi.fn()
}))

vi.mock('node:child_process', () => ({
  default: {
    execFile: (...args: unknown[]) => mockExecFile(...args),
    spawn: vi.fn()
  },
  execFile: (...args: unknown[]) => mockExecFile(...args),
  spawn: vi.fn()
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (path: string) => mockExistsSync(path)
    },
    existsSync: (path: string) => mockExistsSync(path)
  }
})

import { resolveCommandLaunchSpec } from '../../../src/main/services/command-launch-utils'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true
  })
}

describe('command-launch-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setPlatform(originalPlatform)
  })

  afterEach(() => {
    setPlatform(originalPlatform)
  })

  it('prefers an executable .exe over .cmd and ignores WindowsApps shims', async () => {
    setPlatform('win32')

    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (...args: unknown[]) => void
      ) => {
        callback(
          null,
          [
            'C:\\Users\\slice\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe',
            'C:\\Users\\slice\\AppData\\Roaming\\npm\\codex.cmd',
            'C:\\tools\\codex.exe'
          ].join('\r\n'),
          ''
        )
      }
    )
    mockExistsSync.mockReturnValue(true)

    await expect(resolveCommandLaunchSpec('codex')).resolves.toEqual({
      command: 'C:\\tools\\codex.exe',
      shell: false
    })
  })

  it('treats .cmd paths with spaces as shell-launched commands on Windows', async () => {
    setPlatform('win32')
    mockExistsSync.mockImplementation(
      (path: string) => path === 'C:\\Program Files\\OpenCode\\opencode.cmd'
    )

    await expect(
      resolveCommandLaunchSpec('C:\\Program Files\\OpenCode\\opencode.cmd')
    ).resolves.toEqual({
      command: 'C:\\Program Files\\OpenCode\\opencode.cmd',
      shell: true
    })

    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('treats .exe paths with spaces as direct executables', async () => {
    setPlatform('win32')
    mockExistsSync.mockImplementation(
      (path: string) => path === 'C:\\Program Files\\Codex\\codex.exe'
    )

    await expect(resolveCommandLaunchSpec('C:\\Program Files\\Codex\\codex.exe')).resolves.toEqual({
      command: 'C:\\Program Files\\Codex\\codex.exe',
      shell: false
    })
  })

  it('returns null when resolution finds no existing candidate', async () => {
    setPlatform('darwin')

    mockExecFile.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (...args: unknown[]) => void
      ) => {
        callback(null, '/usr/local/bin/codex\n', '')
      }
    )
    mockExistsSync.mockReturnValue(false)

    await expect(resolveCommandLaunchSpec('codex')).resolves.toBeNull()
  })
})
