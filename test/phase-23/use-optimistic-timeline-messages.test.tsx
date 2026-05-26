import React from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TimelineMessage } from '../../src/shared/lib/timeline-types'
import {
  createOptimisticUserMessage,
  useOptimisticTimelineMessages
} from '../../src/renderer/src/hooks/useOptimisticTimelineMessages'

function createMessage(id: string, content = id): TimelineMessage {
  return {
    id,
    role: 'user',
    content,
    timestamp: '2026-05-26T00:00:00.000Z'
  }
}

function useHarness(options: {
  initialMessages?: TimelineMessage[]
  initialOptimistic?: TimelineMessage[]
} = {}) {
  const [messages, setMessages] = React.useState<TimelineMessage[]>(options.initialMessages ?? [])
  const optimisticRef = React.useRef<TimelineMessage[]>(options.initialOptimistic ?? [])
  const timelineMessagesRef = React.useRef<TimelineMessage[]>(options.initialMessages ?? [])
  const events = React.useRef<string[]>([])
  const requestTurnTopScroll = React.useRef(
    vi.fn(() => {
      events.current.push(`scroll:${timelineMessagesRef.current.length}`)
    })
  ).current
  const syncOptimisticMessagesToMirror = React.useRef(
    vi.fn(() => {
      events.current.push(`sync:${timelineMessagesRef.current.length}`)
    })
  ).current

  const controller = useOptimisticTimelineMessages({
    appendOptimistic: (message) => {
      events.current.push('append')
      optimisticRef.current = [...optimisticRef.current, message]
      setMessages((previous) => [...previous, message])
    },
    optimisticRef,
    timelineMessagesRef,
    setMessages,
    syncOptimisticMessagesToMirror,
    requestTurnTopScroll
  })

  return {
    controller,
    events,
    messages,
    optimisticRef,
    timelineMessagesRef,
    requestTurnTopScroll,
    syncOptimisticMessagesToMirror
  }
}

describe('useOptimisticTimelineMessages', () => {
  it('creates trimmed user messages with delivery status and attachments', () => {
    const message = createOptimisticUserMessage({
      id: 'queued-1',
      content: '  follow up  ',
      deliveryStatus: 'queued',
      attachments: [
        {
          type: 'file',
          mime: 'image/png',
          url: 'data:image/png;base64,abc',
          filename: 'screen.png'
        }
      ]
    })

    expect(message).toMatchObject({
      id: 'queued-1',
      role: 'user',
      content: 'follow up',
      deliveryStatus: 'queued',
      attachments: [
        {
          type: 'file',
          mime: 'image/png',
          url: 'data:image/png;base64,abc',
          filename: 'screen.png'
        }
      ]
    })
  })

  it('appends optimistic messages before requesting top scroll and mirror sync', () => {
    const durable = createMessage('durable-1')
    const message = createMessage('optimistic-1', 'next request')
    const { result } = renderHook(() => useHarness({ initialMessages: [durable] }))

    act(() => {
      result.current.controller.appendOptimisticUserMessage(message)
    })

    expect(result.current.events.current).toEqual(['append', 'scroll:1', 'sync:2'])
    expect(result.current.requestTurnTopScroll).toHaveBeenCalledWith('optimistic-1')
    expect(result.current.optimisticRef.current).toEqual([message])
    expect(result.current.timelineMessagesRef.current).toEqual([durable, message])
    expect(result.current.messages).toEqual([durable, message])
  })

  it('removes optimistic messages from local refs, rendered state, and mirror', () => {
    const durable = createMessage('durable-1')
    const optimistic = createMessage('optimistic-1')
    const { result } = renderHook(() =>
      useHarness({
        initialMessages: [durable, optimistic],
        initialOptimistic: [optimistic]
      })
    )

    act(() => {
      result.current.controller.removeOptimisticUserMessage('optimistic-1')
    })

    expect(result.current.optimisticRef.current).toEqual([])
    expect(result.current.timelineMessagesRef.current).toEqual([durable])
    expect(result.current.messages).toEqual([durable])
    expect(result.current.syncOptimisticMessagesToMirror).toHaveBeenCalledOnce()
  })

  it('trims rendered timeline and keeps only optimistic messages still present in it', () => {
    const durable = createMessage('durable-1')
    const keptOptimistic = createMessage('optimistic-keep')
    const removedOptimistic = createMessage('optimistic-remove')
    const { result } = renderHook(() =>
      useHarness({
        initialMessages: [durable, keptOptimistic, removedOptimistic],
        initialOptimistic: [keptOptimistic, removedOptimistic]
      })
    )

    act(() => {
      result.current.controller.trimOptimisticMessagesToTimeline([durable, keptOptimistic])
    })

    expect(result.current.messages).toEqual([durable, keptOptimistic])
    expect(result.current.timelineMessagesRef.current).toEqual([durable, keptOptimistic])
    expect(result.current.optimisticRef.current).toEqual([keptOptimistic])
    expect(result.current.syncOptimisticMessagesToMirror).toHaveBeenCalledOnce()
  })
})
