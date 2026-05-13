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

vi.mock('../../../src/main/services/claude-project-memory-loader', () => ({
  maybeWithClaudeProjectMemory: vi.fn(async (options: unknown) => options)
}))

vi.mock('../../../src/main/field/privacy', () => ({
  isTokenSaverEnabled: vi.fn(() => false)
}))

vi.mock('../../../src/main/services/claude-transcript-reader', () => ({
  readClaudeTranscript: vi.fn().mockResolvedValue([]),
  readClaudeGoalStatus: vi.fn().mockResolvedValue(null),
  translateEntry: vi.fn().mockImplementation(
    (
      entry: {
        type: string
        uuid?: string
        content?: Array<{ type: string; text?: string }>
        message?: { content?: Array<{ type: string; text?: string }> | string }
      },
      index: number
    ) => {
      if (entry.type !== 'user' && entry.type !== 'assistant') return null
      const contentBlocks = Array.isArray(entry.message?.content)
        ? entry.message.content
        : Array.isArray(entry.content)
          ? entry.content
          : []
      const content = contentBlocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')

      return {
        id: entry.uuid ?? `entry-${index}`,
        role: entry.type,
        timestamp: new Date().toISOString(),
        content,
        parts: content
          ? [
              {
                type: 'text',
                text: content
              }
            ]
          : []
      }
    }
  )
}))

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

function createMockWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

