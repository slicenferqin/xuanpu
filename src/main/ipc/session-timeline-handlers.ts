/**
 * Session timeline IPC handlers — Phase 2
 *
 * Registers the `session:getTimeline` IPC channel so the renderer can
 * request a unified timeline for any session.
 */

import { ipcMain } from 'electron'
import { createLogger } from '../services/logger'
import { getSessionTimeline } from '../services/session-timeline-service'
import type { AgentRuntimeManager } from '../services/agent-runtime-manager'
import { getDatabase } from '../db'

const log = createLogger({ component: 'TimelineHandlers' })

export function registerTimelineHandlers(runtimeManager?: AgentRuntimeManager): void {
  log.info('Registering timeline handlers')

  ipcMain.handle('session:getTimeline', async (_event, sessionId: string) => {
    try {
      let result = getSessionTimeline(sessionId)

      // If DB returned no messages, try to flush the implementer's in-memory
      // cache to DB first, then re-read. This handles the case where the user
      // switches away from a session mid-stream before messages are persisted.
      if (result.messages.length === 0 && runtimeManager) {
        const session = getDatabase().getSession(sessionId)
        if (session && (session.agent_sdk === 'claude-code' || session.agent_sdk === 'opencode')) {
          const runtimeId = session.agent_sdk === 'claude-code' ? 'claude-code' : 'opencode'
          try {
            const impl = runtimeManager.getImplementer(runtimeId)
            if (impl && session.opencode_session_id) {
              // Resolve working directory path from worktree or connection
              const db = getDatabase()
              let workPath: string | null = null
              if (session.worktree_id) {
                const worktree = db.getWorktree(session.worktree_id)
                workPath = worktree?.path ?? null
              } else if (session.connection_id) {
                const connection = db.getConnection(session.connection_id)
                workPath = connection?.path ?? null
              }

              if (workPath) {
                // getMessages triggers in-memory → DB persist as a side effect
                await impl.getMessages(workPath, session.opencode_session_id)
                // Re-read from DB after flush
                result = getSessionTimeline(sessionId)
                if (result.messages.length > 0) {
                  log.info('getTimeline: recovered messages from implementer memory', {
                    sessionId,
                    count: result.messages.length
                  })
                }
              }
            }
          } catch (err) {
            log.debug('getTimeline: implementer fallback failed', { sessionId, err })
          }
        }
      }

      return result
    } catch (err) {
      log.error(`session:getTimeline failed for ${sessionId}`, err)
      return { messages: [], compactionMarkers: [], revertBoundary: null }
    }
  })
}
