import { describe, it, expect, beforeEach } from 'vitest'
import {
  writeEventToStreamingBuffer,
  getStreamingBufferSnapshot,
  resetStreamingBuffersForTests
} from '../../src/renderer/src/stores/useSessionRuntimeStore'
import type { CanonicalAgentEvent } from '../../src/shared/types/agent-protocol'

const SESSION = 'subtask-upsert-session'

describe('subtask streaming buffer upsert', () => {
  beforeEach(() => {
    resetStreamingBuffersForTests()
  })

  function emitSubtaskStart(callID: string, description = 'Test subtask') {
    writeEventToStreamingBuffer(SESSION, {
      type: 'message.part.updated',
      data: {
        part: {
          type: 'subtask',
          callID,
          description,
          agent: 'general',
          state: { status: 'running', time: { start: 1000 } }
        }
      }
    } as unknown as CanonicalAgentEvent)
  }

  function emitSubtaskEnd(
    callID: string,
    status: 'completed' | 'error',
    description = 'Test subtask',
    childSessionId = 'subtask-123'
  ) {
    writeEventToStreamingBuffer(SESSION, {
      type: 'message.part.updated',
      data: {
        part: {
          type: 'subtask',
          callID,
          childSessionId,
          description,
          agent: 'general',
          state: {
            status,
            result: status === 'completed' ? 'Subtask finished successfully' : undefined,
            error: status === 'error' ? 'Subtask failed: timeout' : undefined,
            time: { start: 1000, end: 2000 }
          }
        }
      }
    } as unknown as CanonicalAgentEvent)
  }

  it('start event creates one subtask part with status running', () => {
    emitSubtaskStart('call-1', 'Do something')

    const buffer = getStreamingBufferSnapshot(SESSION)
    const subtaskParts = buffer.parts.filter((p) => p.type === 'subtask')
    expect(subtaskParts).toHaveLength(1)
    expect(subtaskParts[0].subtask).toMatchObject({
      id: 'call-1',
      description: 'Do something',
      agent: 'general',
      status: 'running'
    })
  })

  it('end event updates the same part (upsert) to completed', () => {
    emitSubtaskStart('call-1', 'Do something')
    emitSubtaskEnd('call-1', 'completed', 'Do something', 'subtask-abc')

    const buffer = getStreamingBufferSnapshot(SESSION)
    const subtaskParts = buffer.parts.filter((p) => p.type === 'subtask')
    expect(subtaskParts).toHaveLength(1)
    expect(subtaskParts[0].subtask).toMatchObject({
      id: 'call-1',
      sessionID: 'subtask-abc',
      description: 'Do something',
      agent: 'general',
      status: 'completed',
      result: 'Subtask finished successfully'
    })
    expect(subtaskParts[0].subtask!.error).toBeUndefined()
  })

  it('end event updates the same part to error with error message', () => {
    emitSubtaskStart('call-1', 'Failing task')
    emitSubtaskEnd('call-1', 'error', 'Failing task', 'subtask-err')

    const buffer = getStreamingBufferSnapshot(SESSION)
    const subtaskParts = buffer.parts.filter((p) => p.type === 'subtask')
    expect(subtaskParts).toHaveLength(1)
    expect(subtaskParts[0].subtask).toMatchObject({
      id: 'call-1',
      sessionID: 'subtask-err',
      status: 'error',
      error: 'Subtask failed: timeout'
    })
    expect(subtaskParts[0].subtask!.result).toBeUndefined()
  })

  it('two different callIDs produce two separate subtask parts', () => {
    emitSubtaskStart('call-1', 'Task A')
    emitSubtaskStart('call-2', 'Task B')
    emitSubtaskEnd('call-1', 'completed', 'Task A')

    const buffer = getStreamingBufferSnapshot(SESSION)
    const subtaskParts = buffer.parts.filter((p) => p.type === 'subtask')
    expect(subtaskParts).toHaveLength(2)
    expect(subtaskParts[0].subtask!.status).toBe('completed')
    expect(subtaskParts[1].subtask!.status).toBe('running')
  })

  it('description is preserved across start → end upsert', () => {
    emitSubtaskStart('call-1', 'Original description')
    emitSubtaskEnd('call-1', 'completed', 'Original description')

    const buffer = getStreamingBufferSnapshot(SESSION)
    const subtaskParts = buffer.parts.filter((p) => p.type === 'subtask')
    expect(subtaskParts).toHaveLength(1)
    expect(subtaskParts[0].subtask!.description).toBe('Original description')
  })

  it('end without prior start still creates a part (fallback)', () => {
    emitSubtaskEnd('call-orphan', 'completed', 'Orphan task', 'subtask-orphan')

    const buffer = getStreamingBufferSnapshot(SESSION)
    const subtaskParts = buffer.parts.filter((p) => p.type === 'subtask')
    expect(subtaskParts).toHaveLength(1)
    expect(subtaskParts[0].subtask).toMatchObject({
      id: 'call-orphan',
      sessionID: 'subtask-orphan',
      status: 'completed'
    })
  })
})
