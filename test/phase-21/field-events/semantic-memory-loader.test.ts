import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'fs'

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

// Point HOME at a sandboxed path for the test (so we don't read the real
// ~/.xuanpu/memory.md if the dev happens to have one).
let originalHome: string | undefined
let sandboxHome: string
let sandboxWorktree: string

beforeEach(() => {
  originalHome = process.env.HOME
  sandboxHome = mkdtempSync(join(tmpdir(), 'xuanpu-sem-home-'))
  sandboxWorktree = mkdtempSync(join(tmpdir(), 'xuanpu-sem-wt-'))
  process.env.HOME = sandboxHome
})

afterEach(() => {
  rmSync(sandboxHome, { recursive: true, force: true })
  rmSync(sandboxWorktree, { recursive: true, force: true })
  if (originalHome !== undefined) {
    process.env.HOME = originalHome
  } else {
    delete process.env.HOME
  }
})

// Import lazily so HOME env change takes effect.
async function loadLoader() {
  const mod = await import('../../../src/main/field/semantic-memory-loader')
  mod.invalidateSemanticMemoryForTest()
  return mod
}

async function setupPrivacy(enabled: boolean): Promise<void> {
  const { setMemoryInjectionEnabledCache } = await import(
    '../../../src/main/field/privacy'
  )
  setMemoryInjectionEnabledCache(enabled)
}

function writeProject(path: string, content: string): void {
  const dir = join(path, '.xuanpu')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'memory.md'), content, 'utf-8')
}

function writeUser(content: string): void {
  const dir = join(sandboxHome, '.xuanpu')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'memory.md'), content, 'utf-8')
}

describe('SemanticMemoryLoader — Phase 22C.1 M1', () => {
  describe('privacy gate', () => {
    it('returns null when injection is disabled', async () => {
      await setupPrivacy(false)
      const { getSemanticMemory } = await loadLoader()
      const out = await getSemanticMemory('w-1', sandboxWorktree)
      expect(out).toBeNull()
    })

    it('reads files when injection is enabled', async () => {
      await setupPrivacy(true)
      writeProject(sandboxWorktree, 'use pnpm not npm')
      const { getSemanticMemory } = await loadLoader()
      const out = await getSemanticMemory('w-1', sandboxWorktree)
      expect(out).not.toBeNull()
      expect(out!.project.markdown).toBe('use pnpm not npm')
    })
  })

  describe('file presence', () => {
    it('returns markdown:null when project file is absent but returns the path', async () => {
      await setupPrivacy(true)
      const { getSemanticMemory } = await loadLoader()
      const out = await getSemanticMemory('w-1', sandboxWorktree)
      expect(out!.project.markdown).toBeNull()
      expect(out!.project.path).toBe(join(sandboxWorktree, '.xuanpu', 'memory.md'))
    })

    it('returns markdown:null when user file is absent but returns the path', async () => {
      await setupPrivacy(true)
      const { getSemanticMemory } = await loadLoader()
      const out = await getSemanticMemory('w-1', sandboxWorktree)
      expect(out!.user.markdown).toBeNull()
      expect(out!.user.path).toBe(join(sandboxHome, '.xuanpu', 'memory.md'))
    })

    it('reads both layers independently when both exist', async () => {
      await setupPrivacy(true)
      writeProject(sandboxWorktree, 'project-level rule')
      writeUser('user-level preference')
      const { getSemanticMemory } = await loadLoader()
      const out = await getSemanticMemory('w-1', sandboxWorktree)
      expect(out!.project.markdown).toBe('project-level rule')
      expect(out!.user.markdown).toBe('user-level preference')
    })
  })

  describe('cache invalidation via mtime/size', () => {
    it('serves from cache when file is unchanged', async () => {
      await setupPrivacy(true)
      writeProject(sandboxWorktree, 'initial')
      const { getSemanticMemory } = await loadLoader()
      const first = await getSemanticMemory('w-1', sandboxWorktree)
      const second = await getSemanticMemory('w-1', sandboxWorktree)
      // Same object returned (reference equality — served from cache)
      expect(first!.project).toBe(second!.project)
    })

    it('invalidates when mtime changes', async () => {
      await setupPrivacy(true)
      writeProject(sandboxWorktree, 'version 1')
      const { getSemanticMemory } = await loadLoader()
      const first = await getSemanticMemory('w-1', sandboxWorktree)
      expect(first!.project.markdown).toBe('version 1')

      // Rewrite with different content + nudge mtime forward
      writeProject(sandboxWorktree, 'version 2 longer')
      const futureMs = Date.now() + 5_000
      const path = join(sandboxWorktree, '.xuanpu', 'memory.md')
      utimesSync(path, futureMs / 1000, futureMs / 1000)

      const second = await getSemanticMemory('w-1', sandboxWorktree)
      expect(second!.project.markdown).toBe('version 2 longer')
    })

    it('caches the missing-file state so we do not re-read constantly', async () => {
      await setupPrivacy(true)
      const { getSemanticMemory } = await loadLoader()
      const first = await getSemanticMemory('w-1', sandboxWorktree)
      const second = await getSemanticMemory('w-1', sandboxWorktree)
      expect(first!.project).toBe(second!.project)
      expect(first!.project.markdown).toBeNull()
    })
  })

  describe('16KB truncation', () => {
    it('truncates and annotates when file exceeds MAX_FILE_BYTES', async () => {
      await setupPrivacy(true)
      const { __SEMANTIC_TUNABLES_FOR_TEST, getSemanticMemory } = await loadLoader()
      const oversize = 'x'.repeat(__SEMANTIC_TUNABLES_FOR_TEST.MAX_FILE_BYTES + 500)
      writeProject(sandboxWorktree, oversize)
      const out = await getSemanticMemory('w-1', sandboxWorktree)
      expect(out!.project.markdown).not.toBeNull()
      expect(out!.project.markdown!.length).toBeGreaterThanOrEqual(
        __SEMANTIC_TUNABLES_FOR_TEST.MAX_FILE_BYTES
      )
      expect(out!.project.markdown).toContain('truncated')
    })

    it('small files are returned verbatim', async () => {
      await setupPrivacy(true)
      writeProject(sandboxWorktree, 'tiny content')
      const { getSemanticMemory } = await loadLoader()
      const out = await getSemanticMemory('w-1', sandboxWorktree)
      expect(out!.project.markdown).toBe('tiny content')
    })
  })

  describe('cross-worktree user-layer sharing', () => {
    it('one user file is cached once, shared across worktrees', async () => {
      await setupPrivacy(true)
      writeUser('global preference')
      const { getSemanticMemory } = await loadLoader()
      const wt2 = mkdtempSync(join(tmpdir(), 'xuanpu-sem-wt2-'))
      try {
        const a = await getSemanticMemory('w-1', sandboxWorktree)
        const b = await getSemanticMemory('w-2', wt2)
        expect(a!.user).toBe(b!.user) // same cached entry
        expect(a!.user.markdown).toBe('global preference')
      } finally {
        rmSync(wt2, { recursive: true, force: true })
      }
    })
  })
})
