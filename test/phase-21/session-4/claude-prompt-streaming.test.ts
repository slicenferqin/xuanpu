/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn()
}))
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp')
  }
}))
vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn().mockResolvedValue({ query: mockQuery })
}))

vi.mock('../../../src/main/services/claude-transcript-reader', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/main/services/claude-transcript-reader')
  >('../../../src/main/services/claude-transcript-reader')

  return {
    ...actual,
    readClaudeTranscript: vi.fn().mockResolvedValue([])
  }
})

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import {
  ClaudeCodeImplementer,
  type ClaudeSessionState
} from '../../../src/main/services/claude-code-implementer'
import { readClaudeTranscript } from '../../../src/main/services/claude-transcript-reader'

const readClaudeTranscriptMock = vi.mocked(readClaudeTranscript)

function createMockWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

function createMockQueryIterator(messages: Array<Record<string, unknown>>) {
  let index = 0
  const iterator = {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    next: vi.fn().mockImplementation(async () => {
      if (index < messages.length) {
        return { done: false, value: messages[index++] }
      }
      return { done: true, value: undefined }
    }),
    return: vi.fn().mockResolvedValue({ done: true, value: undefined }),
    [Symbol.asyncIterator]: () => iterator
  }
  return iterator
}

function getStreamEvents(window: BrowserWindow): any[] {
  const send = (window.webContents as any).send as ReturnType<typeof vi.fn>
  return send.mock.calls
    .filter((call: any[]) => call[0] === 'agent:stream')
    .map((call: any[]) => call[1])
}

