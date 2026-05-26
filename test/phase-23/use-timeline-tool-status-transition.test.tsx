import React from 'react'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineMessage } from '../../src/shared/lib/timeline-types'
import { useTimelineToolStatusTransition } from '../../src/renderer/src/hooks/useTimelineToolStatusTransition'
import {
  getStreamingBufferSnapshot,
  resetStreamingBuffersForTests,
  updateStreamingBuffer
} from '../../src/renderer/src/stores/useSessionRuntimeStore'

const SESSION_ID = 'tool-status-transition-session'

function toolMessage(): TimelineMessage {
  return {
    id: 'assistant-tool',
    role: 'assistant',
    content: '',
    timestamp: '2026-05-26T00:00:00.000Z',
    parts: [
      {
        type: 'tool_use',
        toolUse: {
          id: 'tool-1',
          name: 'ExitPlanMode',
          input: {},
          status: 'pending',
          startTime: 100
        }
      }
    ]
  }
}

function useHarness(initialMessages: TimelineMessage[]) {
  const [messages, setMessages] = React.useState(initialMessages)
  const timelineMessagesRef = React.useRef(initialMessages)
  const transitionToolStatus = useTimelineToolStatusTransition({
    sessionId: SESSION_ID,
    timelineMessagesRef,
    setMessages
  })

  return { messages, timelineMessagesRef, transitionToolStatus }
}

describe('useTimelineToolStatusTransition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStreamingBuffersForTests()
  })

  it('updates live streaming parts and committed timeline messages together', () => {
    const initialMessages = [toolMessage()]
    updateStreamingBuffer(
      SESSION_ID,
      (current) => ({
        ...current,
        parts: initialMessages[0].parts ?? []
      }),
      { notify: 'immediate' }
    )
    const { result } = renderHook(() => useHarness(initialMessages))

    act(() => {
      result.current.transitionToolStatus('tool-1', 'rejected', 'Plan rejected')
    })

    expect(getStreamingBufferSnapshot(SESSION_ID).parts[0].toolUse).toMatchObject({
      id: 'tool-1',
      status: 'rejected',
      error: 'Plan rejected'
    })
    expect(result.current.timelineMessagesRef.current[0].parts?.[0].toolUse).toMatchObject({
      id: 'tool-1',
      status: 'rejected',
      error: 'Plan rejected'
    })
    expect(result.current.messages[0].parts?.[0].toolUse).toMatchObject({
      id: 'tool-1',
      status: 'rejected',
      error: 'Plan rejected'
    })
  })
})
