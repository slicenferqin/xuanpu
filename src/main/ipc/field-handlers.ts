/**
 * Field Event Stream — IPC handlers (Phase 21 §5).
 *
 * Single narrow channel: `field:reportWorktreeSwitch`.
 *
 * Per oracle review: we deliberately do NOT expose a generic
 * `field:report(event)` shape — that would let the renderer forge
 * main-owned event types (terminal.command, session.message). Future
 * renderer-owned events (e.g. file.open in Phase 22) get their own
 * dedicated channels with specific payload types.
 */
import { ipcMain } from 'electron'
import { getDatabase } from '../db'
import { createLogger } from '../services/logger'
import { emitFieldEvent } from '../field/emit'
import type { WorktreeSwitchTrigger } from '../../shared/types'

const log = createLogger({ component: 'FieldHandlers' })

const MAX_ID_LEN = 64
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

function isShortString(value: unknown, maxLen = MAX_ID_LEN): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen
}

export function registerFieldHandlers(): void {
  log.info('Registering field handlers')

  // Fire-and-forget: ipcMain.on (no round-trip), payload validated, worktreeId
  // verified to exist in the DB.
  ipcMain.on('field:reportWorktreeSwitch', (_event, input: unknown) => {
    if (!isPlainObject(input)) return

    const { fromWorktreeId, toWorktreeId, trigger } = input

    if (!isShortString(toWorktreeId)) return
    if (
      fromWorktreeId !== null &&
      (typeof fromWorktreeId !== 'string' || fromWorktreeId.length > MAX_ID_LEN)
    ) {
      return
    }
    if (typeof trigger !== 'string' || !VALID_TRIGGERS.has(trigger)) return

    const worktree = getDatabase().getWorktree(toWorktreeId)
    if (!worktree) {
      // Renderer reported a worktree that doesn't exist in the DB. Silently drop.
      // (Could be a race during creation/deletion; not worth surfacing.)
      return
    }

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
}
