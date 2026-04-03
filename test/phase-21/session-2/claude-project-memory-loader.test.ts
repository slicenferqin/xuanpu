import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

describe('claude-project-memory-loader', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
    delete process.env.XUANPU_CLAUDE_PROJECT_MEMORY_ADAPTER
  })

  afterEach(() => {
    process.env = originalEnv
  })

  async function loadModule() {
    const mod = await import(
      '../../../src/main/services/claude-project-memory-loader'
    )
    mod.__testing__.resetCache()
    return mod
  }

  // ── resolveAdapterEntry ─────────────────────────────────────────

  describe('resolveAdapterEntry', () => {
    it('resolves a directory path to dist/index.js', async () => {
      const { __testing__ } = await loadModule()
      const result = __testing__.resolveAdapterEntry('/some/package/dir')
      expect(result).toBe(join('/some/package/dir', 'dist', 'index.js'))
    })

    it('returns .js file path as-is when file exists', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pmr-test-'))
      const filePath = join(tmpDir, 'adapter.js')
      writeFileSync(filePath, 'module.exports = {}')

      try {
        const { __testing__ } = await loadModule()
        const result = __testing__.resolveAdapterEntry(filePath)
        expect(result).toBe(filePath)
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('falls back to dist/index.js when .js path does not exist', async () => {
      const { __testing__ } = await loadModule()
      const result = __testing__.resolveAdapterEntry('/nonexistent/adapter.js')
      expect(result).toBe(join('/nonexistent/adapter.js', 'dist', 'index.js'))
    })
  })

  // ── maybeWithClaudeProjectMemory ────────────────────────────────

  describe('maybeWithClaudeProjectMemory', () => {
    it('returns original options when env var is absent', async () => {
      const { maybeWithClaudeProjectMemory } = await loadModule()
      const input = { cwd: '/test', model: 'sonnet' }
      const result = await maybeWithClaudeProjectMemory(input)
      expect(result).toBe(input)
    })

    it('returns original options when adapter path does not exist', async () => {
      process.env.XUANPU_CLAUDE_PROJECT_MEMORY_ADAPTER = '/nonexistent/adapter'

      const { maybeWithClaudeProjectMemory } = await loadModule()
      const input = { cwd: '/test', model: 'sonnet' }
      const result = await maybeWithClaudeProjectMemory(input)
      expect(result).toBe(input)
    })

    it('returns original options when module has no withProjectMemory export', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'pmr-test-'))
      const entryPath = join(tmpDir, 'dist', 'index.js')
      const { mkdirSync } = await import('fs')
      mkdirSync(join(tmpDir, 'dist'), { recursive: true })
      writeFileSync(entryPath, 'export const somethingElse = 42')

      process.env.XUANPU_CLAUDE_PROJECT_MEMORY_ADAPTER = tmpDir

      try {
        const { maybeWithClaudeProjectMemory } = await loadModule()
        const input = { cwd: '/test', model: 'sonnet' }
        const result = await maybeWithClaudeProjectMemory(input)
        expect(result).toBe(input)
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    })
  })
})
