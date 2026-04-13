/**
 * Session timeline IPC handlers — Phase 2
 *
 * Registers the `session:getTimeline` IPC channel so the renderer can
 * request a unified timeline for any session.
 */

import { ipcMain } from 'electron'
import { createLogger } from '../services/logger'
import { getSessionTimeline } from '../services/session-timeline-service'

const log = createLogger({ component: 'TimelineHandlers' })

export function registerTimelineHandlers(): void {
  log.info('Registering timeline handlers')

  ipcMain.handle('session:getTimeline', (_event, sessionId: string) => {
    try {
      return getSessionTimeline(sessionId)
    } catch (err) {
      log.error(`session:getTimeline failed for ${sessionId}`, err)
      return { messages: [], compactionMarkers: [], revertBoundary: null }
    }
  })
}
