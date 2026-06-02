/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  Notification: vi.fn().mockImplementation(() => ({
    show: vi.fn(),
    on: vi.fn()
  })),
  app: {
    getName: vi.fn(() => 'Xuanpu'),
    getPath: vi.fn(() => '/tmp')
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: vi.fn(() => false),
      resize: vi.fn()
    }))
  }
}))

// Mock logger
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

const mockGenerateCodexSessionTitle = vi.fn()
const mockBuildXfpFallbackContext = vi.fn()
vi.mock('../../../src/main/services/codex-session-title', () => ({
  generateCodexSessionTitle: (...args: any[]) => mockGenerateCodexSessionTitle(...args)
}))

vi.mock('../../../src/main/services/codex-config', () => ({
  getCodexConfiguredModel: vi.fn(() => undefined),
  getCodexConfiguredContextWindow: vi.fn(() => undefined),
  getCodexConfiguredReasoningEffort: vi.fn(() => undefined)
}))

vi.mock('../../../src/main/xfp/fallback-context', () => ({
  buildXfpFallbackContext: (...args: any[]) => mockBuildXfpFallbackContext(...args)
}))

vi.mock('../../../src/main/xfp/provider', () => ({
  xfpProvider: { id: 'mock-xfp-provider' }
}))

vi.mock('../../../src/main/services/git-service', () => ({
  autoRenameWorktreeBranch: vi.fn().mockResolvedValue({ success: true })
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
    setThreadGoal: vi.fn(),
    sendTurn: vi.fn(),
    interruptTurn: vi.fn(),
    readThread: vi.fn(),
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

import {
  CodexImplementer,
  normalizeCodexMessageTimestamps,
  type CodexSessionState
} from '../../../src/main/services/codex-implementer'
import { getCodexConfiguredReasoningEffort } from '../../../src/main/services/codex-config'
import { __resetXfpAuditForTest, listXfpAuditEvents } from '../../../src/main/xfp/audit'

describe('CodexImplementer.prompt()', () => {
  let impl: CodexImplementer
  let mockManager: any
  let mockWindow: any

  beforeEach(() => {
    vi.clearAllMocks()
    __resetXfpAuditForTest()
    eventListeners = []
    mockGenerateCodexSessionTitle.mockResolvedValue(null)
    mockBuildXfpFallbackContext.mockResolvedValue(null)
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
      liveAssistantDraft: null,
      revertMessageID: null,
      revertDiff: null,
      titleGenerated: false,
      titleGenerationStarted: false,
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

  function emitManagerEvent(event: any) {
    for (const listener of [...eventListeners]) {
      listener(event)
    }
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
    expect(mockGenerateCodexSessionTitle).toHaveBeenCalledWith('Hello Codex', '/test/project')
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

  it('uses originalMessage for title and synthetic user message while sending runtime text', async () => {
    const session = seedSession()
    const runtimeMessage = '[Field Context]\nRepo context\n[User Message]\nFix the timeline'
    const mockDb = {
      updateSession: vi.fn(),
      getSession: vi.fn().mockReturnValue(null),
      replaceSessionMessages: vi.fn()
    }
    impl.setDatabaseService(mockDb as any)

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

    await impl.prompt('/test/project', 'thread-1', runtimeMessage, undefined, {
      originalMessage: 'Fix the timeline'
    } as any)

    expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
      text: runtimeMessage,
      model: expect.any(String),
      interactionMode: 'default'
    })
    expect(mockDb.updateSession).toHaveBeenCalledWith('hive-session-1', {
      name: 'Fix the timeline'
    })
    expect(mockGenerateCodexSessionTitle).toHaveBeenCalledWith('Fix the timeline', '/test/project')
    expect((session.messages[0] as any).parts[0].text).toBe('Fix the timeline')

    const firstPersist = mockDb.replaceSessionMessages.mock.calls[0][1]
    expect(firstPersist[0].content).toBe('Fix the timeline')
    expect(JSON.parse(firstPersist[0].opencode_message_json).parts[0].text).toBe('Fix the timeline')
  })

  it('uses bounded XFP fallback for field-sensitive Codex prompts without polluting history', async () => {
    const session = seedSession()
    const mockDb = {
      updateSession: vi.fn(),
      getSession: vi.fn().mockReturnValue(null),
      getWorktreeByPath: vi.fn().mockReturnValue({ id: 'wt-codex' }),
      replaceSessionMessages: vi.fn()
    }
    impl.setDatabaseService(mockDb as any)
    mockBuildXfpFallbackContext.mockResolvedValueOnce({
      markdown: '[Xuanpu Field Fallback]\n## Current Focus\n- File: /test/project/src/main.ts',
      approxTokens: 24,
      reason: 'field-reference',
      included: ['current_focus']
    })

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

    await impl.prompt('/test/project', 'thread-1', '这里为什么挂？')

    expect(mockBuildXfpFallbackContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { worktreeId: 'wt-codex', sessionId: 'hive-session-1' },
        promptText: '这里为什么挂？'
      })
    )
    expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
      text: '[Xuanpu Field Fallback]\n## Current Focus\n- File: /test/project/src/main.ts\n\n[User Message]\n这里为什么挂？',
      model: expect.any(String),
      interactionMode: 'default'
    })
    expect((session.messages[0] as any).parts[0].text).toBe('这里为什么挂？')

    const firstPersist = mockDb.replaceSessionMessages.mock.calls[0][1]
    expect(firstPersist[0].content).toBe('这里为什么挂？')
    expect(firstPersist[0].opencode_message_json).not.toContain('[Xuanpu Field Fallback]')
    expect(listXfpAuditEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          worktreeId: 'wt-codex',
          sessionId: 'hive-session-1',
          runtimeId: 'codex',
          kind: 'fallback',
          toolName: 'xfp_triggered_fallback',
          input: { reason: 'field-reference', included: ['current_focus'] }
        }),
        expect.objectContaining({
          worktreeId: 'wt-codex',
          sessionId: 'hive-session-1',
          runtimeId: 'codex',
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

  it('uses Codex XFP dynamic tools instead of fallback prompt injection when attached', async () => {
    seedSession({ xfpToolsAttached: true })
    const mockDb = {
      updateSession: vi.fn(),
      getSession: vi.fn().mockReturnValue(null),
      getWorktreeByPath: vi.fn().mockReturnValue({ id: 'wt-codex' }),
      replaceSessionMessages: vi.fn()
    }
    impl.setDatabaseService(mockDb as any)

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

    await impl.prompt('/test/project', 'thread-1', '这里为什么挂？')

    expect(mockBuildXfpFallbackContext).not.toHaveBeenCalled()
    expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
      text: '这里为什么挂？',
      model: expect.any(String),
      interactionMode: 'default'
    })
    expect(listXfpAuditEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runtimeId: 'codex',
          kind: 'prompt',
          input: expect.objectContaining({
            mode: 'xfp-mcp',
            hasXfpFallbackPrefix: false,
            hasFieldContextEnvelope: false
          })
        })
      ])
    )
  })

  it('strips field context from fallback display parts and preserves attachments', async () => {
    const session = seedSession()
    const mockDb = {
      updateSession: vi.fn(),
      getSession: vi.fn().mockReturnValue(null),
      replaceSessionMessages: vi.fn()
    }
    impl.setDatabaseService(mockDb as any)

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
      {
        type: 'text',
        text: '[Field Context]\nRepo context\n[User Message]\nReview attached file'
      },
      {
        type: 'file',
        mime: 'text/plain',
        url: 'file:///tmp/a.txt',
        filename: 'a.txt'
      }
    ])

    expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
      text: '[Field Context]\nRepo context\n[User Message]\nReview attached file',
      model: expect.any(String),
      interactionMode: 'default'
    })
    expect((session.messages[0] as any).parts).toMatchObject([
      { type: 'text', text: 'Review attached file' },
      { type: 'file', mime: 'text/plain', url: 'file:///tmp/a.txt', filename: 'a.txt' }
    ])

    const firstPersist = mockDb.replaceSessionMessages.mock.calls[0][1]
    const persistedParts = JSON.parse(firstPersist[0].opencode_parts_json)
    expect(persistedParts).toMatchObject([
      { type: 'text', text: 'Review attached file' },
      { type: 'file', mime: 'text/plain', url: 'file:///tmp/a.txt', filename: 'a.txt' }
    ])
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
    const streamCalls = sendCalls.filter((c: any[]) => c[0] === 'agent:stream')
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

  it('persists thread compaction as a durable compaction marker, not a tool card', async () => {
    const compactedAt = '2026-05-31T08:00:03.000Z'
    const mockDb = {
      updateSession: vi.fn(),
      getSession: vi.fn().mockReturnValue(null),
      replaceSessionMessages: vi.fn()
    }
    impl.setDatabaseService(mockDb as any)
    seedSession()
    ;(impl as any).attachManagerListener()

    simulateManagerEvents([
      {
        id: 'compact-1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: compactedAt,
        method: 'thread/compacted',
        payload: { trigger: 'auto' }
      },
      {
        id: 'e-done',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: '2026-05-31T08:00:04.000Z',
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'trigger compaction')

    const persistedBatches = mockDb.replaceSessionMessages.mock.calls.map((call) => call[1])
    const compactionRow = persistedBatches
      .flat()
      .find((row: any) =>
        JSON.parse(row.opencode_parts_json).some((part: any) => part.type === 'compaction')
      )

    expect(compactionRow).toBeTruthy()
    expect(compactionRow.role).toBe('assistant')
    expect(compactionRow.content).toBe('')
    expect(JSON.parse(compactionRow.opencode_message_json)).toMatchObject({
      id: 'compaction:compact-1',
      role: 'assistant',
      parts: [{ type: 'compaction', auto: true, timestamp: compactedAt }]
    })

    const streamEvents = mockWindow.webContents.send.mock.calls
      .filter((call: any[]) => call[0] === 'agent:stream')
      .map((call: any[]) => call[1])
    expect(streamEvents.some((event: any) => event.type === 'session.context_compacted')).toBe(true)
    expect(
      persistedBatches
        .flat()
        .some((row: any) =>
          JSON.parse(row.opencode_parts_json).some((part: any) => part.type === 'tool_use')
        )
    ).toBe(false)
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
      .filter((c: any[]) => c[0] === 'agent:stream')
      .map((c: any[]) => c[1])

    const textEvents = streamCalls.filter(
      (e: any) => e.type === 'message.part.updated' && e.data?.part?.type === 'text'
    )

    expect(textEvents.length).toBeGreaterThanOrEqual(1)
    expect(textEvents[0].data.part.text).toBe('Hello')
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
      .filter((c: any[]) => c[0] === 'agent:stream')
      .map((c: any[]) => c[1])

    const textEvents = streamCalls.filter(
      (e: any) => e.type === 'message.part.updated' && e.data?.part?.type === 'text'
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

  it('keeps placeholder title immediately and replaces it with generated title later', async () => {
    seedSession()

    const mockDb = {
      updateSession: vi.fn(),
      getSession: vi.fn().mockReturnValue({
        id: 'hive-session-1',
        name: 'Fix auth token refresh bug'
      }),
      getWorktreeBySessionId: vi.fn().mockReturnValue(null)
    }
    impl.setDatabaseService(mockDb as any)

    mockGenerateCodexSessionTitle.mockResolvedValue('Auth refresh fix')

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

    await impl.prompt('/test/project', 'thread-1', 'Fix auth token refresh bug')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockDb.updateSession).toHaveBeenNthCalledWith(1, 'hive-session-1', {
      name: 'Fix auth token refresh bug'
    })
    expect(mockDb.updateSession).toHaveBeenNthCalledWith(2, 'hive-session-1', {
      name: 'Auth refresh fix'
    })

    const streamCalls = mockWindow.webContents.send.mock.calls
      .filter((c: any[]) => c[0] === 'agent:stream')
      .map((c: any[]) => c[1])
      .filter((e: any) => e.type === 'session.updated')

    expect(streamCalls).toHaveLength(2)
    expect(streamCalls[0]).toMatchObject({
      type: 'session.updated',
      sessionId: 'hive-session-1',
      data: {
        title: 'Fix auth token refresh bug',
        info: { title: 'Fix auth token refresh bug' }
      }
    })
    expect(streamCalls[1]).toMatchObject({
      type: 'session.updated',
      sessionId: 'hive-session-1',
      data: {
        title: 'Auth refresh fix',
        info: { title: 'Auth refresh fix' }
      }
    })
  })

  it('starts title generation only once per session', async () => {
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

    await impl.prompt('/test/project', 'thread-1', 'First message')
    session.status = 'ready'
    await impl.prompt('/test/project', 'thread-1', 'Second message')

    expect(mockGenerateCodexSessionTitle).toHaveBeenCalledTimes(1)
  })

  // ── Error handling ──────────────────────────────────────────

  it('emits session.error when sendTurn throws', async () => {
    seedSession()
    mockManager.sendTurn.mockRejectedValue(new Error('API error'))

    await impl.prompt('/test/project', 'thread-1', 'test')

    const sendCalls = mockWindow.webContents.send.mock.calls
    const streamCalls = sendCalls
      .filter((c: any[]) => c[0] === 'agent:stream')
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
      .filter((c: any[]) => c[0] === 'agent:stream')
      .map((c: any[]) => c[1])
    const errorEvents = streamCalls.filter((e: any) => e.type === 'session.error')
    expect(errorEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('does not abort turn on non-fatal error events (e.g. stderr warnings)', async () => {
    const session = seedSession()

    // Simulate a non-fatal error event followed by turn/completed.
    // Before the fix, ANY kind='error' event would abort the turn.
    // Now only fatal events (process/error, session/exited, session/closed) abort.
    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'process/stderr',
        message: 'Some benign stderr warning'
      },
      {
        id: 'e2',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'item/agentMessage/delta',
        textDelta: 'Hello from Codex'
      },
      {
        id: 'e3',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'turn/completed',
        payload: { turn: { status: 'completed' } }
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    // Turn should complete successfully — not error out
    expect(session.status).toBe('ready')

    // Assistant text should have been accumulated
    expect(session.messages.length).toBeGreaterThanOrEqual(2)
    const assistantMsg = session.messages.find((m: any) => m.role === 'assistant') as any
    expect(assistantMsg).toBeTruthy()
    expect(assistantMsg.parts[0].text).toBe('Hello from Codex')
  })

  it('rejects when session exits (session/exited)', async () => {
    const session = seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'session',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'session/exited',
        message: 'codex app-server exited (code=1, signal=null).'
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    expect(session.status).toBe('error')
  })

  it('rejects when session closes (session/closed)', async () => {
    const session = seedSession()

    simulateManagerEvents([
      {
        id: 'e1',
        kind: 'session',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'session/closed',
        message: 'Session stopped'
      }
    ])

    await impl.prompt('/test/project', 'thread-1', 'test')

    expect(session.status).toBe('error')
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
      .filter((c: any[]) => c[0] === 'agent:stream')
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

  // ── Run / turn isolation ─────────────────────────────────────

  it('does not resolve the current prompt from a different turn completion', async () => {
    const session = seedSession()
    mockManager.sendTurn.mockResolvedValue({ turnId: 'turn-b', threadId: 'thread-1' })

    let settled = false
    const promptPromise = impl.prompt('/test/project', 'thread-1', 'Current prompt').then(() => {
      settled = true
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockManager.sendTurn).toHaveBeenCalled()

    emitManagerEvent({
      id: 'wrong-turn',
      kind: 'notification',
      provider: 'codex',
      threadId: 'thread-1',
      turnId: 'turn-a',
      createdAt: new Date().toISOString(),
      method: 'turn/completed',
      payload: { turn: { id: 'turn-a', status: 'completed' } }
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    expect(session.status).toBe('running')

    emitManagerEvent({
      id: 'right-turn',
      kind: 'notification',
      provider: 'codex',
      threadId: 'thread-1',
      turnId: 'turn-b',
      createdAt: new Date().toISOString(),
      method: 'turn/completed',
      payload: { turn: { id: 'turn-b', status: 'completed' } }
    })

    await promptPromise
    expect(settled).toBe(true)
    expect(session.status).toBe('ready')
  })

  it('settles an interrupted turn without waiting for timeout', async () => {
    const session = seedSession()
    mockManager.sendTurn.mockResolvedValue({ turnId: 'turn-stop', threadId: 'thread-1' })

    const promptPromise = impl.prompt('/test/project', 'thread-1', 'Stop me')
    await new Promise((resolve) => setTimeout(resolve, 0))

    emitManagerEvent({
      id: 'interrupted',
      kind: 'session',
      provider: 'codex',
      threadId: 'thread-1',
      turnId: 'turn-stop',
      createdAt: new Date().toISOString(),
      method: 'turn/interrupted',
      message: 'Turn interrupted'
    })

    await promptPromise
    expect(session.status).toBe('ready')
    expect(session.activeRun).toBeNull()
  })

  it('keeps streaming after an abort request until Codex confirms the turn stopped', async () => {
    const session = seedSession()
    mockManager.sendTurn.mockResolvedValue({ turnId: 'turn-stop', threadId: 'thread-1' })
    mockManager.interruptTurn.mockResolvedValue(undefined)

    const promptPromise = impl.prompt('/test/project', 'thread-1', 'Stop me')
    await new Promise((resolve) => setTimeout(resolve, 0))

    emitManagerEvent({
      id: 'delta-before-stop',
      kind: 'notification',
      provider: 'codex',
      threadId: 'thread-1',
      turnId: 'turn-stop',
      createdAt: new Date().toISOString(),
      method: 'item/agentMessage/delta',
      textDelta: 'before '
    })

    await impl.abort('/test/project', 'thread-1')

    expect(mockManager.interruptTurn).toHaveBeenCalledWith('thread-1', 'turn-stop')
    expect(session.status).toBe('running')
    expect(session.activeRun?.state).toBe('aborting')

    const statusEventsBeforeProviderStop = mockWindow.webContents.send.mock.calls
      .filter((c: any[]) => c[0] === 'agent:stream')
      .map((c: any[]) => c[1])
      .filter((event: any) => event.type === 'session.status')
    expect(
      statusEventsBeforeProviderStop.some((event: any) => event.statusPayload?.type === 'idle')
    ).toBe(false)

    emitManagerEvent({
      id: 'delta-after-stop',
      kind: 'notification',
      provider: 'codex',
      threadId: 'thread-1',
      turnId: 'turn-stop',
      createdAt: new Date().toISOString(),
      method: 'item/agentMessage/delta',
      textDelta: 'after'
    })

    emitManagerEvent({
      id: 'provider-idle',
      kind: 'notification',
      provider: 'codex',
      threadId: 'thread-1',
      createdAt: new Date().toISOString(),
      method: 'thread/status/changed',
      payload: { status: { type: 'idle' } }
    })

    await promptPromise

    const assistant = session.messages.find((message: any) => message.role === 'assistant') as any
    expect(assistant?.aborted).toBe(true)
    expect(assistant?.parts?.[0]?.text).toBe('before after')
    expect(session.status).toBe('ready')
    expect(session.activeRun).toBeNull()
  })

  it('ignores a stale thread/read snapshot after a newer prompt has completed', async () => {
    const session = seedSession()
    let sendCount = 0
    let resolveReadA: ((value: unknown) => void) | null = null

    mockManager.sendTurn.mockImplementation(async () => {
      sendCount += 1
      return { turnId: sendCount === 1 ? 'turn-a' : 'turn-b', threadId: 'thread-1' }
    })

    mockManager.readThread
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveReadA = resolve
          })
      )
      .mockResolvedValueOnce({
        thread: {
          id: 'thread-1',
          turns: [
            {
              id: 'turn-a',
              input: [{ type: 'text', text: 'Prompt A' }],
              outputText: 'Reply A'
            },
            {
              id: 'turn-b',
              input: [{ type: 'text', text: 'Prompt B' }],
              outputText: 'Reply B'
            }
          ]
        }
      })

    const promptA = impl.prompt('/test/project', 'thread-1', 'Prompt A')
    await new Promise((resolve) => setTimeout(resolve, 0))
    emitManagerEvent({
      id: 'a-complete',
      kind: 'notification',
      provider: 'codex',
      threadId: 'thread-1',
      turnId: 'turn-a',
      createdAt: new Date().toISOString(),
      method: 'turn/completed',
      payload: { turn: { id: 'turn-a', status: 'completed' } }
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const promptB = impl.prompt('/test/project', 'thread-1', 'Prompt B')
    await new Promise((resolve) => setTimeout(resolve, 0))
    emitManagerEvent({
      id: 'b-complete',
      kind: 'notification',
      provider: 'codex',
      threadId: 'thread-1',
      turnId: 'turn-b',
      createdAt: new Date().toISOString(),
      method: 'turn/completed',
      payload: { turn: { id: 'turn-b', status: 'completed' } }
    })
    await promptB

    resolveReadA?.({
      thread: {
        id: 'thread-1',
        turns: [
          {
            id: 'turn-a',
            input: [{ type: 'text', text: 'Prompt A' }],
            outputText: 'Stale Reply A'
          }
        ]
      }
    })
    await promptA

    const texts = session.messages.flatMap((message: any) =>
      (message.parts ?? []).map((part: any) => part.text).filter(Boolean)
    )
    expect(texts).toContain('Prompt B')
    expect(texts).toContain('Reply B')
    expect(texts).not.toContain('Stale Reply A')
  })

  // ── Session not found ───────────────────────────────────────

  it('throws if session not found', async () => {
    await expect(impl.prompt('/unknown', 'thread-x', 'hello')).rejects.toThrow('session not found')
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

  it('maps codexFastMode to serviceTier fast', async () => {
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

    await impl.prompt('/test/project', 'thread-1', 'test', undefined, { codexFastMode: true })

    expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
      text: 'test',
      model: 'gpt-5.4',
      serviceTier: 'fast',
      interactionMode: 'default'
    })
  })

  // ── Reasoning effort propagation ───────────────────────────────

  it('sends reasoningEffort from modelOverride.variant', async () => {
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
      modelID: 'gpt-5.4',
      variant: 'xhigh'
    })

    expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
      text: 'test',
      model: 'gpt-5.4',
      reasoningEffort: 'xhigh',
      interactionMode: 'default'
    })
  })

  it('sends reasoningEffort from DB session model_variant when no override', async () => {
    seedSession()

    const mockDbService = {
      getSession: vi.fn().mockReturnValue({ id: 'hive-session-1', model_variant: 'xhigh' }),
      updateSession: vi.fn()
    }
    impl.setDatabaseService(mockDbService as any)

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

    expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
      text: 'test',
      model: 'gpt-5.4',
      reasoningEffort: 'xhigh',
      interactionMode: 'default'
    })
  })

  it('sends reasoningEffort from selectedVariant when DB has no variant', async () => {
    seedSession()
    impl.setSelectedModel({ providerID: 'codex', modelID: 'gpt-5.4', variant: 'xhigh' })

    const mockDbService = {
      getSession: vi.fn().mockReturnValue({ id: 'hive-session-1' }),
      updateSession: vi.fn()
    }
    impl.setDatabaseService(mockDbService as any)

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

    expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
      text: 'test',
      model: 'gpt-5.4',
      reasoningEffort: 'xhigh',
      interactionMode: 'default'
    })
  })

  it('sends reasoningEffort from codex config when no override/DB/selected', async () => {
    seedSession()

    vi.mocked(getCodexConfiguredReasoningEffort).mockReturnValue('high')

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

    expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
      text: 'test',
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      interactionMode: 'default'
    })

    vi.mocked(getCodexConfiguredReasoningEffort).mockReturnValue(undefined)
  })

  it('sends no explicit reasoningEffort when all sources are absent', async () => {
    seedSession()

    vi.mocked(getCodexConfiguredReasoningEffort).mockReturnValue(undefined)

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

    const callArgs = mockManager.sendTurn.mock.calls[0][1]
    expect(callArgs.reasoningEffort).toBeUndefined()
    expect(callArgs).not.toHaveProperty('reasoningEffort')
  })

  // ── goal mode ─────────────────────────────────────────────────

  it('sets a Codex thread goal before sending the turn when goal mode is enabled', async () => {
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

    await impl.prompt('/test/project', 'thread-1', 'Ship the migration', undefined, {
      goalMode: true,
      successCriteria: 'Focused tests pass'
    })

    expect(mockManager.setThreadGoal).toHaveBeenCalledWith('thread-1', {
      objective: 'Ship the migration\n\nSuccess criteria:\nFocused tests pass',
      status: 'active',
      tokenBudget: null
    })
    expect(mockManager.sendTurn).toHaveBeenCalledWith('thread-1', {
      text: 'Ship the migration',
      model: 'gpt-5.4',
      interactionMode: 'default'
    })
    expect(mockManager.setThreadGoal.mock.invocationCallOrder[0]).toBeLessThan(
      mockManager.sendTurn.mock.invocationCallOrder[0]
    )
  })

  it('uses the pre-injection goal objective when provided by IPC', async () => {
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

    await impl.prompt(
      '/test/project',
      'thread-1',
      '[Field Context]\nCurrent file: src/a.ts\n\n[User Message]\nShip the migration',
      undefined,
      {
        goalMode: true,
        successCriteria: 'Focused tests pass',
        goalObjective: 'Ship the migration\n\nSuccess criteria:\nFocused tests pass'
      }
    )

    expect(mockManager.setThreadGoal).toHaveBeenCalledWith('thread-1', {
      objective: 'Ship the migration\n\nSuccess criteria:\nFocused tests pass',
      status: 'active',
      tokenBudget: null
    })
  })

  it('falls back to prompt goal instructions when Codex goals are disabled', async () => {
    const session = seedSession()
    mockManager.setThreadGoal.mockRejectedValue(
      new Error('thread/goal/set failed: goals feature is disabled')
    )

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

    await impl.prompt(
      '/test/project',
      'thread-1',
      '[Field Context]\nCurrent file: src/a.ts\n\n[User Message]\nShip the migration',
      undefined,
      {
        goalMode: true,
        successCriteria: 'Focused tests pass',
        goalObjective: 'Ship the migration\n\nSuccess criteria:\nFocused tests pass'
      }
    )

    expect(mockManager.setThreadGoal).toHaveBeenCalledWith('thread-1', {
      objective: 'Ship the migration\n\nSuccess criteria:\nFocused tests pass',
      status: 'active',
      tokenBudget: null
    })
    expect(mockManager.sendTurn).toHaveBeenCalledTimes(1)

    const turnInput = mockManager.sendTurn.mock.calls[0][1]
    expect(turnInput.text).toContain('[Field Context]')
    expect(turnInput.text).toContain('[Xuanpu Goal]')
    expect(turnInput.text).toContain('Ship the migration')
    expect(turnInput.text).toContain('Focused tests pass')
    expect(session.status).toBe('ready')

    const errorEvents = mockWindow.webContents.send.mock.calls
      .filter((c: any[]) => c[0] === 'agent:stream')
      .map((c: any[]) => c[1])
      .filter((e: any) => e.type === 'session.error')
    expect(errorEvents).toHaveLength(0)
  })

  it('does not set a thread goal when goal mode is disabled', async () => {
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

    await impl.prompt('/test/project', 'thread-1', 'Regular prompt', undefined, {
      successCriteria: 'Ignored without goal mode'
    })

    expect(mockManager.setThreadGoal).not.toHaveBeenCalled()
    expect(mockManager.sendTurn).toHaveBeenCalled()
  })

  it('fails the prompt before sendTurn when explicit goal setup fails', async () => {
    const session = seedSession()
    mockManager.setThreadGoal.mockRejectedValue(new Error('goal RPC failed'))

    await impl.prompt('/test/project', 'thread-1', 'Ship the migration', undefined, {
      goalMode: true
    })

    expect(mockManager.sendTurn).not.toHaveBeenCalled()
    expect(session.status).toBe('error')

    const errorEvents = mockWindow.webContents.send.mock.calls
      .filter((c: any[]) => c[0] === 'agent:stream')
      .map((c: any[]) => c[1])
      .filter((e: any) => e.type === 'session.error')
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0].data.error).toBe('goal RPC failed')
  })

  // ── plan mode interactionMode ───────────────────────────────

  describe('plan mode interactionMode', () => {
    it('passes interactionMode: plan when dbService returns a session with mode: plan', async () => {
      seedSession()

      const mockDbService = {
        getSession: vi.fn().mockReturnValue({ id: 'hive-session-1', mode: 'plan' }),
        updateSession: vi.fn()
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
        getSession: vi.fn().mockReturnValue({ id: 'hive-session-1', mode: 'build' }),
        updateSession: vi.fn()
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

    it('emits plan.ready when a plan-shaped task_complete arrives in plan mode', async () => {
      seedSession()

      const mockDbService = {
        getSession: vi.fn().mockReturnValue({ id: 'hive-session-1', mode: 'plan' }),
        updateSession: vi.fn()
      } as any
      impl.setDatabaseService(mockDbService)

      simulateManagerEvents([
        {
          id: 'e-plan',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'codex/event/task_complete',
          payload: {
            msg: {
              turn_id: 'turn-1',
              last_agent_message:
                '<proposed_plan>\n1. Add the function\n2. Add a test\n</proposed_plan>'
            }
          }
        },
        {
          id: 'e-done',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { id: 'turn-1', status: 'completed' } }
        }
      ])

      await impl.prompt('/test/project', 'thread-1', 'Plan something')

      const streamCalls = mockWindow.webContents.send.mock.calls
        .filter((c: any[]) => c[0] === 'agent:stream')
        .map((c: any[]) => c[1])

      const planReadyEvent = streamCalls.find((e: any) => e.type === 'plan.ready')
      expect(planReadyEvent).toBeDefined()
      expect(planReadyEvent.data.plan).toContain('1. Add the function')
      expect(planReadyEvent.data.toolUseID).toBeTruthy()
    })

    it('does not emit plan.ready for a clarifying question in plan mode', async () => {
      seedSession()

      const mockDbService = {
        getSession: vi.fn().mockReturnValue({ id: 'hive-session-1', mode: 'plan' }),
        updateSession: vi.fn()
      } as any
      impl.setDatabaseService(mockDbService)

      simulateManagerEvents([
        {
          id: 'e-plan',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'codex/event/task_complete',
          payload: {
            msg: {
              turn_id: 'turn-1',
              last_agent_message:
                'Where should I add it?\n\n- New module\n- Existing utils\n\nConfirm your preference.'
            }
          }
        },
        {
          id: 'e-done',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { id: 'turn-1', status: 'completed' } }
        }
      ])

      await impl.prompt('/test/project', 'thread-1', 'Plan something')

      const streamCalls = mockWindow.webContents.send.mock.calls
        .filter((c: any[]) => c[0] === 'agent:stream')
        .map((c: any[]) => c[1])

      const planReadyEvent = streamCalls.find((e: any) => e.type === 'plan.ready')
      expect(planReadyEvent).toBeUndefined()
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

    it('returns a live in-progress assistant draft with text and tool parts while running', async () => {
      seedSession()

      let completeTurn: (() => void) | null = null
      mockManager.sendTurn.mockImplementation(async () => {
        setTimeout(() => {
          for (const listener of [...eventListeners]) {
            listener({
              id: 'e-text',
              kind: 'notification',
              provider: 'codex',
              threadId: 'thread-1',
              createdAt: new Date().toISOString(),
              method: 'item/agentMessage/delta',
              textDelta: 'Thinking through it',
              payload: { delta: 'Thinking through it' }
            })
            listener({
              id: 'e-tool-start',
              kind: 'notification',
              provider: 'codex',
              threadId: 'thread-1',
              createdAt: new Date().toISOString(),
              method: 'item.started',
              payload: {
                item: {
                  type: 'commandExecution',
                  id: 'tool-1',
                  command: 'ls',
                  status: 'inProgress'
                }
              }
            })
            listener({
              id: 'e-tool-done',
              kind: 'notification',
              provider: 'codex',
              threadId: 'thread-1',
              createdAt: new Date().toISOString(),
              method: 'item.completed',
              payload: {
                item: {
                  type: 'commandExecution',
                  id: 'tool-1',
                  command: 'ls',
                  status: 'completed',
                  aggregatedOutput: 'file-a'
                }
              }
            })
          }
        }, 0)

        await new Promise<void>((resolve) => {
          completeTurn = resolve
        })
        return { turnId: 'turn-1', threadId: 'thread-1' }
      })

      const promptPromise = impl.prompt('/test/project', 'thread-1', 'Inspect repo')
      await new Promise((resolve) => setTimeout(resolve, 10))

      const messages = await impl.getMessages('/test/project', 'thread-1')
      expect(messages).toHaveLength(2)
      expect((messages[0] as any).role).toBe('user')
      expect((messages[1] as any).role).toBe('assistant')
      expect((messages[1] as any).id).toBe('codex-live-thread-1')
      expect((messages[1] as any).parts[0]).toMatchObject({
        type: 'text',
        text: 'Thinking through it'
      })
      expect((messages[1] as any).parts[1]).toMatchObject({
        type: 'tool',
        callID: 'tool-1',
        tool: 'Bash',
        state: {
          status: 'completed',
          input: { command: 'ls' },
          output: 'file-a'
        }
      })

      for (const listener of [...eventListeners]) {
        listener({
          id: 'e-done',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        })
      }
      completeTurn?.()
      await promptPromise
    })

    it('returns a live text-only assistant draft while running', async () => {
      seedSession()

      let completeTurn: (() => void) | null = null
      mockManager.sendTurn.mockImplementation(async () => {
        setTimeout(() => {
          for (const listener of [...eventListeners]) {
            listener({
              id: 'e-text',
              kind: 'notification',
              provider: 'codex',
              threadId: 'thread-1',
              createdAt: new Date().toISOString(),
              method: 'item/agentMessage/delta',
              textDelta: 'Partial answer',
              payload: { delta: 'Partial answer' }
            })
          }
        }, 0)

        await new Promise<void>((resolve) => {
          completeTurn = resolve
        })
        return { turnId: 'turn-1', threadId: 'thread-1' }
      })

      const promptPromise = impl.prompt('/test/project', 'thread-1', 'Say hi')
      await new Promise((resolve) => setTimeout(resolve, 10))

      const messages = await impl.getMessages('/test/project', 'thread-1')
      expect(messages).toHaveLength(2)
      expect((messages[1] as any).parts).toEqual([
        expect.objectContaining({
          type: 'text',
          text: 'Partial answer'
        })
      ])

      for (const listener of [...eventListeners]) {
        listener({
          id: 'e-done',
          kind: 'notification',
          provider: 'codex',
          threadId: 'thread-1',
          createdAt: new Date().toISOString(),
          method: 'turn/completed',
          payload: { turn: { status: 'completed' } }
        })
      }
      completeTurn?.()
      await promptPromise
    })
  })
})

describe('normalizeCodexMessageTimestamps', () => {
  it('preserves transcript order when raw timestamps regress', () => {
    const rows = normalizeCodexMessageTimestamps([
      { created_at: '2026-03-14T10:00:05.000Z', role: 'user' },
      { created_at: '2026-03-14T10:00:01.000Z', role: 'assistant' },
      { created_at: 'invalid-timestamp', role: 'user' }
    ])

    expect(Date.parse(rows[0]!.created_at)).toBeLessThan(Date.parse(rows[1]!.created_at))
    expect(Date.parse(rows[1]!.created_at)).toBeLessThan(Date.parse(rows[2]!.created_at))
  })
})

describe('CodexImplementer.parseThreadSnapshot()', () => {
  it('deduplicates JSONL supplemental user messages already present in thread/read', () => {
    const impl = new CodexImplementer()
    const dir = mkdtempSync(join(tmpdir(), 'xuanpu-codex-jsonl-dedupe-'))
    const jsonlPath = join(dir, 'rollout.jsonl')
    const entries = [
      {
        timestamp: '2026-05-23T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' }
      },
      {
        timestamp: '2026-05-23T10:00:00.010Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: '继续' }
      },
      {
        timestamp: '2026-05-23T10:00:00.011Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '继续' }]
        }
      },
      {
        timestamp: '2026-05-23T10:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }] }
      }
    ]
    writeFileSync(jsonlPath, entries.map((entry) => JSON.stringify(entry)).join('\n'))

    const messages = (impl as any).parseThreadSnapshot(
      {
        thread: {
          path: jsonlPath,
          turns: [
            {
              id: 'turn-1',
              startedAt: 1779530400,
              items: [
                {
                  type: 'userMessage',
                  id: 'user-1',
                  content: [{ type: 'text', text: '继续' }]
                },
                { type: 'agentMessage', id: 'assistant-1', text: 'OK' }
              ]
            }
          ]
        }
      },
      new Map()
    )

    const userMessages = messages.filter((message: any) => message.role === 'user')
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0].id).toBe('turn-1:user')
    expect(userMessages[0].parts[0].text).toBe('继续')
  })

  it('uses Codex JSONL response-item timestamps to keep tools and text in turn order', () => {
    const impl = new CodexImplementer()
    const dir = mkdtempSync(join(tmpdir(), 'xuanpu-codex-jsonl-'))
    const jsonlPath = join(dir, 'rollout.jsonl')
    const entries = [
      {
        timestamp: '2026-05-23T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' }
      },
      {
        timestamp: '2026-05-23T10:00:00.010Z',
        type: 'event_msg',
        payload: { type: 'user_message' }
      },
      {
        timestamp: '2026-05-23T10:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Intro' }] }
      },
      {
        timestamp: '2026-05-23T10:00:02.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell_command', call_id: 'call-1' }
      },
      {
        timestamp: '2026-05-23T10:00:03.000Z',
        type: 'response_item',
        payload: { type: 'reasoning', summary: [] }
      },
      {
        timestamp: '2026-05-23T10:00:04.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done' }] }
      }
    ]
    writeFileSync(jsonlPath, entries.map((entry) => JSON.stringify(entry)).join('\n'))

    const messages = (impl as any).parseThreadSnapshot(
      {
        thread: {
          path: jsonlPath,
          turns: [
            {
              id: 'turn-1',
              startedAt: 1779530400,
              items: [
                {
                  type: 'userMessage',
                  content: [{ type: 'text', text: 'Run it' }]
                },
                { type: 'agentMessage', id: 'item-2', text: 'Intro' },
                { type: 'commandExecution', id: 'call-1' },
                { type: 'reasoning', summary: [], content: [] },
                { type: 'agentMessage', id: 'item-5', text: 'Done' }
              ]
            }
          ]
        }
      },
      new Map()
    )

    expect(messages.map((message: any) => [message.id, message.timestamp])).toEqual([
      ['turn-1:user', '2026-05-23T10:00:00.010Z'],
      ['turn-1:assistant', '2026-05-23T10:00:01.000Z'],
      ['turn-1:assistant:item-5', '2026-05-23T10:00:04.000Z']
    ])
  })

  it('matches JSONL assistant timestamps by text when thread/read omits tool items', () => {
    const impl = new CodexImplementer()
    const dir = mkdtempSync(join(tmpdir(), 'xuanpu-codex-jsonl-summary-'))
    const jsonlPath = join(dir, 'rollout.jsonl')
    const entries = [
      {
        timestamp: '2026-05-23T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' }
      },
      {
        timestamp: '2026-05-23T10:00:00.010Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Run it' }
      },
      {
        timestamp: '2026-05-23T10:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ text: 'Intro' }] }
      },
      {
        timestamp: '2026-05-23T10:00:02.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell_command', call_id: 'call-1' }
      },
      {
        timestamp: '2026-05-23T10:00:03.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-1', output: 'ok' }
      },
      {
        timestamp: '2026-05-23T10:00:04.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ text: 'Done' }] }
      }
    ]
    writeFileSync(jsonlPath, entries.map((entry) => JSON.stringify(entry)).join('\n'))

    const messages = (impl as any).parseThreadSnapshot(
      {
        thread: {
          path: jsonlPath,
          turns: [
            {
              id: 'turn-1',
              startedAt: 1779530400,
              // App-server can return a summarized item view here. The JSONL
              // still has tool response_items between the assistant texts.
              items: [
                {
                  type: 'userMessage',
                  content: [{ type: 'text', text: 'Run it' }]
                },
                { type: 'agentMessage', id: 'item-2', text: 'Intro' },
                { type: 'agentMessage', id: 'item-3', text: 'Done' }
              ]
            }
          ]
        }
      },
      new Map()
    )

    expect(messages.map((message: any) => [message.id, message.timestamp])).toEqual([
      ['turn-1:user', '2026-05-23T10:00:00.010Z'],
      ['turn-1:assistant', '2026-05-23T10:00:01.000Z'],
      ['turn-1:assistant:item-3', '2026-05-23T10:00:04.000Z']
    ])
  })

  it('matches final assistant JSONL timestamps after memory citation stripping', () => {
    const impl = new CodexImplementer()
    const dir = mkdtempSync(join(tmpdir(), 'xuanpu-codex-jsonl-citation-'))
    const jsonlPath = join(dir, 'rollout.jsonl')
    const finalText = 'Final answer with enough body text to avoid short fuzzy collisions. '.repeat(3)
    const finalWithCitation = `${finalText}

<oai-mem-citation>
<citation_entries>
MEMORY.md:1-2|note=[test]
</citation_entries>
<rollout_ids>
</rollout_ids>
</oai-mem-citation>`
    const entries = [
      {
        timestamp: '2026-05-25T03:09:04.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' }
      },
      {
        timestamp: '2026-05-25T03:09:04.559Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Question' }
      },
      {
        timestamp: '2026-05-25T03:09:17.944Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ text: 'Progress update' }] }
      },
      {
        timestamp: '2026-05-25T03:10:33.849Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ text: finalWithCitation }] }
      }
    ]
    writeFileSync(jsonlPath, entries.map((entry) => JSON.stringify(entry)).join('\n'))

    const messages = (impl as any).parseThreadSnapshot(
      {
        thread: {
          path: jsonlPath,
          turns: [
            {
              id: 'turn-1',
              startedAt: 1779678544,
              items: [
                {
                  type: 'userMessage',
                  content: [{ type: 'text', text: 'Question' }]
                },
                { type: 'agentMessage', id: 'item-2', text: 'Progress update' },
                { type: 'agentMessage', id: 'item-3', text: finalText }
              ]
            }
          ]
        }
      },
      new Map()
    )

    expect(messages.map((message: any) => [message.id, message.timestamp])).toEqual([
      ['turn-1:user', '2026-05-25T03:09:04.559Z'],
      ['turn-1:assistant', '2026-05-25T03:09:17.944Z'],
      ['turn-1:assistant:item-3', '2026-05-25T03:10:33.849Z']
    ])
  })
})
