import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineMessage } from '../../src/shared/lib/timeline-types'
import { useSessionThreadStatusRows } from '../../src/renderer/src/hooks/useSessionThreadStatusRows'
import {
  getStreamingBufferSnapshot,
  resetStreamingBuffersForTests,
  updateStreamingBuffer
} from '../../src/renderer/src/stores/useSessionRuntimeStore'

const SESSION_ID = 'thread-status-session'

function compactionMessage(): TimelineMessage {
  return {
    id: 'assistant-compaction',
    role: 'assistant',
    content: '',
    timestamp: '2026-05-26T00:00:00.000Z',
    parts: [{ type: 'compaction' }]
  }
}

describe('useSessionThreadStatusRows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStreamingBuffersForTests()
  })

  it('derives running and inflight compaction status rows', () => {
    const { result } = renderHook(() =>
      useSessionThreadStatusRows({
        sessionId: SESSION_ID,
        lifecycle: 'busy',
        runStartedAt: 100,
        compactionState: { phase: 'running', timestamp: 120 },
        timelineMessages: []
      })
    )

    expect(result.current.ephemeralStatusRows).toEqual([
      {
        id: `running-${SESSION_ID}`,
        kind: 'running',
        timestamp: 100,
        startedAt: 100,
        ephemeral: true
      }
    ])
    expect(result.current.inflightCompactionRow).toEqual({
      id: `compaction-${SESSION_ID}`,
      kind: 'compacting',
      timestamp: 120,
      ephemeral: true
    })
  })

  it('clears completed compaction overlay after the durable compaction row lands', async () => {
    updateStreamingBuffer(
      SESSION_ID,
      (current) => ({
        ...current,
        compactionState: { phase: 'completed', timestamp: 140 }
      }),
      { notify: 'immediate' }
    )

    const { result } = renderHook(() =>
      useSessionThreadStatusRows({
        sessionId: SESSION_ID,
        lifecycle: 'idle',
        runStartedAt: null,
        compactionState: { phase: 'completed', timestamp: 140 },
        timelineMessages: [compactionMessage()]
      })
    )

    expect(result.current.inflightCompactionRow).toBeNull()
    await waitFor(() => {
      expect(getStreamingBufferSnapshot(SESSION_ID).compactionState).toBeNull()
    })
  })
})
