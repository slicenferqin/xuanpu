import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'

const mockReadFileSync = vi.hoisted(() => vi.fn())
const mockExistsSync = vi.hoisted(() => vi.fn())

// Mock electron first (logger depends on it)
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    getVersion: vi.fn(() => '0.0.0-test')
  }
}))

// Partially mock fs — only override readFileSync and existsSync
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args)
  }
})

import {
  expandTilde,
  loadXuanpuAgentConfig
} from '../../src/main/services/xuanpu-agent/config-loader'

describe('xuanpu-agent config-loader', () => {
  const configDir = join(homedir(), '.xuanpu')
  const configPath = join(configDir, 'xuanpu-agent.json')

  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('expandTilde', () => {
    it('expands ~ to homedir', () => {
      const result = expandTilde('~/.xuanpu/xuanpu-agent.auth.json')
      expect(result).toBe(join(homedir(), '.xuanpu/xuanpu-agent.auth.json'))
    })

    it('expands ~/path to homedir/path', () => {
      const result = expandTilde('~/some/path')
      expect(result).toBe(join(homedir(), 'some/path'))
    })

    it('returns absolute paths unchanged', () => {
      const result = expandTilde('/absolute/path')
      expect(result).toBe('/absolute/path')
    })

    it('resolves relative paths', () => {
      const result = expandTilde('relative/path')
      expect(result).toMatch(/relative\/path$/)
    })
  })

  describe('loadXuanpuAgentConfig', () => {
    it('returns env-only defaults when config file does not exist', () => {
      mockExistsSync.mockReturnValue(false)

      const result = loadXuanpuAgentConfig()

      expect(result.configSource).toBe('env-only')
      expect(result.configLoaded).toBe(false)
      expect(result.config.enabled).toBe(false)
      expect(result.config.mainModel).toEqual({
        providerID: 'anthropic',
        modelID: 'claude-haiku-4-5'
      })
    })

    it('returns config from file when it exists and is valid', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          enabled: true,
          mainModel: { providerID: 'openai', modelID: 'gpt-5.5' }
        })
      )

      const result = loadXuanpuAgentConfig()

      expect(result.configSource).toBe('xuanpu-agent-json')
      expect(result.configLoaded).toBe(true)
      expect(result.config.enabled).toBe(true)
      expect(result.config.mainModel).toEqual({
        providerID: 'openai',
        modelID: 'gpt-5.5'
      })
    })

    it('throws on malformed JSON', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue('{ invalid json }')

      expect(() => loadXuanpuAgentConfig()).toThrow('Failed to parse xuanpu-agent config')
    })

    it('throws on missing mainModel fields', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          enabled: true,
          mainModel: { providerID: 'openai' }
        })
      )

      expect(() => loadXuanpuAgentConfig()).toThrow('Invalid mainModel')
    })

    it('fills in default mainModel when omitted', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(JSON.stringify({ enabled: true }))

      const result = loadXuanpuAgentConfig()

      expect(result.config.mainModel).toEqual({
        providerID: 'anthropic',
        modelID: 'claude-haiku-4-5'
      })
    })

    it('applies default apiKeyEnv and authKey for known providers', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          enabled: true,
          providers: {
            openai: { baseUrl: 'https://api.example.com/v1' }
          }
        })
      )

      const result = loadXuanpuAgentConfig()

      expect(result.config.providers?.openai).toMatchObject({
        baseUrl: 'https://api.example.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        authKey: 'OPENAI_API_KEY'
      })
    })

    it('skips unknown provider IDs with a warning', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          enabled: true,
          providers: {
            openai: { apiKeyEnv: 'OPENAI_API_KEY' },
            unknown_provider: { apiKeyEnv: 'SOME_KEY' }
          }
        })
      )

      const result = loadXuanpuAgentConfig()

      expect(result.config.providers).toBeDefined()
      expect(result.config.providers!.openai).toBeDefined()
      expect(result.config.providers!.unknown_provider).toBeUndefined()
    })

    it('validates baseUrl protocol', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          enabled: true,
          providers: {
            openai: { baseUrl: 'ftp://invalid.com/v1' }
          }
        })
      )

      expect(() => loadXuanpuAgentConfig()).toThrow('expected an http(s) URL')
    })

    it('strips trailing slashes from baseUrl', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          enabled: true,
          providers: {
            openai: { baseUrl: 'https://api.example.com/v1/' }
          }
        })
      )

      const result = loadXuanpuAgentConfig()

      expect(result.config.providers?.openai?.baseUrl).toBe('https://api.example.com/v1')
    })

    it('handles compactionModel null', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          enabled: true,
          compactionModel: null
        })
      )

      const result = loadXuanpuAgentConfig()

      expect(result.config.compactionModel).toBeNull()
    })

    it('validates compactionModel fields', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          enabled: true,
          compactionModel: { providerID: 'openai' }
        })
      )

      expect(() => loadXuanpuAgentConfig()).toThrow('Invalid compactionModel')
    })

    it('validates context fields', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          enabled: true,
          context: { contextWindow: -1 }
        })
      )

      expect(() => loadXuanpuAgentConfig()).toThrow('expected a positive number')
    })

    it('accepts valid context fields', () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          enabled: true,
          context: { contextWindow: 500000, autoCompactTokenLimit: 450000 }
        })
      )

      const result = loadXuanpuAgentConfig()

      expect(result.config.context).toEqual({
        contextWindow: 500000,
        autoCompactTokenLimit: 450000
      })
    })

    it('does not read ~/.codex config', () => {
      mockExistsSync.mockReturnValue(false)

      loadXuanpuAgentConfig()

      // Only should check for xuanpu config path
      const calls = mockExistsSync.mock.calls.map((c) => String(c[0]))
      expect(calls.every((c) => !c.includes('.codex'))).toBe(true)
    })

    it('returns configPath in result', () => {
      mockExistsSync.mockReturnValue(false)

      const result = loadXuanpuAgentConfig()

      expect(result.configPath).toBe(configPath)
    })
  })
})
