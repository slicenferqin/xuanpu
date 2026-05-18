import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/Users/tester'
  }
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import { isManagedFunAsrCommandLine } from '../../src/main/services/voice/managed-funasr-runtime'

const MANAGED_SERVER_SCRIPT =
  '/Users/tester/.xuanpu/voice/funasr/runtime/FunASR/runtime/python/websocket/funasr_wss_server.py'

describe('managed FunASR runtime process ownership', () => {
  it('accepts the managed server script on the configured port', () => {
    expect(
      isManagedFunAsrCommandLine(
        `/Users/tester/.xuanpu/voice/funasr/runtime/venv/bin/python ${MANAGED_SERVER_SCRIPT} --host 127.0.0.1 --port 10095`,
        MANAGED_SERVER_SCRIPT,
        { hostPort: 10095 }
      )
    ).toBe(true)
  })

  it('rejects a reused PID when the command is not the managed source tree', () => {
    expect(
      isManagedFunAsrCommandLine(
        '/usr/bin/python /tmp/other/FunASR/runtime/python/websocket/funasr_wss_server.py --port 10095',
        MANAGED_SERVER_SCRIPT,
        { hostPort: 10095 }
      )
    ).toBe(false)
  })

  it('rejects a managed-looking command on the wrong port', () => {
    expect(
      isManagedFunAsrCommandLine(
        `/Users/tester/.xuanpu/voice/funasr/runtime/venv/bin/python ${MANAGED_SERVER_SCRIPT} --host 127.0.0.1 --port 19095`,
        MANAGED_SERVER_SCRIPT,
        { hostPort: 10095 }
      )
    ).toBe(false)
  })
})
