/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock logger
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// Track event listeners registered on the mock manager
let eventListeners: Array<(event: any) => void> = []

// Mock the CodexAppServerManager
vi.mock('../../../src/main/services/codex-app-server-manager', () => {
  const MockManager = vi.fn().mockImplementation(() => ({
    startSession: vi.fn(),
    stopSession: vi.fn(),
    stopAll: vi.fn(),
    hasSession: vi.fn().mockReturnValue(false),
    getSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    sendTurn: vi.fn(),
    on: vi.fn().mockImplementation((_event: string, handler: any) => {
      eventListeners.push(handler)
    }),
    emit: vi.fn(),
    removeListener: vi.fn().mockImplementation((_event: string, handler: any) => {
      eventListeners = eventListeners.filter((h) => h !== handler)
    }),
    removeAllListeners: vi.fn()
  }))
  return {
    CodexAppServerManager: MockManager
  }
})

import { CodexImplementer, type CodexSessionState } from '../../../src/main/services/codex-implementer'

describe('CodexImplementer.prompt()', () => {
  let impl: CodexImplementer
  let mockManager: any
  let mockWindow: any

  beforeEach(() => {
    vi.clearAllMocks()
    eventListeners = []
    impl = new CodexImplementer()
    mockManager = impl.getManager()
    mockWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    }
    impl.setMainWindow(mockWindow)
  })

  function seedSession(overrides?: Partial<CodexSessionState>): CodexSessionState {
    const session: CodexSessionState = {
      threadId: 'thread-1',
      hiveSessionId: 'hive-session-1',
      worktreePath: '/test/project',
      status: 'ready',
      messages: [],
      ...overrides
    }
    impl.getSessions().set('/test/project::thread-1', session)
    return session
  }

  function simulateManagerEvents(events: any[]) {
    // sendTurn resolves immediately, then we fire events asynchronously
    mockManager.sendTurn.mockImplementation(async () => {
      // Schedule events to fire after the sendTurn resolves
      setTimeout(() => {
        for (const event of events) {
          for (const listener of [...eventListeners]) {
            listener(event)
          }
        }
      }, 5)
      return { turnId: 'turn-1', threadId: 'thread-1' }
    })
  }

  // ── Basic prompt flow ───────────────────────────────────────

  it('calls sendTurn with extracted text', async () => {
    seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'Hello Codex')

    expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
      text: 'Hello Codex',
      model: expect.any(String),
      interactionMode: 'default'
    })
  })

  it('extracts text from parts array', async () => {
    seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', [
      { type: 'text', text: 'Part 1' },
      { type: 'text', text: 'Part 2' }
    ])

    expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
      text: 'Part 1\nPart 2',
      model: expect.any(String),
      interactionMode: 'default'
    })
  })

  // ── Status transitions ──────────────────────────────────────

  it('emits busy status at start and idle at end', async () => {
    seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    const sendCalls = mockWindow.webContents.send.mock.calls
    const streamCalls = sendCalls.filter((c: any[]) => c[0] === 'opencode:stream')
    const statusEvents = streamCalls
      .map((c: any[]) => c[1])
      .filter((e: any) => e.type === 'session.status')

    // At minimum: busy at start, idle at end
    expect(statusEvents.length).toBeGreaterThanOrEqual(2)

    // First status should be busy
    expect(statusEvents[0].statusPayload.type).toBe('busy')

    // Last status should be idle
    expect(statusEvents[statusEvents.length - 1].statusPayload.type).toBe('idle')
  })

  // ── Event forwarding ────────────────────────────────────────

  it('forwards mapped item/agentMessage/delta events to renderer', async () => {
    seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'item/agentMessage/delta',
        textDelta: 'Hello',
        payload: { delta: 'Hello' }
      },
      {
        id: 'e2',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    const sendCalls = mockWindow.webContents.send.mock.calls
    const streamCalls = sendCalls
      .filter((c: any[]) => c[0] === 'opencode:stream')
      .map((c: any[]) => c[1])

    const textEvents = streamCalls.filter(
      (e: any) => e.type === 'message.part.updated' && e.data?.type === 'text'
    )

    expect(textEvents.length).toBeGreaterThanOrEqual(1)
    expect(textEvents[0].data.text).toBe('Hello')
  })

  it('ignores events for other threads', async () => {
    seedSession()

    simulateManagerEvents([
      {
        id: 'e-other',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-OTHER',
        createdAt: new Date().toISOString(),
        method: 'item/agentMessage/delta',
        textDelta: 'Wrong thread',
        payload: { delta: 'Wrong thread' }
      },
      {
        id: 'e-done',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    const sendCalls = mockWindow.webContents.send.mock.calls
    const streamCalls = sendCalls
      .filter((c: any[]) => c[0] === 'opencode:stream')
      .map((c: any[]) => c[1])

    const textEvents = streamCalls.filter(
      (e: any) => e.type === 'message.part.updated' && e.data?.type === 'text'
    )

    // The "Wrong thread" event should not have been forwarded
    expect(textEvents).toHaveLength(0)
  })

  // ── Message accumulation ────────────────────────────────────

  it('accumulates messages in session.messages', async () => {
    const session = seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'item/agentMessage/delta',
        textDelta: 'Response text',
        payload: { delta: 'Response text' }
      },
      {
        id: 'e2',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'My question')

    // Should have user message and assistant message
    expect(session.messages.length).toBe(2)
    expect((session.messages[0] as any).role).toBe('user')
    expect((session.messages[1] as any).role).toBe('assistant')
    expect((session.messages[1] as any).parts[0].text).toBe('Response text')
  })

  it('includes synthetic user message', async () => {
    const session = seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'User says hello')

    const userMsg = session.messages[0] as any
    expect(userMsg.role).toBe('user')
    expect(userMsg.parts[0].text).toBe('User says hello')
  })

  // ── Error handling ──────────────────────────────────────────

  it('emits session.error when sendTurn throws', async () => {
    seedSession()
    mockManager.sendTurn.mockRejectedValue(new Error('API error'))

    await impl.prompt('/test/project', 'thread-1', 'test')

    const sendCalls = mockWindow.webContents.send.mock.calls
    const streamCalls = sendCalls
      .filter((c: any[]) => c[0] === 'opencode:stream')
      .map((c: any[]) => c[1])

    const errorEvents = streamCalls.filter((e: any) => e.type === 'session.error')
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0].data.error).toBe('API error')
  })

  it('sets session status to error on failure', async () => {
    const session = seedSession()
    mockManager.sendTurn.mockRejectedValue(new Error('fail'))

    await impl.prompt('/test/project', 'thread-1', 'test')

    expect(session.status).toBe('error')
  })

  it('cleans up event listener after success', async () => {
    seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    expect(mockManager.removeListener).toHaveBeenCalledWith('event', expect.any(Function))
  })

  it('cleans up event listener after error', async () => {
    seedSession()
    mockManager.sendTurn.mockRejectedValue(new Error('fail'))

    await impl.prompt('/test/project', 'thread-1', 'test')

    expect(mockManager.removeListener).toHaveBeenCalledWith('event', expect.any(Function))
  })

  it('rejects when process crashes (error kind event)', async () => {
    const session = seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'error',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'process/error',
        message: 'codex app-server process crashed'
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    // Should have set status to error
    expect(session.status).toBe('error')

    // Should have emitted session.error to renderer
    const sendCalls = mockWindow.webContents.send.mock.calls
    const streamCalls = sendCalls
      .filter((c: any[]) => c[0] === 'opencode:stream')
      .map((c: any[]) => c[1])
    const errorEvents = streamCalls.filter((e: any) => e.type === 'session.error')
    expect(errorEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('rejects when session.state.changed emits error', async () => {
    const session = seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'session.state.changed',
        payload: { state: 'error', reason: 'API key revoked' }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    expect(session.status).toBe('error')

    const sendCalls = mockWindow.webContents.send.mock.calls
    const streamCalls = sendCalls
      .filter((c: any[]) => c[0] === 'opencode:stream')
      .map((c: any[]) => c[1])
    const errorEvents = streamCalls.filter((e: any) => e.type === 'session.error')
    expect(errorEvents.length).toBeGreaterThanOrEqual(1)
    expect(errorEvents.some((e: any) => e.data?.error?.includes('API key revoked'))).toBe(true)
  })

  it('sets session status to error on failed turn', async () => {
    const session = seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'failed', error: 'Rate limit exceeded' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    expect(session.status).toBe('error')
  })

  // ── Session not found ───────────────────────────────────────

  it('throws if session not found', async () => {
    await expect(
      impl.prompt('/unknown', 'thread-x', 'hello')
    ).rejects.toThrow('session not found')
  })

  // ── Empty text ──────────────────────────────────────────────

  it('ignores empty text prompt', async () => {
    seedSession()

    await impl.prompt('/test/project', 'thread-1', '   ')

    expect(mockManager.sendTurn).not.toHaveBeenCalled()
  })

  // ── Model override ──────────────────────────────────────────

  it('uses modelOverride when provided', async () => {
    seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test', {
      providerID: 'codex',
      modelID: 'gpt-5.3-codex'
    })

    expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
      text: 'test',
      model: 'gpt-5.3-codex',
      interactionMode: 'default'
    })
  })

  // ── plan mode interactionMode ───────────────────────────────

  describe('plan mode interactionMode', () => {
    it('passes interactionMode: plan when dbService returns a session with mode: plan', async () => {
      seedSession()

      const mockDbService = {
        getSession: vi.fn().mockReturnValue({ id: 'hive-session-1', mode: 'plan' })
      } as any
      impl.setDatabaseService(mockDbService)

      simulateManagerEvents([
        {
          id: 'e1',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        }
      ])

      await impl.prompt('/test/project', 'thread-1', 'Plan something')

      expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
        text: 'Plan something',
        model: expect.any(String),
        interactionMode: 'plan'
      })
    })

    it('passes interactionMode: default when dbService returns a session with mode: build', async () => {
      seedSession()

      const mockDbService = {
        getSession: vi.fn().mockReturnValue({ id: 'hive-session-1', mode: 'build' })
      } as any
      impl.setDatabaseService(mockDbService)

      simulateManagerEvents([
        {
          id: 'e1',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        }
      ])

      await impl.prompt('/test/project', 'thread-1', 'Build something')

      expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
        text: 'Build something',
        model: expect.any(String),
        interactionMode: 'default'
      })
    })

    it('passes interactionMode: default when no dbService is set', async () => {
      seedSession()
      // impl has no dbService set by default

      simulateManagerEvents([
        {
          id: 'e1',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        }
      ])

      await impl.prompt('/test/project', 'thread-1', 'Do something')

      expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
        text: 'Do something',
        model: expect.any(String),
        interactionMode: 'default'
      })
    })
  })

  // ── getMessages ─────────────────────────────────────────────

  describe('getMessages', () => {
    it('returns accumulated messages', async () => {
      const session = seedSession()
      session.messages = [
        { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }
      ]

      const messages = await impl.getMessages('/test/project', 'thread-1')

      expect(messages).toHaveLength(2)
    })

    it('returns empty array for unknown session', async () => {
      const messages = await impl.getMessages('/unknown', 'thread-x')

      expect(messages).toEqual([])
    })

    it('returns a copy of messages', async () => {
      const session = seedSession()
      session.messages = [{ role: 'user', parts: [] }]

      const messages = await impl.getMessages('/test/project', 'thread-1')
      messages.push({ role: 'fake' })

      expect(session.messages).toHaveLength(1)
    })
  })
})
