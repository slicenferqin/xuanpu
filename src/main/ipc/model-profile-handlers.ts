import { ipcMain, BrowserWindow } from 'electron'
import { getDatabase } from '../db/database'
import { createLogger } from '../services/logger'
import { syncProfileToClaudeSettings } from '../services/model-profile-sync'
import type { CodexImplementer } from '../services/codex-implementer'
import type { ModelProfileCreate, ModelProfileUpdate } from '@shared/types/model-profile'

const log = createLogger({ component: 'ModelProfileHandlers' })

let codexImpl: CodexImplementer | null = null

export function setCodexImplementer(impl: CodexImplementer): void {
  codexImpl = impl
}

/** Send an event to the renderer process (safe if no windows exist yet) */
function notifyRenderer(channel: string, data: unknown): void {
  const windows = BrowserWindow.getAllWindows()
  if (windows.length > 0) {
    windows[0].webContents.send(channel, data)
  }
}

/**
 * Re-sync settings.local.json for all active worktrees and notify the renderer.
 * Called when a profile's content changes (update/delete/set-default).
 */
function syncAllActiveWorktrees(): void {
  try {
    const db = getDatabase()
    const projects = db.getAllProjects()
    const allWorktreeIds: string[] = []
    for (const project of projects) {
      const worktrees = db.getActiveWorktreesByProject(project.id)
      for (const wt of worktrees) {
        const profile = db.resolveModelProfile(wt.id, project.id)
        syncProfileToClaudeSettings(wt.path, profile)
        allWorktreeIds.push(wt.id)
      }
    }
    if (allWorktreeIds.length > 0) {
      notifyRenderer('model-profile:changed', { worktreeIds: allWorktreeIds })
      if (codexImpl) codexImpl.onModelProfileChanged(allWorktreeIds)
    }
  } catch (err) {
    log.warn('Failed to sync model profile to worktrees', {
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

export function registerModelProfileHandlers(): void {
  ipcMain.handle('model-profile:list', () => {
    return getDatabase().getModelProfiles()
  })

  ipcMain.handle('model-profile:get', (_event, id: string) => {
    return getDatabase().getModelProfile(id)
  })

  ipcMain.handle('model-profile:create', (_event, data: ModelProfileCreate) => {
    return getDatabase().createModelProfile(data)
  })

  ipcMain.handle('model-profile:update', (_event, id: string, data: ModelProfileUpdate) => {
    const result = getDatabase().updateModelProfile(id, data)
    // Profile content changed — re-sync all worktrees that may use it
    syncAllActiveWorktrees()
    return result
  })

  ipcMain.handle('model-profile:delete', (_event, id: string) => {
    const result = getDatabase().deleteModelProfile(id)
    // Profile removed — re-sync all worktrees (references now nullified)
    syncAllActiveWorktrees()
    return result
  })

  ipcMain.handle('model-profile:set-default', (_event, id: string) => {
    getDatabase().setDefaultModelProfile(id)
    // Default changed — re-sync all worktrees that inherit the default
    syncAllActiveWorktrees()
    return true
  })

  ipcMain.handle(
    'model-profile:resolve',
    (_event, worktreeId?: string, projectId?: string) => {
      return getDatabase().resolveModelProfile(worktreeId, projectId)
    }
  )
}
