import { ipcMain } from 'electron'
import { getDatabase } from '../db/database'
import type { ModelProfileCreate, ModelProfileUpdate } from '@shared/types/model-profile'

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
    return getDatabase().updateModelProfile(id, data)
  })

  ipcMain.handle('model-profile:delete', (_event, id: string) => {
    return getDatabase().deleteModelProfile(id)
  })

  ipcMain.handle('model-profile:set-default', (_event, id: string) => {
    getDatabase().setDefaultModelProfile(id)
    return true
  })

  ipcMain.handle(
    'model-profile:resolve',
    (_event, worktreeId?: string, projectId?: string) => {
      return getDatabase().resolveModelProfile(worktreeId, projectId)
    }
  )
}
