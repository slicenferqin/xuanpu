import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

describe('Claude Project Memory Loader', () => {
  const ENV_KEY = 'XUANPU_CLAUDE_PROJECT_MEMORY_ADAPTER'
  const originalEnv = process.env[ENV_KEY]

  beforeEach(async () => {
    vi.resetModules()
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY]
    } else {
      process.env[ENV_KEY] = originalEnv
    }
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY]
    } else {
      process.env[ENV_KEY] = originalEnv
    }
  })

  it('returns original options when PMR adapter env is not set', async () => {
    delete process.env[ENV_KEY]
    const mod = await import('../../../src/main/services/claude-project-memory-loader')
    const input = { cwd: '/repo', model: 'sonnet' as const }
    const output = await mod.maybeWithClaudeProjectMemory(input)
    expect(output).toBe(input)
  })

  it('returns original options when configured adapter path is missing', async () => {
    process.env[ENV_KEY] = '/definitely/missing/project-memory-adapter.js'
    const mod = await import('../../../src/main/services/claude-project-memory-loader')
    const input = { cwd: '/repo', model: 'sonnet' as const }
    const output = await mod.maybeWithClaudeProjectMemory(input)
    expect(output).toBe(input)
  })

  it('resolves adapter directories to dist/index.js', async () => {
    const mod = await import('../../../src/main/services/claude-project-memory-loader')
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'xuanpu-pmr-adapter-'))
    expect(mod.__testing__.resolveAdapterEntry(tempDir)).toMatch(/dist[/\\]index\.js$/)
    rmSync(tempDir, { recursive: true, force: true })
  })
})
