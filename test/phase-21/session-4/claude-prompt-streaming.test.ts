/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'

const {
  mockQuery,
  mockGenerateSessionTitle,
  mockCreateXfpClaudeMcpServerConfig,
  mockXfpMcpServer,
  mockBuildXfpFallbackContext,
  mockCreateXuanpuToolsMcpServerConfig,
  mockTokenSaverMcpServer,
  mockIsTokenSaverEnabled
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGenerateSessionTitle: vi.fn(),
  mockCreateXfpClaudeMcpServerConfig: vi.fn(),
  mockXfpMcpServer: { type: 'sdk', name: 'xuanpu-field', instance: {} },
  mockBuildXfpFallbackContext: vi.fn(),
  mockCreateXuanpuToolsMcpServerConfig: vi.fn(),
  mockTokenSaverMcpServer: { type: 'sdk', name: 'xuanpu', instance: {} },
  mockIsTokenSaverEnabled: vi.fn()
}))
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp')
  }
}))
vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn().mockResolvedValue({ query: mockQuery })
}))

vi.mock('../../../src/main/services/claude-session-title', () => ({
  generateSessionTitle: mockGenerateSessionTitle
}))

vi.mock('../../../src/main/xfp/claude-mcp-server', () => ({
  XFP_CLAUDE_MCP_SERVER_NAME: 'xuanpu-field',
  XFP_CLAUDE_ALLOWED_TOOLS: [
    'mcp__xuanpu-field__xfp_get_current_focus',
    'mcp__xuanpu-field__xfp_get_last_terminal_activity',
    'mcp__xuanpu-field__xfp_get_recent_activity',
    'mcp__xuanpu-field__xfp_get_worktree_summary',
    'mcp__xuanpu-field__xfp_get_pinned_facts'
  ],
  createXfpClaudeMcpServerConfig: mockCreateXfpClaudeMcpServerConfig
}))

vi.mock('../../../src/main/xfp/fallback-context', () => ({
  buildXfpFallbackContext: mockBuildXfpFallbackContext
}))

vi.mock('../../../src/main/xfp/provider', () => ({
  xfpProvider: { id: 'mock-xfp-provider' }
}))

vi.mock('../../../src/main/services/token-saver/xuanpu-tools-mcp', () => ({
  createXuanpuToolsMcpServerConfig: mockCreateXuanpuToolsMcpServerConfig
}))

vi.mock('../../../src/main/field/privacy', () => ({
  isTokenSaverEnabled: mockIsTokenSaverEnabled
}))

