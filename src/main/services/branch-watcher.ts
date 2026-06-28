import * as chokidar from 'chokidar'
import { join } from 'path'
import { existsSync, statSync, readFileSync } from 'fs'
import { BrowserWindow } from 'electron'
import { createLogger } from './logger'
import { getEventBus } from '../../server/event-bus'

const log = createLogger({ component: 'BranchWatcher' })

/**
 * BranchWatcher — lightweight HEAD-only watcher for sidebar branch display.
 *
 * Unlike the full WorktreeWatcher (which watches the entire working tree + all
 * .git metadata), this only watches the worktree's gitdir for branch metadata.
 * Watching the directory instead of HEAD itself keeps the watcher alive when Git
 * rewrites HEAD atomically and replaces the file inode.
 *
 * Emits 'git:branchChanged' events to the renderer.
 */

const DEBOUNCE_MS = 300

interface BranchWatcherEntry {
  watcher: chokidar.FSWatcher
  debounceTimer: ReturnType<typeof setTimeout> | null
  gitDir: string
}

const watchers = new Map<string, BranchWatcherEntry>()
let mainWindow: BrowserWindow | null = null

export function isGitHeadPath(eventPath: string, gitDir: string): boolean {
  const normalizedEventPath = eventPath.replace(/\\/g, '/')
  const normalizedGitDir = gitDir.replace(/\\/g, '/').replace(/\/$/, '')
  return normalizedEventPath === 'HEAD' || normalizedEventPath === `${normalizedGitDir}/HEAD`
}

/**
 * Resolve the git dir for a worktree path.
 * For linked worktrees, .git is a file containing "gitdir: /path/to/.git/worktrees/name".
 * For main worktrees, .git is a directory.
 */
function resolveGitDir(worktreePath: string): string | null {
  const dotGit = join(worktreePath, '.git')
  if (!existsSync(dotGit)) return null

  try {
    const stat = statSync(dotGit)
    if (stat.isDirectory()) {
      return dotGit
    }
    const content = readFileSync(dotGit, 'utf-8').trim()
    const match = content.match(/^gitdir:\s*(.+)$/)
    if (match) {
      return match[1]
    }
  } catch {
    // Fall through
  }
  return null
}

function emitBranchChanged(worktreePath: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('git:branchChanged', { worktreePath })
  try {
    getEventBus().emit('git:branchChanged', { worktreePath })
  } catch {
    /* EventBus not available */
  }
}

export function initBranchWatcher(window: BrowserWindow): void {
  mainWindow = window
  log.info('BranchWatcher initialized')
}

export async function watchBranch(worktreePath: string): Promise<void> {
  if (watchers.has(worktreePath)) return

  const gitDir = resolveGitDir(worktreePath)
  if (!gitDir) {
    log.warn('Cannot watch branch — no .git dir found', { worktreePath })
    return
  }

  const watcher = chokidar.watch(gitDir, {
    persistent: true,
    ignoreInitial: true,
    depth: 1
  })

  const entry: BranchWatcherEntry = { watcher, debounceTimer: null, gitDir }

  const scheduleBranchRefresh = (path: string): void => {
    if (!isGitHeadPath(path, gitDir)) return
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      emitBranchChanged(worktreePath)
    }, DEBOUNCE_MS)
  }

  watcher.on('change', scheduleBranchRefresh)
  watcher.on('add', scheduleBranchRefresh)
  watcher.on('unlink', scheduleBranchRefresh)

  watcher.on('error', (error) => {
    log.error('Branch watcher error', error, { worktreePath })
  })

  watchers.set(worktreePath, entry)
  log.info('Branch watcher started', { worktreePath, gitDir })
}

export async function unwatchBranch(worktreePath: string): Promise<void> {
  const entry = watchers.get(worktreePath)
  if (!entry) return

  if (entry.debounceTimer) clearTimeout(entry.debounceTimer)

  try {
    await entry.watcher.close()
  } catch (error) {
    log.error(
      'Failed to close branch watcher',
      error instanceof Error ? error : new Error(String(error)),
      { worktreePath }
    )
  }

  watchers.delete(worktreePath)
}

export async function cleanupBranchWatchers(): Promise<void> {
  log.info('Cleaning up all branch watchers', { count: watchers.size })
  const paths = Array.from(watchers.keys())
  for (const path of paths) {
    await unwatchBranch(path)
  }
}
