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
import {
  getPinnedFacts,
  upsertPinnedFacts,
  PINNED_FACTS_MAX_CHARS
} from '../field/pinned-facts-repository'
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

  // -------------------------------------------------------------------------
  // Debug: retrieve the latest Session Checkpoint for a worktree, evaluated
  // through the verifier (so the debug UI sees what the agent would see).
  // Phase 24C.
  // -------------------------------------------------------------------------
  ipcMain.handle('field:getCheckpoint', async (_event, worktreeId: unknown) => {
    if (typeof worktreeId !== 'string' || worktreeId.length === 0) return null
    const worktree = getDatabase().getWorktree(worktreeId)
    if (!worktree) return null
    const { verifyCheckpoint } = await import('../field/checkpoint-verifier')
    const { getLatestCheckpoint } = await import('../field/checkpoint-repository')
    const verified = await verifyCheckpoint({
      worktreeId,
      worktreePath: worktree.path
    }).catch(() => null)
    const raw = getLatestCheckpoint(worktreeId)
    return { verified, raw }
  })

  // -------------------------------------------------------------------------
  // v1.4.1: Pinned Facts — read.
  // -------------------------------------------------------------------------
  ipcMain.handle('field:getPinnedFacts', (_event, worktreeId: unknown) => {
    if (typeof worktreeId !== 'string' || worktreeId.length === 0) return null
    return getPinnedFacts(worktreeId)
  })

  // -------------------------------------------------------------------------
  // v1.4.1: Pinned Facts — upsert. Returns the canonical post-write record so
  // the renderer can refresh its cache without a follow-up read.
  // -------------------------------------------------------------------------
  ipcMain.handle('field:updatePinnedFacts', (_event, input: unknown) => {
    if (!isPlainObject(input)) {
      throw new Error('updatePinnedFacts: input must be an object')
    }
    const { worktreeId, contentMd } = input
    if (typeof worktreeId !== 'string' || worktreeId.length === 0) {
      throw new Error('updatePinnedFacts: worktreeId is required')
    }
    if (typeof contentMd !== 'string') {
      throw new Error('updatePinnedFacts: contentMd must be a string')
    }
    if (contentMd.length > PINNED_FACTS_MAX_CHARS) {
      throw new Error(
        `Pinned Facts content exceeds ${PINNED_FACTS_MAX_CHARS} chars (got ${contentMd.length})`
      )
    }
    const worktree = getDatabase().getWorktree(worktreeId)
    if (!worktree) {
      throw new Error(`updatePinnedFacts: worktree ${worktreeId} not found`)
    }
    return upsertPinnedFacts(worktreeId, contentMd)
  })

  // -------------------------------------------------------------------------
  // v1.4.2: Episodic Memory — force-regenerate the rolling summary for a
  // worktree. Bypasses the debounce + min-event threshold; respects privacy
  // and "don't downgrade" rules. Returns the new record (or null when the
  // compactor declined — e.g. insufficient events, privacy disabled).
  // -------------------------------------------------------------------------
  ipcMain.handle('field:regenerateEpisodic', async (_event, worktreeId: unknown) => {
    if (typeof worktreeId !== 'string' || worktreeId.length === 0) {
      throw new Error('regenerateEpisodic: worktreeId is required')
    }
    const worktree = getDatabase().getWorktree(worktreeId)
    if (!worktree) {
      throw new Error(`regenerateEpisodic: worktree ${worktreeId} not found`)
    }
    const { getEpisodicMemoryUpdater } = await import('../field/episodic-updater')
    const output = await getEpisodicMemoryUpdater().forceCompact(worktreeId)
    if (!output) return null
    return getDatabase().getEpisodicMemory(worktreeId)
  })

  // -------------------------------------------------------------------------
  // v1.4.2: Episodic Memory — clear the rolling summary for a worktree.
  // The next eligible event will trigger a fresh compaction.
  // -------------------------------------------------------------------------
  ipcMain.handle('field:clearEpisodic', (_event, worktreeId: unknown) => {
    if (typeof worktreeId !== 'string' || worktreeId.length === 0) {
      throw new Error('clearEpisodic: worktreeId is required')
    }
    const deleted = getDatabase().deleteEpisodicMemory(worktreeId)
    return { deleted }
  })
}