vi.mock('../../../src/main/services/claude-transcript-reader', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/main/services/claude-transcript-reader')
  >('../../../src/main/services/claude-transcript-reader')

  return {
    ...actual,
    readClaudeTranscript: vi.fn().mockResolvedValue([]),
    readClaudeGoalStatus: vi.fn().mockResolvedValue(null)
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
import { readClaudeGoalStatus } from '../../../src/main/services/claude-transcript-reader'
import { __resetXfpAuditForTest, listXfpAuditEvents } from '../../../src/main/xfp/audit'

const readClaudeTranscriptMock = vi.mocked(readClaudeTranscript)
const readClaudeGoalStatusMock = vi.mocked(readClaudeGoalStatus)

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
    __resetXfpAuditForTest()
    readClaudeTranscriptMock.mockResolvedValue([])
    readClaudeGoalStatusMock.mockResolvedValue(null)
    mockGenerateSessionTitle.mockResolvedValue(null)
    mockCreateXfpClaudeMcpServerConfig.mockResolvedValue(mockXfpMcpServer)
    mockBuildXfpFallbackContext.mockResolvedValue(null)
    mockCreateXuanpuToolsMcpServerConfig.mockResolvedValue(mockTokenSaverMcpServer)
    mockIsTokenSaverEnabled.mockReturnValue(false)
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

    it('sets Claude /goal before the real prompt and mirrors the Goal card state', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-goal')

      mockQuery
        .mockReturnValueOnce(
          createMockQueryIterator([
            {
              type: 'system',
              subtype: 'local_command_output',
              session_id: 'sdk-goal-1',
              content: 'Goal active'
            }
          ])
        )
        .mockReturnValueOnce(
          createMockQueryIterator([
            {
              type: 'assistant',
              session_id: 'sdk-goal-1',
              content: [{ type: 'text', text: 'Working on it.' }]
            }
          ])
        )

      await impl.prompt('/proj', sessionId, 'Review and fix the bug', undefined, {
        goalMode: true,
        goalObjective: 'Review and fix the bug\n\nSuccess criteria:\nFocused tests pass'
      })

      expect(mockQuery).toHaveBeenCalled()
      expect(mockQuery.mock.calls[0][0].prompt).toBe(
        '/goal Review and fix the bug | Success criteria: | Focused tests pass'
      )
      expect(mockQuery.mock.calls[1][0].prompt).toBe('Review and fix the bug')
      expect(mockQuery.mock.calls[1][0].options.resume).toBe('sdk-goal-1')

      const events = getStreamEvents(mockWindow)
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.goal_updated',
          sessionId: 'hive-goal',
          runtimeId: 'claude-code',
          data: expect.objectContaining({
            source: 'claude-code',
            status: 'active',
            goal: expect.objectContaining({
              objective: 'Review and fix the bug',
              successCriteria: 'Focused tests pass'
            })
          })
        })
      )
    })

    it('marks Claude goal completed from transcript goal_status attachments', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-goal-done')

      readClaudeGoalStatusMock.mockResolvedValueOnce(null).mockResolvedValueOnce({
        occurredAt: '2026-05-13T02:09:56.940Z',
        met: true,
        sentinel: false,
        condition: 'Review and fix the bug | Success criteria: | Focused tests pass',
        reason: 'The condition has been satisfied.'
      })

      mockQuery
        .mockReturnValueOnce(
          createMockQueryIterator([
            {
              type: 'system',
              subtype: 'local_command_output',
              session_id: 'sdk-goal-complete-1',
              content: 'Goal set: Review and fix the bug | Success criteria: | Focused tests pass'
            }
          ])
        )
        .mockReturnValueOnce(
          createMockQueryIterator([
            {
              type: 'assistant',
              session_id: 'sdk-goal-complete-1',
              content: [{ type: 'text', text: 'Done.' }]
            }
          ])
        )

      await impl.prompt('/proj', sessionId, 'Review and fix the bug', undefined, {
        goalMode: true,
        goalObjective: 'Review and fix the bug\n\nSuccess criteria:\nFocused tests pass'
      })

      const events = getStreamEvents(mockWindow)
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.goal_updated',
          sessionId: 'hive-goal-done',
          runtimeId: 'claude-code',
          data: expect.objectContaining({
            source: 'claude-code',
            status: 'completed',
            goal: expect.objectContaining({
              objective: 'Review and fix the bug',
              successCriteria: 'Focused tests pass',
              status: 'completed'
            })
          })
        })
      )
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

    it('attaches XFP field MCP tools to Claude session options', async () => {
      const mockDb = {
        getWorktreeByPath: vi.fn().mockReturnValue({
          id: 'wt-xfp',
          project_id: 'proj-xfp'
        }),
        getProject: vi.fn().mockReturnValue({ path: '/proj' }),
        updateSession: vi.fn(),
        getSession: vi.fn(),
        replaceSessionMessages: vi.fn()
      }
      impl.setDatabaseService(mockDb as any)
      const { sessionId } = await impl.connect('/proj', 'hive-xfp')

      mockQuery.mockReturnValue(
        createMockQueryIterator([
          {
            type: 'assistant',
            session_id: 'sdk-xfp-1',
            content: [{ type: 'text', text: 'Ready' }]
          }
        ])
      )

      await impl.prompt('/proj', sessionId, '这里为什么挂？')

      expect(mockCreateXfpClaudeMcpServerConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId: 'wt-xfp',
          sessionId: 'hive-xfp'
        })
      )
      const callArgs = mockQuery.mock.calls[0][0]
      expect(callArgs.options.mcpServers['xuanpu-field']).toBe(mockXfpMcpServer)
      expect(callArgs.options.allowedTools).toEqual(
        expect.arrayContaining([
          'mcp__xuanpu-field__xfp_get_current_focus',
          'mcp__xuanpu-field__xfp_get_last_terminal_activity',
          'mcp__xuanpu-field__xfp_get_recent_activity',
          'mcp__xuanpu-field__xfp_get_worktree_summary',
          'mcp__xuanpu-field__xfp_get_pinned_facts'
        ])
      )
    })

    it('keeps XFP MCP separate from Token Saver MCP when both are enabled', async () => {
      mockIsTokenSaverEnabled.mockReturnValue(true)
      const mockDb = {
        getWorktreeByPath: vi.fn().mockReturnValue({
          id: 'wt-xfp-token',
          project_id: 'proj-xfp-token'
        }),
        getProject: vi.fn().mockReturnValue({ path: '/proj' }),
        updateSession: vi.fn(),
        getSession: vi.fn(),
        replaceSessionMessages: vi.fn()
      }
      impl.setDatabaseService(mockDb as any)
      const { sessionId } = await impl.connect('/proj', 'hive-xfp-token')

      mockQuery.mockReturnValue(
        createMockQueryIterator([
          {
            type: 'assistant',
            session_id: 'sdk-xfp-token-1',
            content: [{ type: 'text', text: 'Ready' }]
          }
        ])
      )

      await impl.prompt('/proj', sessionId, '跑一下测试')

      const callArgs = mockQuery.mock.calls[0][0]
      expect(callArgs.options.mcpServers['xuanpu-field']).toBe(mockXfpMcpServer)
      expect(callArgs.options.mcpServers.xuanpu).toBe(mockTokenSaverMcpServer)
      expect(callArgs.options.allowedTools).toEqual(
        expect.arrayContaining([
          'mcp__xuanpu-field__xfp_get_current_focus',
          'mcp__xuanpu-field__xfp_get_last_terminal_activity',
          'mcp__xuanpu__bash'
        ])
      )
      expect(callArgs.options.disallowedTools).toEqual(expect.arrayContaining(['Bash']))
    })

    it('uses bounded XFP fallback when Claude field MCP attach fails', async () => {
      mockCreateXfpClaudeMcpServerConfig.mockRejectedValueOnce(new Error('mcp unavailable'))
      mockBuildXfpFallbackContext.mockResolvedValueOnce({
        markdown: '[Xuanpu Field Fallback]\n## Current Focus\n- File: /proj/src/main.ts',
        approxTokens: 24,
        reason: 'field-reference',
        included: ['current_focus']
      })
      const mockDb = {
        getWorktreeByPath: vi.fn().mockReturnValue({
          id: 'wt-fallback',
          project_id: 'proj-fallback'
        }),
        getProject: vi.fn().mockReturnValue({ path: '/proj' }),
        updateSession: vi.fn(),
        getSession: vi.fn(),
        replaceSessionMessages: vi.fn()
      }
      impl.setDatabaseService(mockDb as any)
      const { sessionId } = await impl.connect('/proj', 'hive-xfp-fallback')

      mockQuery.mockReturnValue(
        createMockQueryIterator([
          {
            type: 'assistant',
            session_id: 'sdk-xfp-fallback-1',
            content: [{ type: 'text', text: 'Ready' }]
          }
        ])
      )

      await impl.prompt('/proj', sessionId, '这里为什么挂？')

      expect(mockBuildXfpFallbackContext).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: { worktreeId: 'wt-fallback', sessionId: 'hive-xfp-fallback' },
          promptText: '这里为什么挂？'
        })
      )
      expect(mockQuery.mock.calls[0][0].prompt).toBe(
        '[Xuanpu Field Fallback]\n## Current Focus\n- File: /proj/src/main.ts\n\n[User Message]\n这里为什么挂？'
      )

      const state = sessions.get((impl as any).getSessionKey('/proj', 'sdk-xfp-fallback-1'))!
      const userMessage = state.messages.find((m) => (m as any).role === 'user') as any
      expect(userMessage.content).toBe('这里为什么挂？')
      expect(userMessage.parts[0].text).toBe('这里为什么挂？')
      expect(listXfpAuditEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            worktreeId: 'wt-fallback',
            sessionId: 'hive-xfp-fallback',
            runtimeId: 'claude-code',
            kind: 'fallback',
            toolName: 'xfp_triggered_fallback',
            input: { reason: 'field-reference', included: ['current_focus'] }
          }),
          expect.objectContaining({
            worktreeId: 'wt-fallback',
            sessionId: 'hive-xfp-fallback',
            runtimeId: 'claude-code',
            kind: 'prompt',
            toolName: 'field_delivery',
            input: expect.objectContaining({
              mode: 'xfp-fallback',
              hasXfpFallbackPrefix: true,
              hasFieldContextEnvelope: false
            })
          })
        ])
      )
    })

    it('sends injected runtime prompt but uses originalMessage for title and synthetic user message', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-field')
      const injected = '[Field Context]\nCurrent file: src/a.ts\n\n[User Message]\n真实消息'

      mockQuery.mockReturnValue(
        createMockQueryIterator([
          {
            type: 'assistant',
            session_id: 'sdk-field-1',
            content: [{ type: 'text', text: 'Done' }]
          }
        ])
      )

      await impl.prompt('/proj', sessionId, injected, undefined, {
        originalMessage: '真实消息'
      } as any)

      expect(mockQuery.mock.calls[0][0].prompt).toBe(injected)
      expect(mockGenerateSessionTitle).toHaveBeenCalledWith('真实消息', null)

      const state = sessions.get((impl as any).getSessionKey('/proj', 'sdk-field-1'))!
      const userMessage = state.messages.find((m) => (m as any).role === 'user') as any
      expect(userMessage.content).toBe('真实消息')
      expect(userMessage.parts[0].text).toBe('真实消息')
    })

    it('falls back to stripping Field Context from synthetic and persisted user content', async () => {
      const mockDb = {
        updateSession: vi.fn(),
        getSession: vi.fn(),
        replaceSessionMessages: vi.fn()
      }
      impl.setDatabaseService(mockDb as any)

      const { sessionId } = await impl.connect('/proj', 'hive-field-fallback')
      const injected = '[Field Context]\nCurrent file: src/a.ts\n\n[User Message]\nShip the fix'

      mockQuery.mockReturnValue(
        createMockQueryIterator([
          {
            type: 'assistant',
            session_id: 'sdk-field-fallback-1',
            content: [{ type: 'text', text: 'Done' }]
          },
          {
            type: 'user',
            session_id: 'sdk-field-fallback-1',
            uuid: 'user-field-echo-1',
            message: {
              role: 'user',
              content: [{ type: 'text', text: injected }]
            }
          }
        ])
      )

      await impl.prompt('/proj', sessionId, injected)

      const lastPersistCall = mockDb.replaceSessionMessages.mock.calls.at(-1)
      expect(lastPersistCall).toBeDefined()

      const rows = lastPersistCall?.[1] as Array<{
        role: string
        content: string
        opencode_message_json: string
        opencode_parts_json: string
      }>
      const userRow = rows.find((row) => row.role === 'user')!
      expect(userRow.content).toBe('Ship the fix')
      expect(userRow.content).not.toContain('[Field Context]')
      expect(userRow.opencode_message_json).not.toContain('[Field Context]')
      expect(userRow.opencode_parts_json).not.toContain('[Field Context]')
    })

    it('cleans only text parts for attachment prompts while preserving file parts', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-field-file')
      const injected = '[Field Context]\nCurrent file: src/a.ts\n\n[User Message]\n看这张图'
      const filePart = {
        type: 'file' as const,
        mime: 'image/png',
        url: 'data:image/png;base64,aGVsbG8=',
        filename: 'shot.png'
      }

      mockQuery.mockReturnValue(
        createMockQueryIterator([
          {
            type: 'assistant',
            session_id: 'sdk-field-file-1',
            content: [{ type: 'text', text: 'Done' }]
          }
        ])
      )

      await impl.prompt(
        '/proj',
        sessionId,
        [{ type: 'text', text: injected }, filePart],
        undefined,
        {
          originalMessage: [{ type: 'text', text: '看这张图' }, filePart]
        } as any
      )

      const promptIterable = mockQuery.mock.calls[0][0].prompt
      const yielded = await promptIterable[Symbol.asyncIterator]().next()
      expect(yielded.value.message.content[0]).toMatchObject({
        type: 'text',
        text: injected
      })
      expect(yielded.value.message.content[1]).toMatchObject({
        type: 'image'
      })

      const state = sessions.get((impl as any).getSessionKey('/proj', 'sdk-field-file-1'))!
      const userMessage = state.messages.find((m) => (m as any).role === 'user') as any
      expect(userMessage.content).toBe('看这张图\n[attachment: shot.png]')
      expect(userMessage.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: '看这张图' }),
          expect.objectContaining({ type: 'file', filename: 'shot.png' })
        ])
      )
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
