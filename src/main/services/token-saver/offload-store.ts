/**
 * ContextOffloadStore — Token Saver stage 2.
 *
 * Persists the full, uncompressed output of a tool invocation to a local file
 * so the compressed version sent to the agent can reference the archive path.
 * The agent never reads archives directly; the user does (via "Show original"
 * in the UI, or by following the path in stderr).
 *
 * Layout:
 *   <root>/<sessionId>/<unix-millis>-<seq>.<ext>
 *
 * - `<root>` defaults to `~/.xuanpu/archive` but is configurable for tests.
 * - `<sessionId>` keeps each session's archives isolated.
 * - The filename embeds the timestamp + a per-session monotonic counter so
 *   archives are sortable and unique even when wall-clock is identical.
 * - `<ext>` is `.txt` for combined stdout+stderr, `.bin` for raw binary.
 *
 * Atomic writes: we write to `<final>.tmp` then `rename()`. Fast, crash-safe.
 * On Windows rename across the same volume is atomic; we don't support
 * cross-volume moves (offload root must be on the user's home volume).
 *
 * Concurrency: the per-session counter is held in-memory and incremented
 * synchronously. Two parallel writes from the same session get distinct seqs.
 *
 * Disk pressure: the store does NOT auto-prune. Stage 3 will add a settings
 * UI to display total size and trigger a one-shot cleanup. Auto-rotate (e.g.
 * "delete archives older than N days") will land in stage 4.
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface OffloadRecord {
  /** Absolute path to the persisted archive. */
  path: string
  /** UTF-8 byte length of the persisted body. */
  bytes: number
  /** Monotonic per-session sequence number (1-based). */
  seq: number
  /** Wall-clock timestamp at write start (ms since epoch). */
  ts: number
}

export interface OffloadInput {
  /** Hive session id (or any stable session-like key). */
  sessionId: string
  /** Body to persist. May contain combined stdout + stderr separators. */
  body: string
  /** Optional file extension (default 'txt'). Don't include the dot. */
  ext?: string
}

export interface ContextOffloadStoreOptions {
  /** Root directory. Defaults to `~/.xuanpu/archive`. */
  rootDir?: string
}

const DEFAULT_ROOT = join(homedir(), '.xuanpu', 'archive')

export class ContextOffloadStore {
  private readonly rootDir: string
  /** sessionId → next sequence number (1-based). */
  private readonly seqMap = new Map<string, number>()

  constructor(options: ContextOffloadStoreOptions = {}) {
    this.rootDir = options.rootDir ?? DEFAULT_ROOT
  }

  /** Returns the configured root directory. */
  getRootDir(): string {
    return this.rootDir
  }

  /**
   * Persist `body` and return a record with the absolute path and metadata.
   *
   * Writes are sequential per call but the function returns once the rename
   * completes. Callers MAY fire-and-forget if they don't need the path back
   * to the agent (rare).
   */
  async write(input: OffloadInput): Promise<OffloadRecord> {
    if (!input.sessionId || typeof input.sessionId !== 'string') {
      throw new Error('ContextOffloadStore.write: sessionId is required')
    }
    if (typeof input.body !== 'string') {
      throw new Error('ContextOffloadStore.write: body must be a string')
    }
    const ext = (input.ext ?? 'txt').replace(/^\./, '')
    const seq = this.nextSeq(input.sessionId)
    const ts = Date.now()
    const fileName = `${ts}-${String(seq).padStart(4, '0')}.${ext}`
    const dir = join(this.rootDir, this.sanitizeSessionId(input.sessionId))
    const finalPath = join(dir, fileName)
    const tmpPath = `${finalPath}.${randomUUID().slice(0, 8)}.tmp`

    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(tmpPath, input.body, 'utf8')
    try {
      await fs.rename(tmpPath, finalPath)
    } catch (err) {
      // Best-effort cleanup of tmp file on rename failure.
      await fs.unlink(tmpPath).catch(() => {})
      throw err
    }

    return {
      path: finalPath,
      bytes: Buffer.byteLength(input.body, 'utf8'),
      seq,
      ts
    }
  }

  /**
   * Read back a previously archived body. Used by UI's "show original" path
   * and by tests. Throws on missing path / read error.
   */
  async read(path: string): Promise<string> {
    return fs.readFile(path, 'utf8')
  }

  /**
   * Total size in bytes of all archives under root. Cheap-ish (single recursive
   * stat walk). Returns 0 if root doesn't exist yet.
   */
  async totalSizeBytes(): Promise<number> {
    return walkSize(this.rootDir)
  }

  /**
   * Delete all archives under root. Use with care — this is destructive.
   * Returns the number of files removed.
   */
  async clearAll(): Promise<number> {
    return walkRemove(this.rootDir)
  }

  // ── Private ────────────────────────────────────────────────────────────

  private nextSeq(sessionId: string): number {
    const cur = this.seqMap.get(sessionId) ?? 0
    const next = cur + 1
    this.seqMap.set(sessionId, next)
    return next
  }

  /**
   * Filesystem-safe sessionId. Hive session ids are UUIDs in practice but we
   * defensively strip path separators just in case.
   */
  private sanitizeSessionId(sessionId: string): string {
    // Replace anything that's not alphanumeric, dash, or underscore.
    return sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Filesystem helpers
// ───────────────────────────────────────────────────────────────────────────

async function walkSize(root: string): Promise<number> {
  let total = 0
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
  for (const e of entries) {
    const p = join(root, e.name)
    if (e.isDirectory()) {
      total += await walkSize(p)
    } else if (e.isFile()) {
      try {
        total += (await fs.stat(p)).size
      } catch {
        // file may have been removed between readdir and stat — ignore
      }
    }
  }
  return total
}

async function walkRemove(root: string): Promise<number> {
  let count = 0
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
  for (const e of entries) {
    const p = join(root, e.name)
    if (e.isDirectory()) {
      count += await walkRemove(p)
      try {
        await fs.rmdir(p)
      } catch {
        // non-empty (race) — ignore
      }
    } else if (e.isFile()) {
      try {
        await fs.unlink(p)
        count++
      } catch {
        // already gone — ignore
      }
    }
  }
  return count
}

// Avoid 'unused' warnings on dirname if we ever drop the import path.
void dirname
