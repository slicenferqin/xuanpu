import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineMessage } from '../../src/shared/lib/timeline-types'
import { useSessionTimeline } from '../../src/renderer/src/hooks/useSessionTimeline'
import {
  resetStreamingBuffersForTests,
  updateStreamingBuffer
} from '../../src/renderer/src/stores/useSessionRuntimeStore'

function makeUserMessage(id: string, content: string, timestamp: string): TimelineMessage {
  return {
    id,
    role: 'user',
    content,
    timestamp
  }
}

function makeAssistantMessage(id: string, content: string, timestamp: string): TimelineMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp
  }
}

function installAgentOps(overrides: Partial<Window['agentOps']> = {}): {
  getTimeline: ReturnType<typeof vi.fn>
  getMessages: ReturnType<typeof vi.fn>
} {
  const getTimeline = vi.fn().mockResolvedValue({ messages: [] })
  const getMessages = vi.fn().mockResolvedValue({ success: true, messages: [] })
  Object.defineProperty(window, 'agentOps', {
    writable: true,
    configurable: true,
    value: {
      getTimeline,
      getMessages,
      ...overrides
    }
  })
  return { getTimeline, getMessages }
}

describe('useSessionTimeline', () => {
  beforeEach(() => {
    resetStreamingBuffersForTests()
    vi.clearAllMocks()
  })

  afterEach(() => {
    resetStreamingBuffersForTests()
  })

  it('restores optimistic messages from the streaming buffer and removes them after DB match', async () => {
    const sessionId = 'timeline-buffer-session'
    const optimistic = makeUserMessage('optimistic-1', 'continue', '2026-05-26T00:00:01.000Z')
    const durable = makeUserMessage('db-1', 'continue', '2026-05-26T00:00:02.000Z')
    const assistant = makeAssistantMessage('a-1', 'done', '2026-05-26T00:00:03.000Z')
    updateStreamingBuffer(
      sessionId,
      (current) => ({
        ...current,
        optimisticMessages: [optimistic]
      }),
      { notify: 'none' }
    )
    installAgentOps({
      getTimeline: vi.fn().mockResolvedValue({ messages: [durable, assistant] })
    })

    const { result } = renderHook(() => useSessionTimeline(sessionId))

    expect(result.current.messages).toEqual([optimistic])

    await waitFor(() => {
      expect(result.current.messages).toEqual([durable, assistant])
    })
    expect(result.current.optimisticRef.current).toEqual([])
  })

  it('falls back to SDK transcript messages when durable timeline has no assistant content', async () => {
    const durableUser = makeUserMessage('db-user', 'hello', '2026-05-26T00:00:01.000Z')
    const getMessages = vi.fn().mockResolvedValue({
      success: true,
      messages: [
        {
          id: 'sdk-user',
          role: 'user',
          content: 'hello',
          timestamp: '2026-05-26T00:00:01.000Z'
        },
        {
          id: 'sdk-assistant',
          role: 'assistant',
          content: 'fallback reply',
          timestamp: '2026-05-26T00:00:02.000Z'
        }
      ]
    })
    installAgentOps({
      getTimeline: vi.fn().mockResolvedValue({ messages: [durableUser] }),
      getMessages
    })

    const { result } = renderHook(() =>
      useSessionTimeline('timeline-fallback-session', {
        worktreePath: '/tmp/project',
        opencodeSessionId: 'sdk-session',
        agentSdk: 'opencode'
      })
    )

    await waitFor(() => {
      expect(result.current.messages.map((message) => message.id)).toEqual([
        'sdk-user',
        'sdk-assistant'
      ])
    })
    expect(getMessages).toHaveBeenCalledWith('/tmp/project', 'sdk-session')
  })

  it('restores cached attachments onto durable user messages after optimistic refresh', async () => {
    const getTimeline = vi
      .fn()
      .mockResolvedValueOnce({ messages: [] })
      .mockResolvedValue({
        messages: [makeUserMessage('db-attachment', 'inspect this', '2026-05-26T00:00:02.000Z')]
      })
    installAgentOps({ getTimeline })
    const { result } = renderHook(() => useSessionTimeline('timeline-attachment-session'))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    const optimistic = {
      ...makeUserMessage('optimistic-attachment', 'inspect this', '2026-05-26T00:00:01.000Z'),
      attachments: [
        {
          type: 'file' as const,
          mime: 'image/png',
          url: 'data:image/png;base64,abc',
          filename: 'screen.png'
        }
      ]
    }

    act(() => {
      result.current.appendOptimistic(optimistic)
    })

    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.messages).toEqual([
      {
        ...makeUserMessage('db-attachment', 'inspect this', '2026-05-26T00:00:02.000Z'),
        attachments: optimistic.attachments
      }
    ])
    expect(result.current.optimisticRef.current).toEqual([])
  })
})