describe('ClaudeCodeImplementer – prompt streaming (Session 4)', () => {
  let impl: ClaudeCodeImplementer
  let sessions: Map<string, ClaudeSessionState>
  let mockWindow: BrowserWindow

  beforeEach(() => {
    vi.clearAllMocks()
    readClaudeTranscriptMock.mockResolvedValue([])
    impl = new ClaudeCodeImplementer()
    sessions = (impl as any).sessions
    mockWindow = createMockWindow()
    impl.setMainWindow(mockWindow)
  })

  // ── prompt() ────────────────────────────────────────────────────────

  describe('prompt()', () => {
    it('throws if session is not found', async () => {
      await expect(impl.prompt('/proj', 'nonexistent-session', 'hello')).rejects.toThrow(
        /session not found/i
      )
    })

    it('emits session.status busy then idle for a simple prompt', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const iter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-real-1',
          content: [{ type: 'text', text: 'Hello!' }]
        }
      ])
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', sessionId, 'hi')

      const events = getStreamEvents(mockWindow)

      // First event should be busy status
      expect(events[0]).toMatchObject({
        type: 'session.status',
        sessionId: 'hive-1',
        statusPayload: { type: 'busy' }
      })

      // Last event should be idle status
      expect(events[events.length - 1]).toMatchObject({
        type: 'session.status',
        sessionId: 'hive-1',
        statusPayload: { type: 'idle' }
      })
    })

    it('materializes pending:: session ID on first SDK message', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')
      expect(sessionId).toMatch(/^pending::/)

      const oldKey = (impl as any).getSessionKey('/proj', sessionId)
      expect(sessions.has(oldKey)).toBe(true)

      const iter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-real-abc',
          content: [{ type: 'text', text: 'Hi' }]
        }
      ])
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', sessionId, 'hello')

      // Old pending key should be gone
      expect(sessions.has(oldKey)).toBe(false)

      // New key with real SDK session ID should exist
      const newKey = (impl as any).getSessionKey('/proj', 'sdk-real-abc')
      expect(sessions.has(newKey)).toBe(true)

      const state = sessions.get(newKey)!
      expect(state.claudeSessionId).toBe('sdk-real-abc')
      expect(state.materialized).toBe(true)
    })

    it('emits message.updated for a completed assistant message', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const iter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-1',
          content: [
            { type: 'text', text: 'First block' },
            { type: 'text', text: 'Second block' }
          ]
        }
      ])
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', sessionId, 'test')

      const events = getStreamEvents(mockWindow)
      const messageEvent = events.find((event: any) => event.type === 'message.updated')
      expect(messageEvent).toMatchObject({
        type: 'message.updated',
        sessionId: 'hive-1',
        data: {
          role: 'assistant'
        }
      })
    })

    it('captures user message UUIDs as checkpoints', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const iter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-1',
          content: [{ type: 'text', text: 'Hi' }]
        },
        {
          type: 'user',
          session_id: 'sdk-1',
          uuid: 'user-msg-uuid-42',
          content: [{ type: 'text', text: 'echo' }]
        }
      ])
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', sessionId, 'test')

      // Find the session (may have been re-keyed)
      const newKey = (impl as any).getSessionKey('/proj', 'sdk-1')
      const state = sessions.get(newKey)!
      expect(state.checkpoints.has('user-msg-uuid-42')).toBe(true)
    })

    it('skips init messages', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const iter = createMockQueryIterator([
        {
          type: 'init',
          session_id: 'sdk-1',
          content: { some: 'init-data' }
        },
        {
          type: 'assistant',
          session_id: 'sdk-1',
          content: [{ type: 'text', text: 'Hello' }]
        }
      ])
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', sessionId, 'test')

      const events = getStreamEvents(mockWindow)

      // No events should have init type data forwarded
      const initEvents = events.filter((e: any) => e.data?.type === 'init')
      expect(initEvents.length).toBe(0)
    })

    it('emits session.error and then idle on SDK error', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      mockQuery.mockImplementation(() => {
        throw new Error('SDK query failed')
      })

      await impl.prompt('/proj', sessionId, 'test')

      const events = getStreamEvents(mockWindow)

      // Should have busy, then error, then idle
      expect(events[0]).toMatchObject({
        type: 'session.status',
        statusPayload: { type: 'busy' }
      })

      const errorEvent = events.find((e: any) => e.type === 'session.error')
      expect(errorEvent).toBeDefined()
      expect(errorEvent.sessionId).toBe('hive-1')

      // Last event should be idle
      expect(events[events.length - 1]).toMatchObject({
        type: 'session.status',
        statusPayload: { type: 'idle' }
      })
    })

    it('refreshes exact context usage after compact_boundary before marking compaction complete', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const iter = createMockQueryIterator([
        {
          type: 'system',
          subtype: 'status',
          status: 'compacting',
          session_id: 'sdk-compact-1'
        },
        {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto' },
          session_id: 'sdk-compact-1'
        }
      ]) as ReturnType<typeof createMockQueryIterator> & {
        getContextUsage: ReturnType<typeof vi.fn>
      }

      iter.getContextUsage = vi.fn().mockResolvedValue({
        categories: [{ name: 'Messages', tokens: 50000, color: '#237a68' }],
        totalTokens: 50000,
        maxTokens: 200000,
        rawMaxTokens: 1000000,
        percentage: 25,
        gridRows: [],
        model: 'claude-opus-4-7',
        memoryFiles: [],
        mcpTools: []
      })
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', sessionId, 'compact me')

      const events = getStreamEvents(mockWindow)
      const types = events.map((event: any) => event.type)
      const contextUsageIndex = types.indexOf('session.context_usage')
      const compactedIndex = types.indexOf('session.context_compacted')

      expect(types).toContain('session.compaction_started')
      expect(types).toContain('message.part.updated')
      expect(contextUsageIndex).toBeGreaterThan(-1)
      expect(compactedIndex).toBeGreaterThan(contextUsageIndex)
      expect(events[contextUsageIndex]).toMatchObject({
        type: 'session.context_usage',
        sessionId: 'hive-1',
        data: {
          contextWindow: 200000,
          model: {
            providerID: 'anthropic',
            modelID: 'opus'
          },
          breakdown: {
            usedTokens: 50000,
            maxTokens: 200000,
            rawMaxTokens: 1000000,
            percentage: 25
          }
        }
      })
      expect(iter.getContextUsage).toHaveBeenCalledTimes(1)
    })

    it('does not emit fake context usage when post-compaction refresh fails', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')

      const iter = createMockQueryIterator([
        {
          type: 'system',
          subtype: 'status',
          status: 'compacting',
          session_id: 'sdk-compact-2'
        },
        {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'manual' },
          session_id: 'sdk-compact-2'
        }
      ]) as ReturnType<typeof createMockQueryIterator> & {
        getContextUsage: ReturnType<typeof vi.fn>
      }

      iter.getContextUsage = vi.fn().mockRejectedValue(new Error('not supported'))
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', sessionId, 'compact me again')

      const events = getStreamEvents(mockWindow)
      const types = events.map((event: any) => event.type)

      expect(types).toContain('session.compaction_started')
      expect(types).toContain('session.context_compacted')
      expect(types).not.toContain('session.context_usage')
      expect(iter.getContextUsage).toHaveBeenCalledTimes(1)
    })

    it('passes resume ID to SDK when session is materialized', async () => {
      await impl.reconnect('/proj', 'real-sdk-id-1', 'hive-1')

      const iter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'real-sdk-id-1',
          content: [{ type: 'text', text: 'Resumed' }]
        }
      ])
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', 'real-sdk-id-1', 'continue')

      expect(mockQuery).toHaveBeenCalledTimes(1)
      const callArgs = mockQuery.mock.calls[0][0]
      expect(callArgs.options.resume).toBe('real-sdk-id-1')
    })
  })

  // ── DB materialization update ─────────────────────────────────────

  describe('DB materialization update', () => {
    it('updates DB opencode_session_id after materialization', async () => {
      const mockDb = {
        updateSession: vi.fn(),
        getSession: vi.fn()
      }
      impl.setDatabaseService(mockDb as any)

      const { sessionId } = await impl.connect('/proj', 'hive-1')
      const messages = [
        { type: 'assistant', session_id: 'real-sdk-id', content: [{ type: 'text', text: 'Hi' }] }
      ]
      mockQuery.mockReturnValue(createMockQueryIterator(messages))

      await impl.prompt('/proj', sessionId, 'Hello')

      expect(mockDb.updateSession).toHaveBeenCalledWith('hive-1', {
        opencode_session_id: 'real-sdk-id'
      })
    })

    it('does not fail if dbService is null', async () => {
      // No setDatabaseService called — dbService is null
      const { sessionId } = await impl.connect('/proj', 'hive-1')
      const messages = [
        { type: 'assistant', session_id: 'real-sdk-id', content: [{ type: 'text', text: 'Hi' }] }
      ]
      mockQuery.mockReturnValue(createMockQueryIterator(messages))

      // Should not throw
      await impl.prompt('/proj', sessionId, 'Hello')
    })

    it('handles DB update error gracefully', async () => {
      const mockDb = {
        updateSession: vi.fn().mockImplementation(() => {
          throw new Error('DB write failed')
        }),
        getSession: vi.fn()
      }
      impl.setDatabaseService(mockDb as any)

      const { sessionId } = await impl.connect('/proj', 'hive-1')
      const messages = [
        { type: 'assistant', session_id: 'real-sdk-id', content: [{ type: 'text', text: 'Hi' }] }
      ]
      mockQuery.mockReturnValue(createMockQueryIterator(messages))

      // Should not throw even if DB fails
      await impl.prompt('/proj', sessionId, 'Hello')

      expect(mockDb.updateSession).toHaveBeenCalledWith('hive-1', {
        opencode_session_id: 'real-sdk-id'
      })
    })

    it('does not update DB when session is already materialized', async () => {
      const mockDb = {
        updateSession: vi.fn(),
        getSession: vi.fn()
      }
      impl.setDatabaseService(mockDb as any)

      // Reconnect creates an already-materialized session
      await impl.reconnect('/proj', 'existing-sdk-id', 'hive-1')
      const messages = [
        {
          type: 'assistant',
          session_id: 'existing-sdk-id',
          content: [{ type: 'text', text: 'Resumed' }]
        }
      ]
      mockQuery.mockReturnValue(createMockQueryIterator(messages))

      await impl.prompt('/proj', 'existing-sdk-id', 'continue')

      // DB should NOT be updated since session was already materialized
      expect(mockDb.updateSession).not.toHaveBeenCalled()
    })

    it('reconciles final assistant usage from transcript before persisting messages', async () => {
      const mockDb = {
        updateSession: vi.fn(),
        getSession: vi.fn(),
        replaceSessionMessages: vi.fn()
      }
      impl.setDatabaseService(mockDb as any)

      readClaudeTranscriptMock.mockResolvedValue([
        {
          id: 'assistant-final-1',
          role: 'assistant',
          timestamp: '2026-04-18T10:00:01.000Z',
          content: 'Done.',
          parts: [{ type: 'text', text: 'Done.' }],
          usage: {
            input_tokens: 1,
            output_tokens: 42,
            cache_creation_input_tokens: 63194,
            cache_read_input_tokens: 0
          },
          model: 'claude-opus-4-7',
          cost: 0.395111
        }
      ])

      const { sessionId } = await impl.connect('/proj', 'hive-1')
      const iter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'real-sdk-id',
          uuid: 'assistant-final-1',
          message: {
            id: 'assistant-message-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'Done.' }],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 63194,
              cache_read_input_tokens: 0
            },
            model: 'claude-opus-4-7'
          }
        }
      ])
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', sessionId, 'hello')

      const lastPersistCall = mockDb.replaceSessionMessages.mock.calls.at(-1)
      expect(lastPersistCall).toBeDefined()

      const persistedRows = lastPersistCall?.[1] as Array<{ opencode_message_json: string }>
      const persistedMessage = JSON.parse(persistedRows[0].opencode_message_json)
      expect(persistedMessage.usage.output_tokens).toBe(42)
      expect(persistedMessage.cost).toBe(0.395111)
    })
  })

  // ── getMessages() ───────────────────────────────────────────────────

  describe('getMessages()', () => {
    it('returns empty array (Session 5 stub)', async () => {
      await impl.connect('/proj', 'hive-1')
      const result = await impl.getMessages('/proj', 'any-session')
      expect(result).toEqual([])
    })
  })
})
