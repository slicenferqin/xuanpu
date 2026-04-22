/**
 * Field Event Stream — IPC handlers (Phase 21 §5).
 *
 * Narrow channels, one per renderer-owned event type. We deliberately do NOT
 * expose a generic `field:report(event)` shape — that would let the renderer
 * forge main-owned event types (terminal.command, terminal.output,
 * session.message). Future renderer-owned events get their own dedicated
 * channels with specific payload types.
 *
 * Channels:
 *   - field:reportWorktreeSwitch
 *   - field:reportFileOpen
 *   - field:reportFileFocus
 *   - field:reportFileSelection
 */
import { ipcMain } from 'electron'
import { getDatabase } from '../db'
import { createLogger } from '../services/logger'
import { emitFieldEvent } from '../field/emit'
import { getLastInjection } from '../field/last-injection-cache'
import { getSemanticMemory } from '../field/semantic-memory-loader'
import type { WorktreeSwitchTrigger } from '../../shared/types'

const log = createLogger({ component: 'FieldHandlers' })

const MAX_ID_LEN = 64
const MAX_PATH_LEN = 4096
const MAX_NAME_LEN = 256
const MAX_LINE = 10_000_000
const VALID_TRIGGERS: ReadonlySet<string> = new Set<WorktreeSwitchTrigger>([
  'user-click',
  'keyboard',
  'store-restore',
  'unknown'
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isShortString(value: unknown, maxLen: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen
}

function isNonNegInt(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
}

function resolveProjectId(worktreeId: string): string | null {
  return getDatabase().getWorktree(worktreeId)?.project_id ?? null
}

export function registerFieldHandlers(): void {
  log.info('Registering field handlers')

  // -------------------------------------------------------------------------
  // worktree.switch (source-side dedup in useWorktreeStore)
  // -------------------------------------------------------------------------
  ipcMain.on('field:reportWorktreeSwitch', (_event, input: unknown) => {
    if (!isPlainObject(input)) return

    const { fromWorktreeId, toWorktreeId, trigger } = input

    if (!isShortString(toWorktreeId, MAX_ID_LEN)) return
    if (
      fromWorktreeId !== null &&
      (typeof fromWorktreeId !== 'string' || fromWorktreeId.length > MAX_ID_LEN)
    ) {
      return
    }
    if (typeof trigger !== 'string' || !VALID_TRIGGERS.has(trigger)) return

    const worktree = getDatabase().getWorktree(toWorktreeId)
    if (!worktree) return

    emitFieldEvent({
      type: 'worktree.switch',
      worktreeId: toWorktreeId,
      projectId: worktree.project_id,
      sessionId: null,
      relatedEventId: null,
      payload: {
        fromWorktreeId: (fromWorktreeId as string | null) ?? null,
        toWorktreeId,
        trigger: trigger as WorktreeSwitchTrigger
      }
    })
  })

  // -------------------------------------------------------------------------
  // file.open
  // -------------------------------------------------------------------------
  ipcMain.on('field:reportFileOpen', (_event, input: unknown) => {
    if (!isPlainObject(input)) return
    const { worktreeId, path, name } = input
    if (!isShortString(worktreeId, MAX_ID_LEN)) return
    if (!isShortString(path, MAX_PATH_LEN)) return
    if (!isShortString(name, MAX_NAME_LEN)) return

    emitFieldEvent({
      type: 'file.open',
      worktreeId,
      projectId: resolveProjectId(worktreeId),
      sessionId: null,
      relatedEventId: null,
      payload: { path, name }
    })
  })

  // -------------------------------------------------------------------------
  // file.focus
  // -------------------------------------------------------------------------
  ipcMain.on('field:reportFileFocus', (_event, input: unknown) => {
    if (!isPlainObject(input)) return
    const { worktreeId, path, name, fromPath } = input
    if (!isShortString(worktreeId, MAX_ID_LEN)) return
    if (!isShortString(path, MAX_PATH_LEN)) return
    if (!isShortString(name, MAX_NAME_LEN)) return
    if (fromPath !== null && (typeof fromPath !== 'string' || fromPath.length > MAX_PATH_LEN)) {
      return
    }

    emitFieldEvent({
      type: 'file.focus',
      worktreeId,
      projectId: resolveProjectId(worktreeId),
      sessionId: null,
      relatedEventId: null,
      payload: { path, name, fromPath: (fromPath as string | null) ?? null }
    })
  })

  // -------------------------------------------------------------------------
  // file.selection
  // -------------------------------------------------------------------------
  ipcMain.on('field:reportFileSelection', (_event, input: unknown) => {
    if (!isPlainObject(input)) return
    const { worktreeId, path, fromLine, toLine, length } = input
    if (!isShortString(worktreeId, MAX_ID_LEN)) return
    if (!isShortString(path, MAX_PATH_LEN)) return
    if (!isNonNegInt(fromLine, MAX_LINE) || fromLine < 1) return
    if (!isNonNegInt(toLine, MAX_LINE) || toLine < 1) return
    if (!isNonNegInt(length, MAX_LINE)) return

    emitFieldEvent({
      type: 'file.selection',
      worktreeId,
      projectId: resolveProjectId(worktreeId),
      sessionId: null,
      relatedEventId: null,
      payload: { path, fromLine, toLine, length }
    })
  })

  // -------------------------------------------------------------------------
  // Debug: retrieve the last Field Context that was injected for a session.
  // Phase 22A §6.
  // -------------------------------------------------------------------------
  ipcMain.handle('field:getLastInjection', (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    return getLastInjection(sessionId)
  })

  // -------------------------------------------------------------------------
  // Debug: retrieve the episodic memory summary for a worktree.
  // Phase 22B.1.
  // -------------------------------------------------------------------------
  ipcMain.handle('field:getEpisodicMemory', (_event, worktreeId: unknown) => {
    if (typeof worktreeId !== 'string' || worktreeId.length === 0) return null
    return getDatabase().getEpisodicMemory(worktreeId)
  })

  // -------------------------------------------------------------------------
  // Debug: retrieve semantic memory (project + user memory.md files) for a worktree.
  // Phase 22C.1.
  // -------------------------------------------------------------------------
  ipcMain.handle('field:getSemanticMemory', async (_event, worktreeId: unknown) => {
    if (typeof worktreeId !== 'string' || worktreeId.length === 0) return null
    const worktree = getDatabase().getWorktree(worktreeId)
    if (!worktree) return null
    return await getSemanticMemory(worktreeId, worktree.path)
  })
}

