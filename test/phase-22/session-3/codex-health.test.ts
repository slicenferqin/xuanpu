import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockEnsureCodexAppServerLaunchSpec,
  mockGetCodexLaunchInfo,
  mockGetResolvedCodexVersion,
  mockExecuteLaunchSpec
} = vi.hoisted(() => ({
  mockEnsureCodexAppServerLaunchSpec: vi.fn(),
  mockGetCodexLaunchInfo: vi.fn(),
  mockGetResolvedCodexVersion: vi.fn(),
  mockExecuteLaunchSpec: vi.fn()
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../../src/main/services/codex-binary-resolver', () => ({
  ensureCodexAppServerLaunchSpec: mockEnsureCodexAppServerLaunchSpec,
  getCodexLaunchInfo: mockGetCodexLaunchInfo,
  getCodexVersion: mockGetResolvedCodexVersion
}))

vi.mock('../../../src/main/services/command-launch-utils', () => ({
  executeLaunchSpec: mockExecuteLaunchSpec
}))

import {
  checkCodexAuth,
  checkCodexHealth,
  getCodexVersion,
  parseAuthOutput,
  parseVersionOutput
} from '../../../src/main/services/codex-health'

describe('codex-health', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnsureCodexAppServerLaunchSpec.mockResolvedValue({ command: 'codex', shell: false })
  })

  describe('parseVersionOutput', () => {
    it('parses version strings with a codex prefix', () => {
      expect(parseVersionOutput('codex 1.2.3')).toBe('1.2.3')
      expect(parseVersionOutput('codex/1.2.3')).toBe('1.2.3')
    })

    it('parses bare and multiline version output', () => {
      expect(parseVersionOutput('1.2.3')).toBe('1.2.3')
      expect(parseVersionOutput('codex 2.0.0\nsome other info')).toBe('2.0.0')
    })

    it('returns null for empty output and falls back to the raw first line otherwise', () => {
      expect(parseVersionOutput('')).toBeNull()
      expect(parseVersionOutput('something unexpected')).toBe('something unexpected')
    })
  })

  describe('parseAuthOutput', () => {
    it('detects unauthenticated output patterns', () => {
      expect(parseAuthOutput('You are not logged in')).toBe('unauthenticated')
      expect(parseAuthOutput('Please run codex login first')).toBe('unauthenticated')
      expect(parseAuthOutput('Status: unauthenticated')).toBe('unauthenticated')
    })

    it('detects structured JSON auth status', () => {
      expect(parseAuthOutput('{"authenticated": true}')).toBe('authenticated')
      expect(parseAuthOutput('{"loggedIn": false}')).toBe('unauthenticated')
    })

    it('assumes authenticated when no failure signal is present', () => {
      expect(parseAuthOutput('Logged in as user@example.com')).toBe('authenticated')
    })
  })

  describe('getCodexVersion', () => {
    it('delegates to the resolver-backed version lookup', async () => {
      mockGetResolvedCodexVersion.mockResolvedValue('0.36.0')

      await expect(getCodexVersion({ command: 'codex', shell: false })).resolves.toBe('0.36.0')
      expect(mockGetResolvedCodexVersion).toHaveBeenCalledWith({ command: 'codex', shell: false })
    })

    it('returns null when resolver-backed version lookup throws', async () => {
      mockGetResolvedCodexVersion.mockRejectedValue(new Error('boom'))

      await expect(getCodexVersion()).resolves.toBeNull()
    })
  })

  describe('checkCodexAuth', () => {
    it('uses the provided launch spec when available', async () => {
      mockExecuteLaunchSpec.mockResolvedValue({
        stdout: '{"authenticated": true}',
        stderr: ''
      })

      await expect(checkCodexAuth({ command: 'codex', shell: false })).resolves.toBe(
        'authenticated'
      )
      expect(mockEnsureCodexAppServerLaunchSpec).not.toHaveBeenCalled()
      expect(mockExecuteLaunchSpec).toHaveBeenCalledWith({ command: 'codex', shell: false }, [
        'login',
        'status'
      ])
    })

    it('returns unknown when the auth probe fails', async () => {
      mockExecuteLaunchSpec.mockRejectedValue(new Error('command failed'))

      await expect(checkCodexAuth()).resolves.toBe('unknown')
      expect(mockEnsureCodexAppServerLaunchSpec).toHaveBeenCalledTimes(1)
    })
  })

  describe('checkCodexHealth', () => {
    it('returns unavailable when the codex CLI cannot be resolved', async () => {
      mockGetCodexLaunchInfo.mockResolvedValue({
        spec: null,
        version: null,
        supportsAppServer: false
      })

      await expect(checkCodexHealth()).resolves.toEqual({
        available: false,
        authStatus: 'unknown',
        message: 'Codex CLI not found. Install it with: npm install -g @openai/codex'
      })
    })

    it('returns unavailable when codex lacks app-server capability', async () => {
      mockGetCodexLaunchInfo.mockResolvedValue({
        spec: { command: 'codex', shell: false },
        version: '0.20.0',
        supportsAppServer: false
      })

      await expect(checkCodexHealth()).resolves.toEqual({
        available: false,
        version: '0.20.0',
        authStatus: 'unknown',
        message: 'Codex CLI 0.20.0 does not support codex app-server. Upgrade @openai/codex.'
      })
    })

    it('returns available with authenticated status when auth succeeds', async () => {
      mockGetCodexLaunchInfo.mockResolvedValue({
        spec: { command: 'codex', shell: false },
        version: '0.36.0',
        supportsAppServer: true
      })
      mockExecuteLaunchSpec.mockResolvedValue({
        stdout: '{"authenticated": true}',
        stderr: ''
      })

      await expect(checkCodexHealth()).resolves.toEqual({
        available: true,
        version: '0.36.0',
        authStatus: 'authenticated'
      })
    })

    it('includes a login hint when auth fails', async () => {
      mockGetCodexLaunchInfo.mockResolvedValue({
        spec: { command: 'codex', shell: false },
        version: '0.36.0',
        supportsAppServer: true
      })
      mockExecuteLaunchSpec.mockResolvedValue({
        stdout: 'not logged in',
        stderr: ''
      })

      await expect(checkCodexHealth()).resolves.toEqual({
        available: true,
        version: '0.36.0',
        authStatus: 'unauthenticated',
        message: 'Codex CLI is not authenticated. Run: codex login'
      })
    })

    it('skips the auth probe when explicitly requested', async () => {
      mockGetCodexLaunchInfo.mockResolvedValue({
        spec: { command: 'codex', shell: false },
        version: '0.36.0',
        supportsAppServer: true
      })

      await expect(checkCodexHealth({ checkAuth: false })).resolves.toEqual({
        available: true,
        version: '0.36.0',
        authStatus: 'unknown'
      })
      expect(mockExecuteLaunchSpec).not.toHaveBeenCalled()
    })
  })
})
