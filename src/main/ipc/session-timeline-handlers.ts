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

function hasRenderableAssistantMessage(messages: unknown[]): boolean {
  return messages.some((message) => {
    if (!message || typeof message !== 'object') return false
    const record = message as Record<string, unknown>
    if (record.role !== 'assistant') return false

    if (typeof record.content === 'string' && record.content.trim().length > 0) {
      return true
    }

    const parts = Array.isArray(record.parts) ? record.parts : []
    return parts.some((part) => {
      if (!part || typeof part !== 'object') return false
      const partRecord = part as Record<string, unknown>
      if (partRecord.type === 'text' && typeof partRecord.text === 'string') {
        return partRecord.text.trim().length > 0
      }
      if (partRecord.type === 'reasoning' && typeof partRecord.reasoning === 'string') {
        return partRecord.reasoning.trim().length > 0
      }
      if (partRecord.type === 'reasoning' && typeof partRecord.text === 'string') {
        return partRecord.text.trim().length > 0
      }
      return false
    })
  })
}

function extractTurnIdFromTimelineId(messageId: string | undefined): string | null {
  if (!messageId) return null
  const match = messageId.match(/^(.*):(user|assistant|tool)(?::.*)?$/)
  return match?.[1] ?? null
}

function hasToolUsePart(record: Record<string, unknown>): boolean {
  const parts = Array.isArray(record.parts) ? record.parts : []
  return parts.some((part) => {
    if (!part || typeof part !== 'object') return false
    return (part as Record<string, unknown>).type === 'tool_use'
  })
}

function hasCodexCollapsedToolOrdering(messages: unknown[]): boolean {
  const byTurn = new Map<string, { assistantTimes: number[]; toolTimes: number[] }>()

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const record = message as Record<string, unknown>
    const turnId = extractTurnIdFromTimelineId(
      typeof record.id === 'string' ? record.id : undefined
    )
    if (!turnId) continue

    const ts = Date.parse(typeof record.timestamp === 'string' ? record.timestamp : '')
    if (!Number.isFinite(ts)) continue
    const bucket = byTurn.get(turnId) ?? { assistantTimes: [], toolTimes: [] }

    if (record.role === 'assistant' && hasToolUsePart(record)) {
      bucket.toolTimes.push(ts)
    } else if (record.role === 'assistant' && hasRenderableAssistantMessage([record])) {
      bucket.assistantTimes.push(ts)
    }

    byTurn.set(turnId, bucket)
  }

  for (const bucket of byTurn.values()) {
    if (bucket.assistantTimes.length < 2 || bucket.toolTimes.length === 0) continue
    const minAssistant = Math.min(...bucket.assistantTimes)
    const maxAssistant = Math.max(...bucket.assistantTimes)
    const minTool = Math.min(...bucket.toolTimes)
    const maxTool = Math.max(...bucket.toolTimes)

    if (maxAssistant - minAssistant <= 1000 && maxTool - minTool >= 2000 && maxAssistant < minTool) {
      return true
    }

    // Older recovery code assigned JSONL timestamps by positional index. When
    // `thread/read` returned summarized items, later assistant text borrowed
    // nearby tool-call timestamps, putting text before the matching tool card.
    const assistantTimesSorted = [...bucket.assistantTimes].sort((left, right) => left - right)
    const borrowedToolTimestampCount = assistantTimesSorted
      .slice(1)
      .filter((assistantTime) =>
        bucket.toolTimes.some((toolTime) => Math.abs(toolTime - assistantTime) <= 100)
      ).length
    if (
      bucket.assistantTimes.length >= 3 &&
      bucket.toolTimes.length >= 2 &&
      borrowedToolTimestampCount >= 2
    ) {
      return true
    }
  }

  return false
}

export function registerTimelineHandlers(runtimeManager?: AgentRuntimeManager): void {
  log.info('Registering timeline handlers')

  ipcMain.handle('session:getTimeline', async (_event, sessionId: string) => {
    try {
      let result = getSessionTimeline(sessionId)

      // If DB returned no messages, or a Codex timeline has only user/tool
      // rows, try to flush/recover the implementer's transcript first.
      // The latter case happens after reconnect/abort paths where the local
      // user rows persisted but assistant agentMessage rows did not.
      let needsImplementerRecovery =
        result.messages.length === 0 || !hasRenderableAssistantMessage(result.messages)

      const session = getDatabase().getSession(sessionId)
      const forceCodexTimelineRefresh =
        session?.agent_sdk === 'codex' && hasCodexCollapsedToolOrdering(result.messages)
      if (forceCodexTimelineRefresh) {
        needsImplementerRecovery = true
      }

      if (needsImplementerRecovery && runtimeManager) {
        if (
          session &&
          (session.agent_sdk === 'claude-code' ||
            session.agent_sdk === 'opencode' ||
            session.agent_sdk === 'codex')
        ) {
          const runtimeId = session.agent_sdk
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
                if (forceCodexTimelineRefresh) {
                  await impl.getMessages(workPath, session.opencode_session_id, {
                    forceRefresh: true
                  })
                } else {
                  await impl.getMessages(workPath, session.opencode_session_id)
                }
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
