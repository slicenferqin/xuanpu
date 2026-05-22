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

import {
  MANAGED_FUNASR_REQUIRED_PYTHON_PACKAGES,
  isManagedFunAsrCommandLine,
  isSupportedFunAsrPythonVersion,
  parsePythonVersionOutput
} from '../../src/main/services/voice/managed-funasr-runtime'

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

describe('managed FunASR Python runtime selection', () => {
  it('parses Python version output from stdout or stderr text', () => {
    expect(parsePythonVersionOutput('Python 3.11.9')).toEqual({
      major: 3,
      minor: 11,
      patch: 9
    })
    expect(parsePythonVersionOutput('warning\nPython 3.12.2\n')).toEqual({
      major: 3,
      minor: 12,
      patch: 2
    })
    expect(parsePythonVersionOutput('not python')).toBeNull()
  })

  it('accepts PyTorch-compatible Python versions and rejects 3.14', () => {
    expect(isSupportedFunAsrPythonVersion(parsePythonVersionOutput('Python 3.10.13'))).toBe(true)
    expect(isSupportedFunAsrPythonVersion(parsePythonVersionOutput('Python 3.11.9'))).toBe(true)
    expect(isSupportedFunAsrPythonVersion(parsePythonVersionOutput('Python 3.12.2'))).toBe(true)
    expect(isSupportedFunAsrPythonVersion(parsePythonVersionOutput('Python 3.9.6'))).toBe(false)
    expect(isSupportedFunAsrPythonVersion(parsePythonVersionOutput('Python 3.14.5'))).toBe(false)
  })

  it('pins PyTorch packages required by the FunASR websocket server', () => {
    expect(MANAGED_FUNASR_REQUIRED_PYTHON_PACKAGES).toContain('torch==2.11.0')
    expect(MANAGED_FUNASR_REQUIRED_PYTHON_PACKAGES).toContain('torchaudio==2.11.0')
    expect(MANAGED_FUNASR_REQUIRED_PYTHON_PACKAGES).toContain('funasr==1.3.1')
    expect(MANAGED_FUNASR_REQUIRED_PYTHON_PACKAGES).toContain('modelscope==1.37.0')
  })
})
