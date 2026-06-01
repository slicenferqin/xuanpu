/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Mock logger
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// Mock child_process
vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    spawn: vi.fn(),
    spawnSync: vi.fn()
  }
})

import {
  CodexAppServerManager,
  type CodexSessionContext,
  type CodexProviderSession
} from '../../../src/main/services/codex-app-server-manager'

// ── Helper: create a mock child process ─────────────────────────────

function createMockChild(): {
  child: any
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
} {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()

  const child = new EventEmitter() as any
  child.stdin = stdin
  child.stdout = stdout
  child.stderr = stderr
  child.pid = 12345
  child.killed = false
  child.kill = vi.fn(() => {
    child.killed = true
  })

  return { child, stdin, stdout, stderr }
}

// ── Helper: create a test session context ───────────────────────────

function createTestContext(overrides?: Partial<CodexProviderSession>): {
  context: CodexSessionContext
  child: any
  stdin: PassThrough
} {
  const { child, stdin } = createMockChild()

  const output = {
    on: vi.fn(),
    close: vi.fn(),
    removeAllListeners: vi.fn()
  } as any

  const session: CodexProviderSession = {
    provider: 'codex',
    status: 'running',
    threadId: 'thread-abort-1',
    cwd: '/test/project',
    model: 'gpt-5.4',
    activeTurnId: 'turn-active-1',
    resumeCursor: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  }

  const context: CodexSessionContext = {
    session,
    child,
    output,
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    nextRequestId: 1,
    stopping: false
  }

  return { context, child, stdin }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Codex Abort & getMessages', () => {
  let manager: CodexAppServerManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new CodexAppServerManager()
  })

  // ── interruptTurn ───────────────────────────────────────────────

  describe('interruptTurn', () => {
    it('sends turn/interrupt JSON-RPC request with threadId and turnId', async () => {
      const { context, child } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-abort-1', context)

      const writeSpy = vi.spyOn(child.stdin, 'write')

      // Resolve the sendRequest by simulating a response
      const interruptPromise = manager.interruptTurn('thread-abort-1', 'turn-99')
      // The manager's sendRequest writes the request and waits for response
      // Find the request ID and send a response
      const requestWritten = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())
      expect(requestWritten.method).toBe('turn/interrupt')
      expect(requestWritten.params.threadId).toBe('thread-abort-1')
      expect(requestWritten.params.turnId).toBe('turn-99')

      // Simulate response
      manager.handleStdoutLine(
        context,
        JSON.stringify({
          id: requestWritten.id,
          result: { ok: true }
        })
      )

      await interruptPromise
    })

    it('uses activeTurnId when no turnId is provided', async () => {
      const { context, child } = createTestContext({ activeTurnId: 'turn-active-1' })
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-abort-1', context)

      const writeSpy = vi.spyOn(child.stdin, 'write')

      const interruptPromise = manager.interruptTurn('thread-abort-1')
      const requestWritten = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())
      expect(requestWritten.params.turnId).toBe('turn-active-1')

      manager.handleStdoutLine(
        context,
        JSON.stringify({
          id: requestWritten.id,
          result: { ok: true }
        })
      )

      await interruptPromise
    })

    it('keeps session running until provider confirms interruption', async () => {
      const { context, child } = createTestContext({
        status: 'running',
        activeTurnId: 'turn-active-1'
      })
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-abort-1', context)

      const writeSpy = vi.spyOn(child.stdin, 'write')

      const interruptPromise = manager.interruptTurn('thread-abort-1')
      const requestWritten = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())

      manager.handleStdoutLine(
        context,
        JSON.stringify({
          id: requestWritten.id,
          result: { ok: true }
        })
      )

      await interruptPromise

      expect(context.session.status).toBe('running')
      expect(context.session.activeTurnId).toBe('turn-active-1')
    })

    it('does not synthesize turn/interrupted on interrupt acknowledgement', async () => {
      const { context, child } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-abort-1', context)

      const events: any[] = []
      manager.on('event', (event) => events.push(event))

      const writeSpy = vi.spyOn(child.stdin, 'write')

      const interruptPromise = manager.interruptTurn('thread-abort-1')
      const requestWritten = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())

      manager.handleStdoutLine(
        context,
        JSON.stringify({
          id: requestWritten.id,
          result: { ok: true }
        })
      )

      await interruptPromise

      const interruptEvent = events.find((e) => e.method === 'turn/interrupted')
      expect(interruptEvent).toBeUndefined()
    })

    it('throws when threadId is unknown', async () => {
      await expect(manager.interruptTurn('nonexistent')).rejects.toThrow('no session for threadId')
    })
  })

  // ── readThread ──────────────────────────────────────────────────

  describe('readThread', () => {
    it('sends thread/read JSON-RPC request with correct params', async () => {
      const { context, child } = createTestContext()
      const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
      sessionsMap.set('thread-abort-1', context)

      const writeSpy = vi.spyOn(child.stdin, 'write')

      const readPromise = manager.readThread('thread-abort-1')
      const requestWritten = JSON.parse((writeSpy.mock.calls[0][0] as string).trim())

      expect(requestWritten.method).toBe('thread/read')
      expect(requestWritten.params.threadId).toBe('thread-abort-1')
      expect(requestWritten.params.includeTurns).toBe(true)

      // Simulate response with thread snapshot
      manager.handleStdoutLine(
        context,
        JSON.stringify({
          id: requestWritten.id,
          result: {
            thread: {
              id: 'thread-abort-1',
              turns: [
                {
                  id: 'turn-1',
                  input: [{ type: 'text', text: 'Hello' }],
                  outputText: 'World',
                  createdAt: '2026-01-01T00:00:00Z',
                  updatedAt: '2026-01-01T00:00:01Z'
                }
              ]
            }
          }
        })
      )

      const result = await readPromise
      expect(result).toBeDefined()
      expect((result as any).thread.turns).toHaveLength(1)
    })

    it('throws when threadId is unknown', async () => {
      await expect(manager.readThread('nonexistent')).rejects.toThrow('no session for threadId')
    })
  })

  // ── CodexImplementer.abort ──────────────────────────────────────

  describe('CodexImplementer.abort', () => {
    it('calls manager.interruptTurn and updates status', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }
      impl.setMainWindow(mockWindow as any)

      const session = {
        threadId: 'thread-abort-1',
        hiveSessionId: 'hive-abort-1',
        worktreePath: '/test',
        status: 'running' as const,
        messages: [],
        liveAssistantDraft: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: false
      }
      impl.getSessions().set('/test::thread-abort-1', session)

      internalManager.interruptTurn = vi.fn().mockResolvedValue(undefined)

      const result = await impl.abort('/test', 'thread-abort-1')

      expect(result).toBe(true)
      expect(internalManager.interruptTurn).toHaveBeenCalledWith('thread-abort-1')
      expect(session.status).toBe('ready')
    })

    it('emits idle status to renderer', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }
      impl.setMainWindow(mockWindow as any)

      impl.getSessions().set('/test::thread-abort-1', {
        threadId: 'thread-abort-1',
        hiveSessionId: 'hive-abort-1',
        worktreePath: '/test',
        status: 'running',
        messages: [],
        liveAssistantDraft: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: false
      })

      internalManager.interruptTurn = vi.fn().mockResolvedValue(undefined)

      await impl.abort('/test', 'thread-abort-1')

      const sendCalls = mockWindow.webContents.send.mock.calls
      const streamCalls = sendCalls
        .filter((c: any[]) => c[0] === 'agent:stream')
        .map((c: any[]) => c[1])

      const statusEvent = streamCalls.find((e: any) => e.type === 'session.status')
      expect(statusEvent).toBeDefined()
      expect(statusEvent.statusPayload.type).toBe('idle')
    })

    it('returns false for unknown session', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()

      const result = await impl.abort('/unknown', 'thread-x')
      expect(result).toBe(false)
    })

    it('returns false if interruptTurn throws', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }
      impl.setMainWindow(mockWindow as any)

      impl.getSessions().set('/test::thread-abort-1', {
        threadId: 'thread-abort-1',
        hiveSessionId: 'hive-abort-1',
        worktreePath: '/test',
        status: 'running',
        messages: [],
        liveAssistantDraft: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: false
      })

      internalManager.interruptTurn = vi.fn().mockRejectedValue(new Error('Server not responding'))

      const result = await impl.abort('/test', 'thread-abort-1')
      expect(result).toBe(false)
    })

    it('keeps the live draft and active run until provider confirms abort', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }
      impl.setMainWindow(mockWindow as any)

      const session = {
        threadId: 'thread-abort-1',
        hiveSessionId: 'hive-abort-1',
        worktreePath: '/test',
        status: 'running' as const,
        messages: [],
        liveAssistantDraft: {
          id: 'codex-live-thread-abort-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          parts: [
            { type: 'text', text: 'Partial answer', timestamp: '2026-01-01T00:00:00.000Z' },
            {
              type: 'tool',
              callID: 'tool-1',
              tool: 'Bash',
              state: {
                status: 'running',
                input: { command: 'pnpm test' },
                output: 'running...'
              }
            }
          ],
          toolIndexById: new Map([['tool-1', 1]])
        },
        activeRun: {
          runId: 'run-abort-1',
          expectedTurnId: 'turn-live-1',
          state: 'running' as const,
          startedAt: Date.now(),
          abortController: new AbortController()
        },
        settledRunIds: new Set<string>(),
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: false,
        titleGenerationStarted: false
      }
      impl.getSessions().set('/test::thread-abort-1', session)

      internalManager.interruptTurn = vi.fn().mockResolvedValue(undefined)

      const result = await impl.abort('/test', 'thread-abort-1')

      expect(result).toBe(true)
      expect(internalManager.interruptTurn).toHaveBeenCalledWith('thread-abort-1', 'turn-live-1')
      expect(session.liveAssistantDraft).not.toBeNull()
      expect(session.activeRun?.state).toBe('aborting')
      expect(session.activeRun?.interruptRequestedTurnId).toBe('turn-live-1')
      expect(session.messages).toHaveLength(0)

      const messages = await impl.getMessages('/test', 'thread-abort-1')
      expect(messages).toHaveLength(1)
      expect((messages[0] as any).aborted).toBeUndefined()
      expect((messages[0] as any).parts[0].text).toBe('Partial answer')
    })
  })

  describe('CodexImplementer token usage hydration', () => {
    it('hydrates token_count events from current Codex JSONL payload records', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const tempDir = mkdtempSync(path.join(tmpdir(), 'codex-token-usage-'))
      const jsonlPath = path.join(tempDir, 'session.jsonl')
      writeFileSync(
        jsonlPath,
        `${JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 1000,
                cached_input_tokens: 800,
                output_tokens: 50,
                reasoning_output_tokens: 10,
                total_tokens: 1050
              },
              last_token_usage: {
                input_tokens: 300,
                cached_input_tokens: 200,
                output_tokens: 50,
                reasoning_output_tokens: 10,
                total_tokens: 350
              },
              model_context_window: 2000
            }
          }
        })}\n`
      )

      try {
        const impl = new CodexImplementer()
        const internalManager = impl.getManager() as any
        const mockWindow = {
          isDestroyed: () => false,
          webContents: { send: vi.fn() }
        }
        impl.setMainWindow(mockWindow as any)
        internalManager.readThread = vi.fn().mockResolvedValue({
          thread: {
            id: 'thread-token-1',
            path: jsonlPath
          }
        })

        await (impl as any).hydrateTokenUsageFromThread({
          threadId: 'thread-token-1',
          hiveSessionId: 'hive-token-1'
        })

        const event = mockWindow.webContents.send.mock.calls
          .map((call: any[]) => call[1])
          .find((item: any) => item.type === 'session.context_usage')

        expect(event).toBeDefined()
        expect(event.sessionId).toBe('hive-token-1')
        expect(event.data.tokens).toEqual({
          input: 100,
          cacheRead: 200,
          cacheWrite: 0,
          output: 50,
          reasoning: 10
        })
        expect(event.data.breakdown.usedTokens).toBe(300)
        expect(event.data.contextWindow).toBe(2000)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })
  })

  // ── CodexImplementer.getMessages ────────────────────────────────

  describe('CodexImplementer.getMessages', () => {
    it('returns in-memory messages first', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()

      const session = {
        threadId: 'thread-msg-1',
        hiveSessionId: 'hive-msg-1',
        worktreePath: '/test',
        status: 'ready' as const,
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }
        ],
        liveAssistantDraft: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: false
      }
      impl.getSessions().set('/test::thread-msg-1', session)

      const messages = await impl.getMessages('/test', 'thread-msg-1')
      expect(messages).toHaveLength(2)
      expect((messages[0] as any).role).toBe('user')
      expect((messages[1] as any).role).toBe('assistant')
    })

    it('falls back to readThread when in-memory is empty', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      impl.getSessions().set('/test::thread-msg-1', {
        threadId: 'thread-msg-1',
        hiveSessionId: 'hive-msg-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        liveAssistantDraft: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: false
      })

      // Mock readThread to return a thread snapshot
      internalManager.readThread = vi.fn().mockResolvedValue({
        thread: {
          id: 'thread-msg-1',
          turns: [
            {
              id: 'turn-1',
              input: [{ type: 'text', text: 'User question' }],
              outputText: 'Assistant answer',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:01Z'
            }
          ]
        }
      })

      const messages = await impl.getMessages('/test', 'thread-msg-1')

      expect(internalManager.readThread).toHaveBeenCalledWith('thread-msg-1')
      expect(messages).toHaveLength(2)
      expect((messages[0] as any).role).toBe('user')
      expect((messages[0] as any).parts[0].text).toBe('User question')
      expect((messages[1] as any).role).toBe('assistant')
      expect((messages[1] as any).parts[0].text).toBe('Assistant answer')
    })

    it('does not treat persisted user-only Codex rows as a complete transcript', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      impl.getSessions().set('/test::thread-msg-1', {
        threadId: 'thread-msg-1',
        hiveSessionId: 'hive-msg-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        liveAssistantDraft: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: false
      })

      const replaceSessionMessages = vi.fn()
      impl.setDatabaseService({
        getSessionMessages: vi.fn().mockReturnValue([
          {
            id: 'db-user-1',
            session_id: 'hive-msg-1',
            role: 'user',
            content: 'Persisted question',
            opencode_message_id: 'turn-1:user',
            opencode_message_json: JSON.stringify({
              id: 'turn-1:user',
              role: 'user',
              parts: [{ type: 'text', text: 'Persisted question' }],
              timestamp: '2026-01-01T00:00:00.000Z'
            }),
            opencode_parts_json: null,
            opencode_timeline_json: null,
            created_at: '2026-01-01T00:00:00.000Z'
          }
        ]),
        replaceSessionMessages
      } as any)

      internalManager.readThread = vi.fn().mockResolvedValue({
        thread: {
          id: 'thread-msg-1',
          turns: [
            {
              id: 'turn-1',
              items: [
                {
                  type: 'userMessage',
                  id: 'user-1',
                  content: [{ type: 'text', text: 'Persisted question' }]
                },
                {
                  type: 'agentMessage',
                  id: 'assistant-1',
                  text: 'Recovered assistant answer'
                }
              ],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:02.000Z'
            }
          ]
        }
      })

      const messages = await impl.getMessages('/test', 'thread-msg-1')

      expect(internalManager.readThread).toHaveBeenCalledWith('thread-msg-1')
      expect(messages).toHaveLength(2)
      expect((messages[1] as any).role).toBe('assistant')
      expect((messages[1] as any).parts[0].text).toBe('Recovered assistant answer')
      expect(replaceSessionMessages).toHaveBeenCalled()
    })

    it('warms in-memory cache from readThread result', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      const session = {
        threadId: 'thread-msg-1',
        hiveSessionId: 'hive-msg-1',
        worktreePath: '/test',
        status: 'ready' as const,
        messages: [] as unknown[],
        liveAssistantDraft: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: false
      }
      impl.getSessions().set('/test::thread-msg-1', session)

      internalManager.readThread = vi.fn().mockResolvedValue({
        thread: {
          id: 'thread-msg-1',
          turns: [
            {
              id: 'turn-1',
              input: [{ type: 'text', text: 'Hello' }],
              outputText: 'World',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:01Z'
            }
          ]
        }
      })

      await impl.getMessages('/test', 'thread-msg-1')

      // The in-memory cache should now be warmed
      expect(session.messages.length).toBe(2)
    })

    it('does not call readThread when session is closed', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      impl.getSessions().set('/test::thread-msg-1', {
        threadId: 'thread-msg-1',
        hiveSessionId: 'hive-msg-1',
        worktreePath: '/test',
        status: 'closed',
        messages: [],
        liveAssistantDraft: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: false
      })

      internalManager.readThread = vi.fn()

      const messages = await impl.getMessages('/test', 'thread-msg-1')

      expect(internalManager.readThread).not.toHaveBeenCalled()
      expect(messages).toEqual([])
    })

    it('recovers a persisted Codex session when no in-memory session exists', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      impl.setDatabaseService({
        getSessionByOpenCodeSessionId: vi.fn().mockReturnValue({
          id: 'hive-msg-1',
          opencode_session_id: 'thread-msg-1',
          agent_sdk: 'codex',
          model_id: null
        })
      } as any)

      internalManager.startSession = vi.fn().mockResolvedValue({
        threadId: 'thread-msg-1',
        status: 'ready'
      })
      internalManager.readThread = vi.fn().mockResolvedValue({
        thread: {
          id: 'thread-msg-1',
          turns: [
            {
              id: 'turn-1',
              items: [
                {
                  type: 'userMessage',
                  id: 'user-1',
                  content: [{ type: 'text', text: 'Recovered question' }]
                },
                {
                  type: 'agentMessage',
                  id: 'assistant-1',
                  text: 'Recovered answer'
                }
              ],
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:01Z'
            }
          ]
        }
      })

      const messages = await impl.getMessages('/test', 'thread-msg-1')

      expect(internalManager.startSession).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/test',
          model: impl.getSelectedModel(),
          resumeThreadId: 'thread-msg-1'
        })
      )
      expect(internalManager.readThread).toHaveBeenCalledWith('thread-msg-1')
      expect(messages).toHaveLength(2)
      expect((messages[0] as any).parts[0].text).toBe('Recovered question')
      expect((messages[1] as any).parts[0].text).toBe('Recovered answer')
      expect(impl.getSessions().get('/test::thread-msg-1')).toMatchObject({
        hiveSessionId: 'hive-msg-1',
        threadId: 'thread-msg-1',
        worktreePath: '/test'
      })
    })

    it('returns empty array for unknown session', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()

      const messages = await impl.getMessages('/unknown', 'thread-x')
      expect(messages).toEqual([])
    })

    it('returns empty array when readThread fails', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      impl.getSessions().set('/test::thread-msg-1', {
        threadId: 'thread-msg-1',
        hiveSessionId: 'hive-msg-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        liveAssistantDraft: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: false
      })

      internalManager.readThread = vi.fn().mockRejectedValue(new Error('Server unavailable'))

      const messages = await impl.getMessages('/test', 'thread-msg-1')
      expect(messages).toEqual([])
    })

    it('parses thread snapshot with output array (no outputText)', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      impl.getSessions().set('/test::thread-msg-1', {
        threadId: 'thread-msg-1',
        hiveSessionId: 'hive-msg-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        liveAssistantDraft: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: false
      })

      internalManager.readThread = vi.fn().mockResolvedValue({
        thread: {
          id: 'thread-msg-1',
          turns: [
            {
              id: 'turn-1',
              input: [{ type: 'text', text: 'Hello' }],
              output: [{ type: 'text', text: 'Hi there' }],
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:01Z'
            }
          ]
        }
      })

      const messages = await impl.getMessages('/test', 'thread-msg-1')

      expect(messages).toHaveLength(2)
      expect((messages[1] as any).role).toBe('assistant')
      expect((messages[1] as any).parts[0].text).toBe('Hi there')
    })

    it('parses real Codex thread/read turns with items arrays', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      impl.getSessions().set('/test::thread-msg-1', {
        threadId: 'thread-msg-1',
        hiveSessionId: 'hive-msg-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        liveAssistantDraft: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: false
      })

      internalManager.readThread = vi.fn().mockResolvedValue({
        thread: {
          id: 'thread-msg-1',
          turns: [
            {
              id: 'turn-1',
              items: [
                {
                  type: 'userMessage',
                  id: 'user-1',
                  content: [{ type: 'text', text: 'Saved user message' }]
                },
                {
                  type: 'agentMessage',
                  id: 'assistant-1',
                  text: 'Saved assistant reply'
                }
              ]
            }
          ]
        }
      })

      const messages = await impl.getMessages('/test', 'thread-msg-1')

      expect(messages).toHaveLength(2)
      expect((messages[0] as any).id).toBe('turn-1:user')
      expect((messages[0] as any).role).toBe('user')
      expect((messages[0] as any).parts[0].text).toBe('Saved user message')
      expect((messages[1] as any).id).toBe('turn-1:assistant')
      expect((messages[1] as any).role).toBe('assistant')
      expect((messages[1] as any).parts[0].text).toBe('Saved assistant reply')
    })

    it('supplements Codex final answers from JSONL when thread/read omits them', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      const tmp = mkdtempSync(path.join(tmpdir(), 'xuanpu-codex-jsonl-'))
      const jsonlPath = path.join(tmp, 'rollout.jsonl')

      try {
        writeFileSync(
          jsonlPath,
          [
            JSON.stringify({
              timestamp: '2026-01-01T00:00:00.000Z',
              type: 'event_msg',
              payload: {
                type: 'task_started',
                turn_id: 'turn-1'
              }
            }),
            JSON.stringify({
              timestamp: '2026-01-01T00:00:02.000Z',
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'assistant',
                phase: 'commentary',
                content: [{ type: 'output_text', text: 'Working...' }]
              }
            }),
            JSON.stringify({
              timestamp: '2026-01-01T00:00:03.000Z',
              type: 'event_msg',
              payload: {
                type: 'agent_message',
                phase: 'final_answer',
                message: 'Final answer shown to the user.',
                memory_citation: {
                  entries: [{ path: 'MEMORY.md', lineStart: 1, lineEnd: 1, note: 'hidden' }]
                }
              }
            }),
            JSON.stringify({
              timestamp: '2026-01-01T00:00:03.001Z',
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'assistant',
                phase: 'final_answer',
                content: [
                  {
                    type: 'output_text',
                    text: 'Final answer shown to the user.\\n<oai-mem-citation>hidden</oai-mem-citation>'
                  }
                ]
              }
            })
          ].join('\n')
        )

        impl.getSessions().set('/test::thread-msg-1', {
          threadId: 'thread-msg-1',
          hiveSessionId: 'hive-msg-1',
          worktreePath: '/test',
          status: 'ready',
          messages: [],
          liveAssistantDraft: null,
          revertMessageID: null,
          revertDiff: null,
          titleGenerated: false
        })

        internalManager.readThread = vi.fn().mockResolvedValue({
          thread: {
            id: 'thread-msg-1',
            path: jsonlPath,
            turns: [
              {
                id: 'turn-1',
                items: [
                  {
                    type: 'userMessage',
                    id: 'user-1',
                    content: [{ type: 'text', text: 'Saved user message' }]
                  },
                  {
                    type: 'agentMessage',
                    id: 'assistant-1',
                    text: 'Working...'
                  }
                ]
              }
            ]
          }
        })

        const messages = await impl.getMessages('/test', 'thread-msg-1')

        expect(messages.map((message: any) => message.parts?.[0]?.text)).toEqual([
          'Saved user message',
          'Working...',
          'Final answer shown to the user.'
        ])
        expect(JSON.stringify(messages)).not.toContain('<oai-mem-citation>')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    })

    it('persists Codex JSONL tool calls as durable timeline activities', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any
      const tmp = mkdtempSync(path.join(tmpdir(), 'xuanpu-codex-jsonl-'))
      const jsonlPath = path.join(tmp, 'rollout.jsonl')
      const activities: any[] = []

      impl.setDatabaseService({
        getSessionMessages: vi.fn(() => []),
        replaceSessionMessages: vi.fn(),
        upsertSessionActivity: vi.fn((activity: any) => {
          activities.push(activity)
          return activity
        })
      } as any)

      try {
        writeFileSync(
          jsonlPath,
          [
            JSON.stringify({
              timestamp: '2026-01-01T00:00:00.000Z',
              type: 'turn_context',
              payload: { turn_id: 'turn-1' }
            }),
            JSON.stringify({
              timestamp: '2026-01-01T00:00:00.100Z',
              type: 'event_msg',
              payload: {
                type: 'task_started',
                turn_id: 'turn-1'
              }
            }),
            JSON.stringify({
              timestamp: '2026-01-01T00:00:01.000Z',
              type: 'response_item',
              payload: {
                type: 'function_call',
                name: 'shell_command',
                call_id: 'call-shell',
                arguments: JSON.stringify({
                  command: 'pnpm test',
                  workdir: '/repo'
                })
              }
            }),
            JSON.stringify({
              timestamp: '2026-01-01T00:00:03.000Z',
              type: 'response_item',
              payload: {
                type: 'function_call_output',
                call_id: 'call-shell',
                output: 'Exit code: 0\nWall time: 1.5 seconds\nOutput:\nok\n'
              }
            }),
            JSON.stringify({
              timestamp: '2026-01-01T00:00:04.000Z',
              type: 'response_item',
              payload: {
                type: 'custom_tool_call',
                name: 'apply_patch',
                call_id: 'call-patch',
                input:
                  '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch\n'
              }
            }),
            JSON.stringify({
              timestamp: '2026-01-01T00:00:05.000Z',
              type: 'response_item',
              payload: {
                type: 'custom_tool_call_output',
                call_id: 'call-patch',
                output: 'Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess.\n'
              }
            }),
            JSON.stringify({
              timestamp: '2026-01-01T00:00:06.000Z',
              type: 'event_msg',
              payload: {
                type: 'agent_message',
                phase: 'final_answer',
                message: 'Done.'
              }
            })
          ].join('\n')
        )

        impl.getSessions().set('/test::thread-msg-1', {
          threadId: 'thread-msg-1',
          hiveSessionId: 'hive-msg-1',
          worktreePath: '/test',
          status: 'ready',
          messages: [],
          liveAssistantDraft: null,
          revertMessageID: null,
          revertDiff: null,
          titleGenerated: false
        })

        internalManager.readThread = vi.fn().mockResolvedValue({
          thread: {
            id: 'thread-msg-1',
            path: jsonlPath,
            turns: [
              {
                id: 'turn-1',
                items: [
                  {
                    type: 'userMessage',
                    id: 'user-1',
                    content: [{ type: 'text', text: 'Run tests and edit file' }]
                  }
                ]
              }
            ]
          }
        })

        const messages = await impl.getMessages('/test', 'thread-msg-1')

        expect(messages.map((message: any) => message.parts?.[0]?.text)).toContain('Done.')

        const shellActivity = activities.find((activity) => activity.item_id === 'call-shell')
        const patchActivity = activities.find((activity) => activity.item_id === 'call-patch')
        const markerActivity = activities.find((activity) =>
          String(activity.id).startsWith('codex-jsonl-recovery:')
        )

        expect(shellActivity?.kind).toBe('tool.completed')
        expect(shellActivity?.turn_id).toBe('turn-1')
        expect(JSON.parse(shellActivity.payload_json).item).toMatchObject({
          type: 'commandExecution',
          command: 'pnpm test',
          cwd: '/repo',
          aggregatedOutput: expect.stringContaining('ok'),
          durationMs: 1500
        })

        expect(patchActivity?.kind).toBe('tool.completed')
        expect(JSON.parse(patchActivity.payload_json).item).toMatchObject({
          type: 'fileChange',
          changes: [
            {
              path: 'src/app.ts',
              kind: { type: 'update' },
              diff: expect.stringContaining('+new')
            }
          ]
        })
        expect(JSON.parse(markerActivity.payload_json)).toMatchObject({
          kind: 'codex_jsonl_recovery',
          toolActivityCount: 2
        })
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    })

    it('returns recovered Codex messages in chronological order', async () => {
      const { CodexImplementer } = await import('../../../src/main/services/codex-implementer')
      const impl = new CodexImplementer()
      const internalManager = impl.getManager() as any

      impl.getSessions().set('/test::thread-msg-1', {
        threadId: 'thread-msg-1',
        hiveSessionId: 'hive-msg-1',
        worktreePath: '/test',
        status: 'ready',
        messages: [],
        liveAssistantDraft: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: false
      })

      internalManager.readThread = vi.fn().mockResolvedValue({
        thread: {
          id: 'thread-msg-1',
          turns: [
            {
              id: 'turn-2',
              items: [
                {
                  type: 'userMessage',
                  id: 'user-2',
                  content: [{ type: 'text', text: 'Second question' }]
                },
                {
                  type: 'agentMessage',
                  id: 'assistant-2',
                  text: 'Second answer'
                }
              ],
              createdAt: '2026-01-01T00:01:00Z',
              updatedAt: '2026-01-01T00:01:10Z'
            },
            {
              id: 'turn-1',
              items: [
                {
                  type: 'userMessage',
                  id: 'user-1',
                  content: [{ type: 'text', text: 'First question' }]
                },
                {
                  type: 'agentMessage',
                  id: 'assistant-1',
                  text: 'First answer'
                }
              ],
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:10Z'
            }
          ]
        }
      })

      const messages = await impl.getMessages('/test', 'thread-msg-1')

      expect(messages.map((message: any) => message.parts[0].text)).toEqual([
        'First question',
        'First answer',
        'Second question',
        'Second answer'
      ])
    })
  })
})