function createMockQueryIterator(
  messages: Array<Record<string, unknown>>,
  extras?: { rewindFiles?: ReturnType<typeof vi.fn> }
) {
  let index = 0
  const iterator = {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    rewindFiles: extras?.rewindFiles ?? vi.fn(),
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

describe('ClaudeCodeImplementer - undo/redo/getSessionInfo (Session 8)', () => {
  let impl: ClaudeCodeImplementer
  let sessions: Map<string, ClaudeSessionState>

  beforeEach(() => {
    vi.clearAllMocks()
    mockQuery.mockReset()
    impl = new ClaudeCodeImplementer()
    sessions = (impl as any).sessions
    impl.setMainWindow(createMockWindow())
  })

  function getSessionKey(agentSessionId: string): string {
    return (impl as any).getSessionKey('/proj', agentSessionId)
  }

  async function seedMaterializedSession(opts?: {
    sessionId?: string
    hiveSessionId?: string
    checkpoints?: Array<{ uuid: string; prompt: string }>
  }): Promise<{ session: ClaudeSessionState; sessionId: string }> {
    const sdkSessionId = opts?.sessionId ?? 'sdk-session-1'
    const hiveSessionId = opts?.hiveSessionId ?? 'hive-1'
    const checkpoints = opts?.checkpoints ?? [
      { uuid: 'uuid-1', prompt: 'prompt one' },
      { uuid: 'uuid-2', prompt: 'prompt two' }
    ]

    const { sessionId: pendingId } = await impl.connect('/proj', hiveSessionId)
    const pendingKey = getSessionKey(pendingId)
    const session = sessions.get(pendingKey)!
    sessions.delete(pendingKey)

    session.claudeSessionId = sdkSessionId
    session.materialized = true
    session.messages = []
    session.checkpoints = new Map()
    session.checkpointCounter = 0
    session.query = null
    session.lastQuery = null
    session.pendingFork = false
    session.pendingResumeSessionAt = null
    session.revertMessageID = null
    session.revertCheckpointUuid = null
    session.revertDiff = null

    checkpoints.forEach(({ uuid, prompt }, index) => {
      const assistantId = `assistant-${index + 1}`
      session.messages.push({
        id: assistantId,
        role: 'assistant',
        timestamp: new Date().toISOString(),
        content: `Response ${index + 1}`,
        parts: [{ type: 'text', text: `Response ${index + 1}` }]
      })
      session.messages.push({
        id: uuid,
        role: 'user',
        timestamp: new Date().toISOString(),
        content: prompt,
        parts: [{ type: 'text', text: prompt }]
      })
      session.checkpointCounter += 1
      session.checkpoints.set(uuid, session.checkpointCounter)
    })

    sessions.set(getSessionKey(sdkSessionId), session)

    return { session, sessionId: sdkSessionId }
  }

  describe('prompt()', () => {
    it('passes file-checkpointing options into sdk.query', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')
      const iter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-real-1',
          content: [{ type: 'text', text: 'Hello' }]
        }
      ])
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', sessionId, 'test')

      expect(mockQuery).toHaveBeenCalled()
      const callArgs = mockQuery.mock.calls.find((call) => call[0]?.prompt === 'test')?.[0]
      expect(callArgs).toBeDefined()
      expect(callArgs.options.enableFileCheckpointing).toBe(true)
      expect(callArgs.options.extraArgs).toEqual({ 'replay-user-messages': null })
      expect(callArgs.options.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe('1')
    })

    it('captures checkpoints only from main-thread user messages', async () => {
      const { sessionId } = await impl.connect('/proj', 'hive-1')
      const iter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-real-2',
          content: [{ type: 'text', text: 'Ready' }]
        },
        {
          type: 'user',
          session_id: 'sdk-real-2',
          uuid: 'main-user-1',
          content: [{ type: 'text', text: 'main one' }]
        },
        {
          type: 'user',
          session_id: 'sdk-real-2',
          uuid: 'subagent-user-1',
          parent_tool_use_id: 'tool-123',
          content: [{ type: 'text', text: 'subagent one' }]
        },
        {
          type: 'user',
          session_id: 'sdk-real-2',
          uuid: 'main-user-2',
          content: [{ type: 'text', text: 'main two' }]
        }
      ])
      mockQuery.mockReturnValue(iter)

      await impl.prompt('/proj', sessionId, 'initial prompt')

      const session = sessions.get(getSessionKey('sdk-real-2'))!
      expect(session.checkpoints.has('main-user-1')).toBe(true)
      expect(session.checkpoints.has('main-user-2')).toBe(true)
      expect(session.checkpoints.has('subagent-user-1')).toBe(false)
      expect(session.checkpoints.size).toBe(2)
    })
  })

  describe('undo()', () => {
    it('throws when the session is missing', async () => {
      await expect(impl.undo('/proj', 'missing-session', 'hive-1')).rejects.toThrow(
        /session not found/i
      )
    })

    it('throws "Nothing to undo" when no checkpoints exist', async () => {
      const { sessionId } = await seedMaterializedSession({ checkpoints: [] })

      await expect(impl.undo('/proj', sessionId, 'hive-1')).rejects.toThrow('Nothing to undo')
    })

    it('rewinds the latest checkpoint and updates getSessionInfo()', async () => {
      const { session, sessionId } = await seedMaterializedSession()
      const rewindFilesMock = vi.fn().mockResolvedValue({
        canRewind: true,
        filesChanged: ['src/a.ts'],
        insertions: 2,
        deletions: 1
      })
      mockQuery.mockReturnValue(
        createMockQueryIterator(
          [
            {
              type: 'system',
              subtype: 'init',
              session_id: sessionId
            }
          ],
          { rewindFiles: rewindFilesMock }
        )
      )

      const result = await impl.undo('/proj', sessionId, 'hive-1')
      const info = await impl.getSessionInfo('/proj', sessionId)

      expect(rewindFilesMock).toHaveBeenCalledWith('uuid-2')
      expect(result.revertMessageID).toBe('uuid-2')
      expect(result.restoredPrompt).toBe('prompt two')
      expect(result.revertDiff).toContain('1 file(s) changed')
      expect(info).toEqual({
        revertMessageID: 'uuid-2',
        revertDiff: result.revertDiff
      })
      expect(session.pendingFork).toBe(true)
      expect(session.pendingResumeSessionAt).toBe('assistant-2')
    })

    it('falls back to conversation-only undo when file checkpoints are unavailable', async () => {
      const { session, sessionId } = await seedMaterializedSession()
      const rewindFilesMock = vi
        .fn()
        .mockRejectedValue(new Error('No file checkpoint found for this message.'))
      mockQuery.mockReturnValue(
        createMockQueryIterator(
          [
            {
              type: 'system',
              subtype: 'init',
              session_id: sessionId
            }
          ],
          { rewindFiles: rewindFilesMock }
        )
      )

      const result = await impl.undo('/proj', sessionId, 'hive-1')

      expect(result.revertMessageID).toBe('uuid-2')
      expect(result.revertDiff).toBeNull()
      expect(session.pendingFork).toBe(true)
      expect(session.pendingResumeSessionAt).toBe('assistant-2')
    })

    it('de-materializes the session when undoing the only checkpoint', async () => {
      const { session, sessionId } = await seedMaterializedSession({
        checkpoints: [{ uuid: 'uuid-only', prompt: 'only prompt' }]
      })
      const rewindFilesMock = vi.fn().mockResolvedValue({ canRewind: true })
      mockQuery.mockReturnValue(
        createMockQueryIterator(
          [
            {
              type: 'system',
              subtype: 'init',
              session_id: sessionId
            }
          ],
          { rewindFiles: rewindFilesMock }
        )
      )

      const result = await impl.undo('/proj', sessionId, 'hive-1')

      expect(rewindFilesMock).toHaveBeenCalledWith('uuid-only')
      expect(result.revertMessageID).toBe('uuid-only')
      expect(session.materialized).toBe(false)
      expect(session.pendingFork).toBe(false)
      expect(session.pendingResumeSessionAt).toBeNull()
    })

    it('uses forkSession on the next prompt after undo and clears pendingFork', async () => {
      await seedMaterializedSession()

      const rewindFilesMock = vi.fn().mockResolvedValue({ canRewind: true })
      const rewindIter = createMockQueryIterator(
        [
          {
            type: 'system',
            subtype: 'init',
            session_id: 'sdk-session-1'
          }
        ],
        { rewindFiles: rewindFilesMock }
      )
      const forkIter = createMockQueryIterator([
        {
          type: 'assistant',
          session_id: 'sdk-session-forked',
          content: [{ type: 'text', text: 'Forked response' }]
        }
      ])
      mockQuery.mockReturnValueOnce(rewindIter).mockReturnValueOnce(forkIter)

      await impl.undo('/proj', 'sdk-session-1', 'hive-1')
      await impl.prompt('/proj', 'sdk-session-1', 'after undo')

      const forkCallArgs = mockQuery.mock.calls[1][0]
      expect(forkCallArgs.options.forkSession).toBe(true)
      expect(forkCallArgs.options.resume).toBe('sdk-session-1')
      expect(forkCallArgs.options.resumeSessionAt).toBe('assistant-2')

      const forkedSession = sessions.get(getSessionKey('sdk-session-forked'))!
      expect(forkedSession.pendingFork).toBe(false)
      expect(forkedSession.pendingResumeSessionAt).toBeNull()
    })
  })

  describe('redo() and getSessionInfo()', () => {
    it('throws the Claude-specific redo unsupported error', async () => {
      await expect(impl.redo('/proj', 'sdk-session-1', 'hive-1')).rejects.toThrow(
        'Redo is not supported for Claude Code sessions'
      )
    })

    it('returns null revert state for unknown sessions', async () => {
      const info = await impl.getSessionInfo('/proj', 'unknown-session')
      expect(info).toEqual({
        revertMessageID: null,
        revertDiff: null
      })
    })
  })
})
