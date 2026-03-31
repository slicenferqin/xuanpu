/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../../src/main/services/codex-session-title', () => ({
  generateCodexSessionTitle: vi.fn().mockResolvedValue(null)
}))

vi.mock('../../../src/main/services/git-service', () => ({
  autoRenameWorktreeBranch: vi.fn().mockResolvedValue({ success: true })
}))

let eventListeners: Array<(event: any) => void> = []

vi.mock('../../../src/main/services/codex-app-server-manager', () => {
  const MockManager = vi.fn().mockImplementation(() => ({
    startSession: vi.fn(),
    stopSession: vi.fn(),
    stopAll: vi.fn(),
    hasSession: vi.fn().mockReturnValue(false),
    getSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    sendTurn: vi.fn(),
    readThread: vi.fn(),
    on: vi.fn().mockImplementation((_event: string, handler: any) => {
      eventListeners.push(handler)
    }),
    emit: vi.fn(),
    removeListener: vi.fn().mockImplementation((_event: string, handler: any) => {
      eventListeners = eventListeners.filter((listener) => listener !== handler)
    }),
    removeAllListeners: vi.fn()
  }))

  return {
    CodexAppServerManager: MockManager
  }
})

import {
  CodexImplementer,
  type CodexSessionState
} from '../../../src/main/services/codex-implementer'

describe('Codex canonical transcript smoke', () => {
  let impl: CodexImplementer
  let mockManager: any

  beforeEach(() => {
    vi.clearAllMocks()
    eventListeners = []
    impl = new CodexImplementer()
    mockManager = impl.getManager()
    impl.setMainWindow({
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    } as any)
  })

  function seedSession(): CodexSessionState {
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
      titleGenerationStarted: false
    }
    impl.getSessions().set('/test/project::thread-1', session)
    return session
  }

  it('collapses a completed Codex turn into canonical user and assistant transcript rows', async () => {
    seedSession()

    mockManager.readThread.mockResolvedValue({
      thread: {
        id: 'thread-1',
        turns: [
          {
            id: 'turn-1',
            createdAt: '2026-03-31T09:00:00.000Z',
            updatedAt: '2026-03-31T09:00:10.000Z',
            items: [
              {
                type: 'userMessage',
                id: 'user-1',
                content: [{ type: 'text', text: 'Inspect the repo' }]
              },
              {
                type: 'reasoning',
                id: 'reasoning-1',
                summary: ['Reasoning summary'],
                content: ['Reasoning detail']
              },
              {
                type: 'commandExecution',
                id: 'tool-1',
                toolName: 'bash',
                status: 'completed',
                input: { command: ['pnpm', 'test'] },
                output: 'ok'
              },
              {
                type: 'agentMessage',
                id: 'assistant-1',
                text: 'Canonical plan reply'
              }
            ]
          }
        ]
      }
    })

    mockManager.sendTurn.mockImplementation(async () => {
      setTimeout(() => {
        for (const listener of [...eventListeners]) {
          listener({
            id: 'e-reasoning',
            kind: 'notification',
            provider: 'codex',
            threadId: 'thread-1',
            createdAt: new Date().toISOString(),
            method: 'item/reasoning/textDelta',
            payload: { text: 'Reasoning detail' }
          })
          listener({
            id: 'e-tool',
            kind: 'notification',
            provider: 'codex',
            threadId: 'thread-1',
            createdAt: new Date().toISOString(),
            method: 'item.completed',
            payload: {
              item: {
                type: 'commandExecution',
                id: 'tool-1',
                toolName: 'bash',
                status: 'completed',
                input: { command: ['pnpm', 'test'] },
                output: 'ok'
              }
            }
          })
          listener({
            id: 'e-assistant',
            kind: 'notification',
            provider: 'codex',
            threadId: 'thread-1',
            createdAt: new Date().toISOString(),
            method: 'item/agentMessage/delta',
            textDelta: 'Canonical plan reply',
            payload: { delta: 'Canonical plan reply' }
          })
          listener({
            id: 'e-done',
            kind: 'notification',
            provider: 'codex',
            threadId: 'thread-1',
            createdAt: new Date().toISOString(),
            method: 'turn/completed',
            payload: { turn: { id: 'turn-1', status: 'completed' } }
          })
        }
      }, 0)

      return { turnId: 'turn-1', threadId: 'thread-1' }
    })

    await impl.prompt('/test/project', 'thread-1', 'Inspect the repo')

    const messages = (await impl.getMessages('/test/project', 'thread-1')) as Array<any>

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(messages[0]?.id).toBe('turn-1:user')
    expect(messages[1]?.id).toBe('turn-1:assistant')
    expect(
      messages[1]?.parts?.map((part: any) => (part.type === 'tool' ? 'tool_use' : part.type))
    ).toEqual(['reasoning', 'tool_use', 'text'])
    expect(messages[1]?.parts?.[0]).toMatchObject({
      type: 'reasoning',
      text: 'Reasoning summary\nReasoning detail'
    })
    expect(messages[1]?.parts?.[1]).toMatchObject({
      type: 'tool',
      callID: 'tool-1',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: ['pnpm', 'test'] },
        output: 'ok'
      }
    })
    expect(messages[1]?.parts?.[2]).toMatchObject({
      type: 'text',
      text: 'Canonical plan reply'
    })
  })
})
