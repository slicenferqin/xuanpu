/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  Notification: vi.fn().mockImplementation(() => ({
    show: vi.fn(),
    on: vi.fn()
  })),
  app: {
    getName: vi.fn(() => 'Xuanpu'),
    getPath: vi.fn(() => '/tmp'),
    getAppPath: vi.fn(() => '/tmp'),
    dock: { setBadge: vi.fn() }
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

vi.mock('../../../src/main/services/codex-config', () => ({
  getCodexConfiguredModel: vi.fn(() => undefined),
  getCodexConfiguredContextWindow: vi.fn(() => undefined)
}))

import {
  CodexImplementer,
  type CodexSessionState
} from '../../../src/main/services/codex-implementer'
import { createCodexMapperState } from '../../../src/main/services/codex-event-mapper'
import { CODEX_CAPABILITIES } from '../../../src/main/services/agent-runtime-types'
import { CODEX_DEFAULT_MODEL } from '../../../src/main/services/codex-models'

describe('CodexImplementer skeleton', () => {
  let impl: CodexImplementer

  beforeEach(() => {
    impl = new CodexImplementer()
  })

  // ── Identity & capabilities ────────────────────────────────────

  describe('identity', () => {
    it('has id "codex"', () => {
      expect(impl.id).toBe('codex')
    })

    it('has CODEX_CAPABILITIES', () => {
      expect(impl.capabilities).toEqual(CODEX_CAPABILITIES)
    })

    it('supportsUndo is true', () => {
      expect(impl.capabilities.supportsUndo).toBe(true)
    })

    it('supportsRedo is false', () => {
      expect(impl.capabilities.supportsRedo).toBe(false)
    })

    it('supportsCommands is true', () => {
      expect(impl.capabilities.supportsCommands).toBe(true)
    })

    it('supportsModelSelection is true', () => {
      expect(impl.capabilities.supportsModelSelection).toBe(true)
    })
  })

  // ── Model methods (implemented) ────────────────────────────────

  describe('getAvailableModels', () => {
    it('returns array with codex provider', async () => {
      const result = (await impl.getAvailableModels()) as any[]
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('codex')
    })

    it('provider contains all 5 models', async () => {
      const result = (await impl.getAvailableModels()) as any[]
      const models = result[0].models
      expect(Object.keys(models)).toHaveLength(5)
    })
  })

  describe('getModelInfo', () => {
    it('returns info for a known model', async () => {
      const info = await impl.getModelInfo('/path', 'gpt-5.4')
      expect(info).not.toBeNull()
      expect(info!.id).toBe('gpt-5.4')
      expect(info!.name).toBe('GPT-5.4')
    })

    it('returns null for unknown model', async () => {
      const info = await impl.getModelInfo('/path', 'unknown')
      expect(info).toBeNull()
    })
  })

  // ── setSelectedModel ───────────────────────────────────────────

  describe('setSelectedModel', () => {
    it('stores the model selection', () => {
      impl.setSelectedModel({ providerID: 'codex', modelID: 'gpt-5.3-codex' })
      expect(impl.getSelectedModel()).toBe('gpt-5.3-codex')
    })

    it('stores the variant selection', () => {
      impl.setSelectedModel({ providerID: 'codex', modelID: 'gpt-5.4', variant: 'xhigh' })
      expect(impl.getSelectedVariant()).toBe('xhigh')
    })

    it('defaults to gpt-5.4 before any selection', () => {
      expect(impl.getSelectedModel()).toBe(CODEX_DEFAULT_MODEL)
    })
  })

  // ── setMainWindow ──────────────────────────────────────────────

  describe('setMainWindow', () => {
    it('stores the window reference', () => {
      const mockWindow = { webContents: { send: vi.fn() } } as any
      impl.setMainWindow(mockWindow)
      expect(impl.getMainWindow()).toBe(mockWindow)
    })
  })

  // ── cleanup ────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('clears mainWindow', async () => {
      const mockWindow = { webContents: { send: vi.fn() } } as any
      impl.setMainWindow(mockWindow)

      await impl.cleanup()
      expect(impl.getMainWindow()).toBeNull()
    })

    it('resets selected model to default', async () => {
      impl.setSelectedModel({ providerID: 'codex', modelID: 'gpt-5.3-codex', variant: 'low' })

      await impl.cleanup()
      expect(impl.getSelectedModel()).toBe(CODEX_DEFAULT_MODEL)
      expect(impl.getSelectedVariant()).toBeUndefined()
    })

    it('does not throw', async () => {
      await expect(impl.cleanup()).resolves.toBeUndefined()
    })
  })

  // ── Unimplemented lifecycle methods throw ──────────────────────

  describe('lifecycle methods are implemented (session 4)', () => {
    it('connect is a function', () => {
      expect(typeof impl.connect).toBe('function')
    })

    it('reconnect is a function', () => {
      expect(typeof impl.reconnect).toBe('function')
    })

    it('disconnect is a function', () => {
      expect(typeof impl.disconnect).toBe('function')
    })
  })

  // ── Unimplemented messaging methods throw ──────────────────────

  describe('implemented messaging methods', () => {
    it('prompt throws when session not found', async () => {
      await expect(impl.prompt('/path', 'session-1', 'hello')).rejects.toThrow('session not found')
    })

    it('abort returns false for unknown session', async () => {
      const result = await impl.abort('/path', 'session-1')
      expect(result).toBe(false)
    })

    it('getMessages returns empty array for unknown session', async () => {
      const messages = await impl.getMessages('/path', 'session-1')
      expect(messages).toEqual([])
    })
  })

  // ── Unimplemented session info methods throw ───────────────────

  describe('implemented session info methods', () => {
    it('getSessionInfo returns null/null for unknown session', async () => {
      const result = await impl.getSessionInfo('/path', 'session-1')
      expect(result.revertMessageID).toBeNull()
      expect(result.revertDiff).toBeNull()
    })

    it('renameSession does not throw without dbService', async () => {
      await expect(impl.renameSession('/path', 'session-1', 'new name')).resolves.not.toThrow()
    })
  })

  // ── Implemented human-in-the-loop methods ──────────────────────

  describe('implemented human-in-the-loop methods handle missing requests', () => {
    it('questionReply throws for unknown requestId', async () => {
      await expect(impl.questionReply('req-1', [['answer']])).rejects.toThrow(
        'No pending question found for requestId: req-1'
      )
    })

    it('questionReject throws for unknown requestId', async () => {
      await expect(impl.questionReject('req-1')).rejects.toThrow(
        'No pending question found for requestId: req-1'
      )
    })

    it('permissionReply throws for unknown requestId', async () => {
      await expect(impl.permissionReply('req-1', 'once')).rejects.toThrow(
        'No pending approval found for requestId: req-1'
      )
    })

    it('permissionList returns empty array with no sessions', async () => {
      const result = await impl.permissionList()
      expect(result).toEqual([])
    })
  })

  describe('steer', () => {
    it('throws when there is no active Codex turn', async () => {
      ;(impl as any).sessions.set('/worktree::thread-1', {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/worktree',
        status: 'running',
        messages: [],
        liveAssistantDraft: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: true,
        titleGenerationStarted: true
      })
      ;(impl as any).manager = {
        getSession: vi.fn().mockReturnValue({ activeTurnId: null }),
        steerTurn: vi.fn()
      }

      await expect(impl.steer('/worktree', 'thread-1', 'redirect')).rejects.toThrow(
        'Steer is unavailable because there is no active Codex turn'
      )
    })

    it('rejects attachments because steer is text-only', async () => {
      ;(impl as any).sessions.set('/worktree::thread-1', {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/worktree',
        status: 'running',
        messages: [],
        liveAssistantDraft: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: true,
        titleGenerationStarted: true
      })

      await expect(
        impl.steer('/worktree', 'thread-1', [
          { type: 'text', text: 'redirect' },
          { type: 'file', mime: 'image/png', url: 'data:image/png;base64,abc', filename: 'a.png' }
        ])
      ).rejects.toThrow('Steer only supports text messages')
    })

    it('calls manager.steerTurn and persists a steered user message', async () => {
      const replaceSessionMessages = vi.fn()
      impl.setDatabaseService({
        replaceSessionMessages
      } as any)

      const session = {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/worktree',
        status: 'running',
        messages: [],
        liveAssistantDraft: null,
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: true,
        titleGenerationStarted: true
      }
      ;(impl as any).sessions.set('/worktree::thread-1', session)

      const steerTurn = vi.fn().mockResolvedValue(undefined)
      ;(impl as any).manager = {
        getSession: vi.fn().mockReturnValue({ activeTurnId: 'turn-1' }),
        steerTurn
      }

      await impl.steer('/worktree', 'thread-1', 'redirect the task')

      expect(steerTurn).toHaveBeenCalledWith('thread-1', { text: 'redirect the task' }, 'turn-1')
      expect(session.messages).toHaveLength(1)
      expect(session.messages[0]).toMatchObject({
        role: 'user',
        steered: true,
        parts: [{ type: 'text', text: 'redirect the task' }]
      })
      expect(replaceSessionMessages).toHaveBeenCalledTimes(1)
    })
  })

  describe('turn timeout handling', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('times out after the budget when there is no pending HITL request', async () => {
      ;(impl as any).manager = new EventEmitter()
      const session = {
        threadId: 'thread-1',
        activeRun: { runId: 'run-1', expectedTurnId: null }
      }

      const promise = (impl as any).waitForTurnCompletion(session, {
        runId: 'run-1',
        isComplete: () => false,
        timeoutMs: 1000
      }) as Promise<void>

      const outcome = promise.then(
        () => 'resolved',
        (error) => error
      )

      await vi.advanceTimersByTimeAsync(1000)

      const error = await outcome
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('Turn timed out')
    })

    it('treats streaming events as progress and resets the inactivity timeout', async () => {
      const manager = new EventEmitter()
      ;(impl as any).manager = manager
      const session = {
        threadId: 'thread-1',
        activeRun: { runId: 'run-1', expectedTurnId: 'turn-1' }
      }

      const promise = (impl as any).waitForTurnCompletion(session, {
        runId: 'run-1',
        expectedTurnId: 'turn-1',
        isComplete: () => false,
        timeoutMs: 1000
      }) as Promise<'completed' | 'interrupted'>

      let settled = false
      void promise.finally(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(900)
      manager.emit('event', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        method: 'item/agentMessage/delta',
        payload: { delta: 'still running' }
      })

      await vi.advanceTimersByTimeAsync(900)
      expect(settled).toBe(false)

      manager.emit('event', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        method: 'item/commandExecution/outputDelta',
        payload: { delta: 'more output' }
      })

      await vi.advanceTimersByTimeAsync(999)
      expect(settled).toBe(false)

      manager.emit('event', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        method: 'turn/completed',
        payload: { turn: { id: 'turn-1', status: 'completed' } }
      })

      await expect(promise).resolves.toBe('completed')
    })

    it('pauses timeout consumption while HITL is pending and resumes with the remaining budget', async () => {
      const manager = new EventEmitter()
      ;(impl as any).manager = manager
      const session = {
        threadId: 'thread-1',
        activeRun: { runId: 'run-1', expectedTurnId: null }
      }

      const promise = (impl as any).waitForTurnCompletion(session, {
        runId: 'run-1',
        isComplete: () => false,
        timeoutMs: 1000
      }) as Promise<void>
      const outcome = promise.then(
        () => 'resolved',
        (error) => error
      )

      let settled = false
      void outcome.finally(() => {
        settled = true
      })

      await vi.advanceTimersByTimeAsync(400)
      impl.getPendingQuestions().set('req-1', {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/tmp/project'
      })
      manager.emit('event', {
        threadId: 'thread-1',
        kind: 'request',
        method: 'question.asked'
      })

      await vi.advanceTimersByTimeAsync(5000)
      expect(settled).toBe(false)

      impl.getPendingQuestions().clear()
      manager.emit('event', {
        threadId: 'thread-1',
        method: 'item/tool/requestUserInput/answered'
      })

      await vi.advanceTimersByTimeAsync(599)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      const error = await outcome
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('Turn timed out')
    })
  })

  // ── Unimplemented undo/redo methods throw ──────────────────────

  describe('undo/redo methods', () => {
    it('undo throws for unknown session', async () => {
      await expect(impl.undo('/path', 'session-1', 'hive-1')).rejects.toThrow('session not found')
    })

    it('redo throws unsupported', async () => {
      await expect(impl.redo('/path', 'session-1', 'hive-1')).rejects.toThrow(
        'Redo is not supported for Codex sessions'
      )
    })
  })

  // ── Codex skill commands ───────────────────────────────────────

  describe('Codex skill commands', () => {
    function seedCodexSession(overrides: Partial<CodexSessionState> = {}): CodexSessionState {
      const session: CodexSessionState = {
        threadId: 'thread-1',
        hiveSessionId: 'hive-1',
        worktreePath: '/path',
        status: 'ready',
        messages: [],
        liveAssistantDraft: null,
        activeRun: null,
        settledRunIds: new Set(),
        revertMessageID: null,
        revertDiff: null,
        titleGenerated: false,
        titleGenerationStarted: false,
        tokenUsageCostByEvent: new Map(),
        mapperState: createCodexMapperState(),
        itemTimestampsByTurn: new Map(),
        recordedItemIdsByTurn: new Map(),
        ...overrides
      }
      impl.getSessions().set(`${session.worktreePath}::${session.threadId}`, session)
      return session
    }

    it('returns no commands when no Codex session is active for the worktree', async () => {
      await expect(impl.listCommands('/path')).resolves.toEqual([])
    })

    it('maps enabled skills/list metadata to slash commands and caches paths', async () => {
      seedCodexSession()
      const manager = {
        listSkills: vi.fn().mockResolvedValue({
          data: [
            {
              cwd: '/path',
              skills: [
                {
                  name: 'brainstorming',
                  description: 'Full description',
                  interface: {
                    shortDescription: 'Explore requirements',
                    defaultPrompt: '  design this  '
                  },
                  path: '/skills/brainstorming/SKILL.md',
                  scope: 'user',
                  enabled: true
                },
                {
                  name: 'disabled-skill',
                  description: 'Disabled',
                  path: '/skills/disabled/SKILL.md',
                  enabled: false
                },
                {
                  name: 'missing-path',
                  enabled: true
                }
              ],
              errors: [{ message: 'bad repo skill' }]
            }
          ]
        })
      }
      ;(impl as any).manager = manager

      const commands = (await impl.listCommands('/path')) as any[]

      expect(manager.listSkills).toHaveBeenCalledWith('thread-1', '/path')
      expect(commands).toEqual([
        expect.objectContaining({
          name: 'brainstorming',
          description: 'Explore requirements',
          template: '/brainstorming design this ',
          source: 'skill',
          path: '/skills/brainstorming/SKILL.md',
          scope: 'user',
          enabled: true
        })
      ])
    })

    it('prefers exact skills/list cwd matches over fallback flattening', async () => {
      seedCodexSession()
      const manager = {
        listSkills: vi.fn().mockResolvedValue({
          data: [
            {
              cwd: '/other',
              skills: [
                {
                  name: 'other-skill',
                  path: '/skills/other/SKILL.md',
                  enabled: true
                }
              ]
            },
            {
              cwd: '/path',
              skills: [
                {
                  name: 'exact-skill',
                  path: '/skills/exact/SKILL.md',
                  enabled: true
                }
              ]
            }
          ]
        })
      }
      ;(impl as any).manager = manager

      const commands = (await impl.listCommands('/path')) as any[]

      expect(commands.find((command) => command.name === 'exact-skill')).toBeDefined()
      expect(commands.find((command) => command.name === 'other-skill')).toBeUndefined()
    })

    it('clears cached skills when skills/list fails after a previous successful fetch', async () => {
      seedCodexSession()
      const manager = {
        listSkills: vi
          .fn()
          .mockResolvedValueOnce({
            data: [
              {
                cwd: '/path',
                skills: [
                  {
                    name: 'imagegen',
                    path: '/skills/imagegen/SKILL.md',
                    enabled: true
                  }
                ]
              }
            ]
          })
          .mockRejectedValueOnce(new Error('protocol unavailable'))
      }
      ;(impl as any).manager = manager

      await expect(impl.listCommands('/path')).resolves.toEqual([
        expect.objectContaining({ name: 'imagegen' })
      ])
      await expect(impl.listCommands('/path')).resolves.toEqual([])

      await expect(impl.sendCommand('/path', 'thread-1', 'imagegen', 'a poster')).rejects.toThrow(
        'Unsupported Codex command: /imagegen'
      )
    })

    it('emits commands_available and refreshes cached skills before dispatch after skills/changed', async () => {
      const session = seedCodexSession()
      const manager = new EventEmitter() as any
      manager.listSkills = vi.fn().mockResolvedValue({
        data: [
          {
            cwd: '/path',
            skills: [{ name: 'imagegen', path: '/skills/imagegen/SKILL.md', enabled: true }]
          }
        ]
      })
      manager.sendTurn = vi.fn(async () => {
        setTimeout(() => {
          manager.emit('event', {
            id: 'event-1',
            kind: 'notification',
            provider: 'codex',
            threadId: 'thread-1',
            turnId: 'turn-skill',
            createdAt: new Date().toISOString(),
            method: 'turn/completed',
            payload: { turn: { id: 'turn-skill', status: 'completed' } }
          })
        }, 0)
        return { turnId: 'turn-skill', threadId: 'thread-1' }
      })
      manager.readThread = vi.fn().mockResolvedValue({
        thread: {
          id: 'thread-1',
          turns: [
            {
              id: 'turn-skill',
              items: [
                {
                  type: 'userMessage',
                  content: [{ type: 'text', text: '/imagegen a poster' }]
                },
                { type: 'agentMessage', text: 'done' }
              ]
            }
          ]
        }
      })
      manager.getSession = vi.fn().mockReturnValue({ activeTurnId: 'turn-skill' })
      manager.removeListener = manager.off.bind(manager)
      ;(impl as any).manager = manager
      const mockWindow = {
        isDestroyed: () => false,
        webContents: { send: vi.fn() }
      }
      impl.setMainWindow(mockWindow as any)

      await impl.listCommands('/path')
      ;(impl as any).handleManagerEvent({
        id: 'skills-changed-1',
        kind: 'notification',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: new Date().toISOString(),
        method: 'skills/changed',
        payload: {}
      })

      await impl.sendCommand('/path', 'thread-1', 'imagegen', 'a poster')

      expect(manager.listSkills).toHaveBeenCalledTimes(2)
      expect(manager.sendTurn).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({
          input: [
            { type: 'skill', name: 'imagegen', path: '/skills/imagegen/SKILL.md' },
            { type: 'text', text: 'a poster', text_elements: [] }
          ]
        })
      )
      expect(session.status).toBe('ready')
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'agent:stream',
        expect.objectContaining({
          type: 'session.commands_available',
          sessionId: 'hive-1'
        })
      )
    })

    it('sends cached skill commands as structured Codex input through the turn lifecycle', async () => {
      const session = seedCodexSession()
      const manager = new EventEmitter() as any
      manager.listSkills = vi.fn().mockResolvedValue({
        data: [
          {
            cwd: '/path',
            skills: [
              {
                name: 'imagegen',
                description: 'Generate an image',
                path: '/skills/imagegen/SKILL.md',
                scope: 'system',
                enabled: true
              }
            ]
          }
        ]
      })
      manager.sendTurn = vi.fn(async () => {
        setTimeout(() => {
          manager.emit('event', {
            id: 'event-1',
            kind: 'notification',
            provider: 'codex',
            threadId: 'thread-1',
            turnId: 'turn-skill',
            createdAt: new Date().toISOString(),
            method: 'turn/completed',
            payload: { turn: { id: 'turn-skill', status: 'completed' } }
          })
        }, 0)
        return { turnId: 'turn-skill', threadId: 'thread-1' }
      })
      manager.readThread = vi.fn().mockResolvedValue({
        thread: {
          id: 'thread-1',
          turns: [
            {
              id: 'turn-skill',
              items: [
                {
                  type: 'userMessage',
                  content: [{ type: 'text', text: '/imagegen a clean product mockup' }]
                },
                { type: 'agentMessage', text: 'done' }
              ]
            }
          ]
        }
      })
      manager.getSession = vi.fn().mockReturnValue({ activeTurnId: 'turn-skill' })
      manager.removeListener = manager.off.bind(manager)
      ;(impl as any).manager = manager

      await impl.listCommands('/path')
      await impl.sendCommand('/path', 'thread-1', 'imagegen', 'a clean product mockup')

      expect(manager.sendTurn).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({
          input: [
            { type: 'skill', name: 'imagegen', path: '/skills/imagegen/SKILL.md' },
            { type: 'text', text: 'a clean product mockup', text_elements: [] }
          ],
          model: expect.any(String)
        })
      )
      expect(session.status).toBe('ready')
      expect(session.activeRun).toBeNull()
      expect(session.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user' }),
          expect.objectContaining({ role: 'assistant' })
        ])
      )
    })
  })

  // ── Implements AgentSdkImplementer interface ───────────────────

  describe('interface compliance', () => {
    it('has all required methods', () => {
      const requiredMethods = [
        'connect',
        'reconnect',
        'disconnect',
        'cleanup',
        'prompt',
        'abort',
        'getMessages',
        'getAvailableModels',
        'getModelInfo',
        'setSelectedModel',
        'getSessionInfo',
        'questionReply',
        'questionReject',
        'permissionReply',
        'permissionList',
        'undo',
        'redo',
        'listCommands',
        'sendCommand',
        'renameSession',
        'setMainWindow'
      ]

      for (const method of requiredMethods) {
        expect(typeof (impl as any)[method]).toBe('function')
      }
    })

    it('has id property set to codex', () => {
      expect(impl.id).toBe('codex')
    })

    it('has readonly capabilities property', () => {
      expect(impl.capabilities).toBeDefined()
    })
  })
})
