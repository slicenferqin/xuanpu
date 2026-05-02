/**
 * Session Timeline Service — Phase 2
 *
 * Main-process service that reads durable transcript data from SQLite and
 * produces a unified TimelineResult for the renderer.
 *
 * Replaces renderer-side transcript assembly previously done in:
 *   - src/renderer/src/lib/opencode-transcript.ts
 *   - src/renderer/src/lib/codex-timeline.ts
 *
 * The renderer will call this via `session:getTimeline` IPC.
 */

import { getDatabase } from '../db'
import { createLogger } from './logger'
import type { TimelineResult, TimelineMessage } from '../../shared/lib/timeline-types'
import {
  mapDbRowsToTimelineMessages,
  mapRawTranscriptToTimeline,
  deriveCodexTimeline,
  mergeOpenCodePlanActivities
} from '../../shared/lib/timeline-mappers'
import type { DbSessionMessage, DbSessionActivity } from '../../shared/lib/timeline-mappers'
import type { SessionMessage, SessionActivity, Session } from '../db/types'

const log = createLogger({ component: 'SessionTimelineService' })

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert DB SessionMessage rows to the DbSessionMessage shape the shared
 * mappers expect. The DB types and mapper types are structurally identical,
 * but we do an explicit mapping for safety.
 */
function toDbSessionMessage(row: SessionMessage): DbSessionMessage {
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: row.content,
    opencode_message_id: row.opencode_message_id,
    opencode_message_json: row.opencode_message_json,
    opencode_parts_json: row.opencode_parts_json,
    opencode_timeline_json: row.opencode_timeline_json,
    created_at: row.created_at
  }
}

/**
 * Convert DB SessionActivity rows to the DbSessionActivity shape the shared
 * mappers expect.
 */
function toDbSessionActivity(row: SessionActivity): DbSessionActivity {
  return {
    id: row.id,
    session_id: row.session_id,
    agent_session_id: row.agent_session_id,
    thread_id: row.thread_id,
    turn_id: row.turn_id,
    item_id: row.item_id,
    request_id: row.request_id,
    kind: row.kind,
    tone: row.tone,
    summary: row.summary,
    payload_json: row.payload_json,
    sequence: row.sequence,
    created_at: row.created_at
  }
}

/**
 * Detect compaction boundaries from timeline messages.
 * A compaction marker is a message that contains a compaction part.
 */
function extractCompactionMarkers(messages: TimelineMessage[]): string[] {
  const markers: string[] = []
  for (const msg of messages) {
    if (!msg.parts) continue
    for (const part of msg.parts) {
      if (part.type === 'compaction') {
        markers.push(msg.id)
        break
      }
    }
  }
  return markers
}

/**
 * Try to parse the opencode_timeline_json field from message rows.
 * This is the raw transcript array stored by OpenCode / Claude Code.
 * Returns null if no usable timeline JSON is found.
 */
function tryExtractRawTimeline(messageRows: SessionMessage[]): unknown[] | null {
  // The raw timeline is typically stored on the most recent message row
  // with a non-null opencode_timeline_json field.
  for (let i = messageRows.length - 1; i >= 0; i--) {
    const json = messageRows[i].opencode_timeline_json
    if (!json) continue
    try {
      const parsed = JSON.parse(json)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    } catch {
      // Corrupted JSON — skip
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a unified timeline for a session.
 *
 * Routes to the correct mapper based on the session's `agent_sdk`:
 *   - codex    → deriveCodexTimeline (messages + activities)
 *   - opencode / claude-code → raw timeline JSON if available,
 *     otherwise fall back to DB row mapping
 *   - terminal → DB row mapping (simple text messages)
 */
export function getSessionTimeline(sessionId: string): TimelineResult {
  const db = getDatabase()
  const session = db.getSession(sessionId)

  if (!session) {
    log.warn(`getSessionTimeline: session not found: ${sessionId}`)
    return { messages: [], compactionMarkers: [], revertBoundary: null }
  }

  const messageRows = db.getSessionMessages(sessionId)
  let messages: TimelineMessage[]

  switch (session.agent_sdk) {
    case 'codex': {
      const activityRows = db.getSessionActivities(sessionId)
      messages = deriveCodexTimeline(
        messageRows.map(toDbSessionMessage),
        activityRows.map(toDbSessionActivity)
      )
      break
    }

    case 'opencode':
    case 'claude-code': {
      // Prefer the raw timeline JSON when available — it contains the full
      // OpenCode/Claude Code message shapes with parts, timestamps, etc.
      const rawTimeline = tryExtractRawTimeline(messageRows)
      if (rawTimeline) {
        messages = mapRawTranscriptToTimeline(rawTimeline)
      } else {
        // Fallback: build timeline from individual DB rows (less rich,
        // but handles cases where timeline JSON wasn't persisted).
        messages = mapDbRowsToTimelineMessages(messageRows.map(toDbSessionMessage))
      }
      // Phase 1.4.8 (OpenCode plan parity): plan-mode turns produce plan
      // markdown as a regular `text` part — the only way to render a
      // PlanCard in the durable timeline is by attaching ExitPlanMode tool
      // parts derived from `plan.ready` activities. Merge them in here so
      // the card appears alongside the assistant text. (Same mechanism the
      // codex branch above relies on, but scoped to plan rows only so we
      // don't disturb OpenCode's own tool-part stream.)
      if (session.agent_sdk === 'opencode') {
        const activityRows = db.getSessionActivities(sessionId)
        if (Array.isArray(activityRows) && activityRows.length > 0) {
          messages = mergeOpenCodePlanActivities(
            messages,
            activityRows.map(toDbSessionActivity)
          )
        }
      }
      break
    }

    case 'terminal':
    default: {
      messages = mapDbRowsToTimelineMessages(messageRows.map(toDbSessionMessage))
      break
    }
  }

  const compactionMarkers = extractCompactionMarkers(messages)

  return {
    messages,
    compactionMarkers,
    revertBoundary: null // TODO: derive from DB session state in Phase 3
  }
}

/**
 * Look up the session, returning it or null.
 * Exported for testing / IPC handler convenience.
 */
export function getSessionForTimeline(sessionId: string): Session | null {
  return getDatabase().getSession(sessionId)
}
