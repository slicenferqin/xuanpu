/**
 * Semantic Memory Loader — Phase 22C.1
 *
 * Reads two layers of user-authored memory.md and caches them with
 * mtime/size invalidation. No chokidar watcher — every prompt path stat()s
 * the two files (~0.1ms) and serves from cache if unchanged.
 *
 * Layers:
 *   - project: {worktreePath}/.xuanpu/memory.md
 *   - user:    ~/.xuanpu/memory.md
 *
 * Behavior:
 *   - File missing -> markdown: null (path is still returned so UI can tell user where to write)
 *   - File too large (>16KB) -> truncated; markdown ends with a notice
 *   - Injection gate disabled -> getSemanticMemory() returns null entirely
 *
 * See docs/prd/phase-22c-semantic-memory.md
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stat, readFile } from 'node:fs/promises'
import { createLogger } from '../services/logger'
import { isMemoryInjectionEnabled } from './privacy'

const log = createLogger({ component: 'SemanticMemoryLoader' })

const MAX_FILE_BYTES = 16 * 1024 // 16 KB per file

export interface CachedFile {
  /** Absolute path to the file (returned even when the file does not exist). */
  path: string
  /** Last-known mtime in ms. -1 means "no file at last check". */
  mtimeMs: number
  /** Last-known size in bytes. -1 means "no file at last check". */
  size: number
  /** File contents (utf-8). null means file does not exist. */
  markdown: string | null
}

export interface SemanticMemoryEntry {
  project: CachedFile
  user: CachedFile
  /** When this entry was assembled (ms). */
  lastReadAt: number
}

// Cache keyed by absolute path so the user-level file is shared across all worktrees.
const cache = new Map<string, CachedFile>()

/**
 * Read both memory layers for a worktree, using mtime/size cache invalidation.
 * Returns null when the user has disabled prompt injection of memory files.
 */
export async function getSemanticMemory(
  worktreeId: string,
  worktreePath: string
): Promise<SemanticMemoryEntry | null> {
  if (!isMemoryInjectionEnabled()) return null

  const projectPath = join(worktreePath, '.xuanpu', 'memory.md')
  const userPath = join(homedir(), '.xuanpu', 'memory.md')

  // Read both in parallel — they're independent.
  const [project, user] = await Promise.all([
    readWithCache(projectPath),
    readWithCache(userPath)
  ])

  log.debug('semantic memory loaded', {
    worktreeId,
    projectFound: project.markdown !== null,
    userFound: user.markdown !== null
  })

  return {
    project,
    user,
    lastReadAt: Date.now()
  }
}

async function readWithCache(path: string): Promise<CachedFile> {
  let mtimeMs: number
  let size: number
  try {
    const s = await stat(path)
    mtimeMs = s.mtimeMs
    size = s.size
  } catch {
    // File doesn't exist (or no perm). Cache the "missing" state so we don't
    // re-stat aggressively on every prompt while the user hasn't created the
    // file yet. Preserve the cached object across calls for reference equality
    // tests and predictable cache behavior.
    const existing = cache.get(path)
    if (existing && existing.mtimeMs === -1 && existing.size === -1) {
      return existing
    }
    const missing: CachedFile = {
      path,
      mtimeMs: -1,
      size: -1,
      markdown: null
    }
    cache.set(path, missing)
    return missing
  }

  const cached = cache.get(path)
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached
  }

  // Cache miss or file changed. Read it.
  let markdown: string | null = null
  try {
    if (size > MAX_FILE_BYTES) {
      // Read only the first MAX_FILE_BYTES and append a notice.
      const fullBuffer = await readFile(path)
      markdown =
        fullBuffer.subarray(0, MAX_FILE_BYTES).toString('utf-8') +
        `\n\n…(truncated; file is ${size} bytes, max ${MAX_FILE_BYTES} for context injection)`
    } else {
      markdown = await readFile(path, 'utf-8')
    }
  } catch (err) {
    log.warn('failed to read semantic memory file', {
      path,
      error: err instanceof Error ? err.message : String(err)
    })
    markdown = null
  }

  const entry: CachedFile = { path, mtimeMs, size, markdown }
  cache.set(path, entry)
  return entry
}

/** Test helper. Clears the entire cache. */
export function invalidateSemanticMemoryForTest(): void {
  cache.clear()
}

export const __SEMANTIC_TUNABLES_FOR_TEST = { MAX_FILE_BYTES }
