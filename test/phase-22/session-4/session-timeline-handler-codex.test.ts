import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
const getTimelineMock = vi.fn()
const getMessagesMock = vi.fn()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      ipcHandlers.set(channel, handler)
    })
  }
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../../src/main/services/session-timeline-service', () => ({
  getSessionTimeline: (...args: unknown[]) => getTimelineMock(...args)
}))

vi.mock('../../../src/main/db', () => ({
  getDatabase: () => ({
    getSession: vi.fn(() => ({
      id: 'session-1',
      agent_sdk: 'codex',
      opencode_session_id: 'thread-1',
      worktree_id: 'worktree-1',
      connection_id: null
    })),
    getWorktree: vi.fn(() => ({ path: '/repo' })),
    getConnection: vi.fn(),
    getSessionMessages: vi.fn(() => []),
    getSessionActivities: vi.fn(() => [])
  })
}))

import { registerTimelineHandlers } from '../../../src/main/ipc/session-timeline-handlers'

describe('session:getTimeline Codex fallback', () => {
  beforeEach(() => {
    ipcHandlers.clear()
    getTimelineMock.mockReset()
    getMessagesMock.mockReset()
  })

  it('flushes Codex implementer messages and re-reads DB timeline when DB is empty', async () => {
    getTimelineMock
      .mockReturnValueOnce({ messages: [], compactionMarkers: [], revertBoundary: null })
      .mockReturnValueOnce({
        messages: [{ id: 'm1', role: 'assistant', content: 'recovered' }],
        compactionMarkers: [],
        revertBoundary: null
      })
    getMessagesMock.mockResolvedValue([{ role: 'assistant', content: 'recovered' }])

    registerTimelineHandlers({
      getImplementer: vi.fn(() => ({ getMessages: getMessagesMock }))
    } as never)

    const handler = ipcHandlers.get('session:getTimeline')
    expect(handler).toBeDefined()

    const result = await handler?.({}, 'session-1')

    expect(getMessagesMock).toHaveBeenCalledWith('/repo', 'thread-1')
    expect(result).toEqual({
      messages: [{ id: 'm1', role: 'assistant', content: 'recovered' }],
      compactionMarkers: [],
      revertBoundary: null
    })
  })

  it('recovers Codex assistant text when DB has only user/tool timeline rows', async () => {
    getTimelineMock
      .mockReturnValueOnce({
        messages: [
          {
            id: 'turn-1:user',
            role: 'user',
            content: 'question',
            timestamp: '2026-05-23T08:00:00.000Z'
          },
          {
            id: 'turn-1:tool:tool-1',
            role: 'assistant',
            content: '',
            timestamp: '2026-05-23T08:00:01.000Z',
            parts: [{ type: 'tool_use', toolUse: { id: 'tool-1', name: 'Bash' } }]
          }
        ],
        compactionMarkers: [],
        revertBoundary: null
      })
      .mockReturnValueOnce({
        messages: [
          {
            id: 'turn-1:user',
            role: 'user',
            content: 'question',
            timestamp: '2026-05-23T08:00:00.000Z'
          },
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            content: 'answer',
            timestamp: '2026-05-23T08:00:02.000Z',
            parts: [{ type: 'text', text: 'answer' }]
          }
        ],
        compactionMarkers: [],
        revertBoundary: null
      })
    getMessagesMock.mockResolvedValue([{ role: 'assistant', content: 'answer' }])

    registerTimelineHandlers({
      getImplementer: vi.fn(() => ({ getMessages: getMessagesMock }))
    } as never)

    const handler = ipcHandlers.get('session:getTimeline')
    const result = await handler?.({}, 'session-1')

    expect(getMessagesMock).toHaveBeenCalledWith('/repo', 'thread-1')
    expect(result).toEqual({
      messages: [
        {
          id: 'turn-1:user',
          role: 'user',
          content: 'question',
          timestamp: '2026-05-23T08:00:00.000Z'
        },
        {
          id: 'turn-1:assistant',
          role: 'assistant',
          content: 'answer',
          timestamp: '2026-05-23T08:00:02.000Z',
          parts: [{ type: 'text', text: 'answer' }]
        }
      ],
      compactionMarkers: [],
      revertBoundary: null
    })
  })

  it('refreshes Codex timeline when recovered assistant timestamps are collapsed before tools', async () => {
    getTimelineMock
      .mockReturnValueOnce({
        messages: [
          {
            id: 'turn-1:user',
            role: 'user',
            content: 'question',
            timestamp: '2026-05-23T08:00:00.000Z'
          },
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            content: 'intro',
            timestamp: '2026-05-23T08:00:00.001Z',
            parts: [{ type: 'text', text: 'intro' }]
          },
          {
            id: 'turn-1:assistant:item-3',
            role: 'assistant',
            content: 'after tools',
            timestamp: '2026-05-23T08:00:00.002Z',
            parts: [{ type: 'text', text: 'after tools' }]
          },
          {
            id: 'turn-1:tool:tool-1',
            role: 'assistant',
            content: '',
            timestamp: '2026-05-23T08:00:05.000Z',
            parts: [{ type: 'tool_use', toolUse: { id: 'tool-1', name: 'Bash' } }]
          },
          {
            id: 'turn-1:tool:tool-2',
            role: 'assistant',
            content: '',
            timestamp: '2026-05-23T08:00:08.000Z',
            parts: [{ type: 'tool_use', toolUse: { id: 'tool-2', name: 'Bash' } }]
          }
        ],
        compactionMarkers: [],
        revertBoundary: null
      })
      .mockReturnValueOnce({
        messages: [
          {
            id: 'turn-1:user',
            role: 'user',
            content: 'question',
            timestamp: '2026-05-23T08:00:00.000Z'
          },
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            content: 'intro',
            timestamp: '2026-05-23T08:00:01.000Z',
            parts: [{ type: 'text', text: 'intro' }]
          },
          {
            id: 'turn-1:tool:tool-1',
            role: 'assistant',
            content: '',
            timestamp: '2026-05-23T08:00:05.000Z',
            parts: [{ type: 'tool_use', toolUse: { id: 'tool-1', name: 'Bash' } }]
          },
          {
            id: 'turn-1:assistant:item-3',
            role: 'assistant',
            content: 'after tools',
            timestamp: '2026-05-23T08:00:09.000Z',
            parts: [{ type: 'text', text: 'after tools' }]
          }
        ],
        compactionMarkers: [],
        revertBoundary: null
      })
    getMessagesMock.mockResolvedValue([{ role: 'assistant', content: 'recovered' }])

    registerTimelineHandlers({
      getImplementer: vi.fn(() => ({ getMessages: getMessagesMock }))
    } as never)

    const handler = ipcHandlers.get('session:getTimeline')
    const result = await handler?.({}, 'session-1')

    expect(getMessagesMock).toHaveBeenCalledWith('/repo', 'thread-1', { forceRefresh: true })
    const messages = (result as { messages: Array<{ id: string }> }).messages
    expect(messages.map((message) => message.id)).toEqual([
      'turn-1:user',
      'turn-1:assistant',
      'turn-1:tool:tool-1',
      'turn-1:assistant:item-3'
    ])
  })

  it('refreshes Codex timeline when assistant rows borrowed nearby tool timestamps', async () => {
    getTimelineMock
      .mockReturnValueOnce({
        messages: [
          {
            id: 'turn-1:user',
            role: 'user',
            content: 'question',
            timestamp: '2026-05-23T08:00:00.000Z'
          },
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            content: 'intro',
            timestamp: '2026-05-23T08:00:01.000Z',
            parts: [{ type: 'text', text: 'intro' }]
          },
          {
            id: 'turn-1:assistant:item-3',
            role: 'assistant',
            content: 'after first tool',
            timestamp: '2026-05-23T08:00:05.020Z',
            parts: [{ type: 'text', text: 'after first tool' }]
          },
          {
            id: 'turn-1:tool:tool-1',
            role: 'assistant',
            content: '',
            timestamp: '2026-05-23T08:00:05.000Z',
            parts: [{ type: 'tool_use', toolUse: { id: 'tool-1', name: 'Bash' } }]
          },
          {
            id: 'turn-1:assistant:item-4',
            role: 'assistant',
            content: 'after second tool',
            timestamp: '2026-05-23T08:00:08.030Z',
            parts: [{ type: 'text', text: 'after second tool' }]
          },
          {
            id: 'turn-1:tool:tool-2',
            role: 'assistant',
            content: '',
            timestamp: '2026-05-23T08:00:08.000Z',
            parts: [{ type: 'tool_use', toolUse: { id: 'tool-2', name: 'Bash' } }]
          }
        ],
        compactionMarkers: [],
        revertBoundary: null
      })
      .mockReturnValueOnce({
        messages: [
          {
            id: 'turn-1:user',
            role: 'user',
            content: 'question',
            timestamp: '2026-05-23T08:00:00.000Z'
          },
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            content: 'intro',
            timestamp: '2026-05-23T08:00:01.000Z',
            parts: [{ type: 'text', text: 'intro' }]
          },
          {
            id: 'turn-1:tool:tool-1',
            role: 'assistant',
            content: '',
            timestamp: '2026-05-23T08:00:05.000Z',
            parts: [{ type: 'tool_use', toolUse: { id: 'tool-1', name: 'Bash' } }]
          },
          {
            id: 'turn-1:assistant:item-3',
            role: 'assistant',
            content: 'after first tool',
            timestamp: '2026-05-23T08:00:07.000Z',
            parts: [{ type: 'text', text: 'after first tool' }]
          },
          {
            id: 'turn-1:tool:tool-2',
            role: 'assistant',
            content: '',
            timestamp: '2026-05-23T08:00:08.000Z',
            parts: [{ type: 'tool_use', toolUse: { id: 'tool-2', name: 'Bash' } }]
          },
          {
            id: 'turn-1:assistant:item-4',
            role: 'assistant',
            content: 'after second tool',
            timestamp: '2026-05-23T08:00:09.000Z',
            parts: [{ type: 'text', text: 'after second tool' }]
          }
        ],
        compactionMarkers: [],
        revertBoundary: null
      })
    getMessagesMock.mockResolvedValue([{ role: 'assistant', content: 'recovered' }])

    registerTimelineHandlers({
      getImplementer: vi.fn(() => ({ getMessages: getMessagesMock }))
    } as never)

    const handler = ipcHandlers.get('session:getTimeline')
    const result = await handler?.({}, 'session-1')

    expect(getMessagesMock).toHaveBeenCalledWith('/repo', 'thread-1', { forceRefresh: true })
    const messages = (result as { messages: Array<{ id: string }> }).messages
    expect(messages.map((message) => message.id)).toEqual([
      'turn-1:user',
      'turn-1:assistant',
      'turn-1:tool:tool-1',
      'turn-1:assistant:item-3',
      'turn-1:tool:tool-2',
      'turn-1:assistant:item-4'
    ])
  })

  it('refreshes Codex timeline when a durable assistant row appears before its user row', async () => {
    getTimelineMock
      .mockReturnValueOnce({
        messages: [
          {
            id: 'turn-1:assistant:item-5',
            role: 'assistant',
            content: 'final answer',
            timestamp: '2026-05-25T03:09:04.000Z',
            parts: [{ type: 'text', text: 'final answer' }]
          },
          {
            id: 'turn-1:user',
            role: 'user',
            content: 'question',
            timestamp: '2026-05-25T03:09:04.559Z'
          },
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            content: 'progress',
            timestamp: '2026-05-25T03:09:17.944Z',
            parts: [{ type: 'text', text: 'progress' }]
          }
        ],
        compactionMarkers: [],
        revertBoundary: null
      })
      .mockReturnValueOnce({
        messages: [
          {
            id: 'turn-1:user',
            role: 'user',
            content: 'question',
            timestamp: '2026-05-25T03:09:04.559Z'
          },
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            content: 'progress',
            timestamp: '2026-05-25T03:09:17.944Z',
            parts: [{ type: 'text', text: 'progress' }]
          },
          {
            id: 'turn-1:assistant:item-5',
            role: 'assistant',
            content: 'final answer',
            timestamp: '2026-05-25T03:10:33.849Z',
            parts: [{ type: 'text', text: 'final answer' }]
          }
        ],
        compactionMarkers: [],
        revertBoundary: null
      })
    getMessagesMock.mockResolvedValue([{ role: 'assistant', content: 'recovered' }])

    registerTimelineHandlers({
      getImplementer: vi.fn(() => ({ getMessages: getMessagesMock }))
    } as never)

    const handler = ipcHandlers.get('session:getTimeline')
    const result = await handler?.({}, 'session-1')

    expect(getMessagesMock).toHaveBeenCalledWith('/repo', 'thread-1', { forceRefresh: true })
    const messages = (result as { messages: Array<{ id: string }> }).messages
    expect(messages.map((message) => message.id)).toEqual([
      'turn-1:user',
      'turn-1:assistant',
      'turn-1:assistant:item-5'
    ])
  })
})
