/**
 * Shared timeline types — Phase 2
 *
 * These types define the unified timeline data shape returned by the
 * main-process timeline service and consumed by the renderer.
 *
 * They mirror the existing types in `src/renderer/src/lib/opencode-transcript.ts`
 * (ToolUseInfo, StreamingPart, OpenCodeMessage) but live in the shared layer
 * so the main process can produce them without renderer dependencies.
 */

import type { MessagePart } from '../types/opencode'

// ---------------------------------------------------------------------------
// Tool use info
// ---------------------------------------------------------------------------

export interface ToolUseInfo {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'pending' | 'running' | 'success' | 'error'
  startTime: number
  endTime?: number
  output?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Streaming part
// ---------------------------------------------------------------------------

export interface StreamingPart {
  type:
    | 'text'
    | 'tool_use'
    | 'subtask'
    | 'step_start'
    | 'step_finish'
    | 'reasoning'
    | 'compaction'
  text?: string
  toolUse?: ToolUseInfo
  subtask?: {
    id: string
    sessionID: string
    prompt: string
    description: string
    agent: string
    parts: StreamingPart[]
    status: 'running' | 'completed' | 'error'
  }
  stepStart?: { snapshot?: string }
  stepFinish?: {
    reason: string
    cost: number
    tokens: { input: number; output: number; reasoning: number }
  }
  reasoning?: string
  compactionAuto?: boolean
}

// ---------------------------------------------------------------------------
// Timeline message
// ---------------------------------------------------------------------------

export interface TimelineMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  steered?: boolean
  parts?: StreamingPart[]
  /** File attachments for user messages (images, PDFs, etc.) */
  attachments?: MessagePart[]
  /**
   * Raw token usage from the model API (assistant messages only). Preserved
   * so the renderer can hydrate the context-window capsule for sessions
   * opened without a live snapshot (otherwise it would show 0%).
   */
  usage?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    reasoning?: number
  }
  /** Model identity captured at send time (for context-window limit lookup). */
  modelRef?: { providerID: string; modelID: string }
}

// ---------------------------------------------------------------------------
// Timeline result — returned by session:getTimeline IPC call
// ---------------------------------------------------------------------------

export interface TimelineResult {
  messages: TimelineMessage[]
  /** Turn/message IDs that correspond to compaction boundaries. */
  compactionMarkers: string[]
  /** The message ID marking the revert boundary (undo/redo). */
  revertBoundary: string | null
}
