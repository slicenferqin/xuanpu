import { beforeEach, describe, expect, it, vi } from 'vitest'
import process from 'process'

type IpcCallback = (event: unknown, ...args: unknown[]) => unknown
const invokeHandlers = new Map<string, IpcCallback>()
const { existsSyncMock, detectEditorsMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  detectEditorsMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, cb: IpcCallback) => invokeHandlers.set(channel, cb)
  }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: existsSyncMock
  }
})

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return {
    ...actual,
    platform: () => 'darwin'
  }
})

vi.mock('../../src/main/services', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../src/main/services/telemetry-service', () => ({
  telemetryService: {
    track: vi.fn()
  }
}))

vi.mock('../../src/main/db', () => ({
  getDatabase: () => ({
    getSetting: vi.fn().mockReturnValue(null)
  })
}))

vi.mock('../../src/main/services/settings-detection', () => ({
  detectEditors: detectEditorsMock,
  detectTerminals: vi.fn()
}))

import { registerSettingsHandlers } from '../../src/main/ipc/settings-handlers'

describe('settings-handlers editor fallback', () => {
  beforeEach(() => {
    invokeHandlers.clear()
    vi.clearAllMocks()
    existsSyncMock.mockImplementation((target: string) => target === process.cwd())
    detectEditorsMock.mockReturnValue([
      {
        id: 'trae',
        name: 'Trae',
        command: '/usr/local/bin/trae',
        available: false
      }
    ])
    registerSettingsHandlers()
  })

  it('falls back to open -a on macOS when editor app is installed but CLI detection is unavailable', async () => {
    const handler = invokeHandlers.get('settings:openWithEditor')
    if (!handler) throw new Error('settings:openWithEditor not registered')

    const result = (await handler({}, process.cwd(), 'trae')) as { success: boolean }

    expect(result.success).toBe(true)
    expect(detectEditorsMock).toHaveBeenCalled()
  })
})
