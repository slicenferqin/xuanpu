/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeAdapter } from '../../src/main/services/agent-runtime-types'
import type { AgentRuntimeManager } from '../../src/main/services/agent-runtime-manager'

const {
  handlers,
  mockBuildFieldContextSnapshot,
  mockFormatFieldContext,
  mockCacheLastInjection,
  mockEmitFieldEvent
} = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  mockBuildFieldContextSnapshot: vi.fn(),
  mockFormatFieldContext: vi.fn(),
  mockCacheLastInjection: vi.fn(),
  mockEmitFieldEvent: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler)
    })
  },
  BrowserWindow: vi.fn()
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../src/main/services/opencode-service', () => ({
  openCodeService: {
    setMainWindow: vi.fn()
  }
}))

vi.mock('../../src/main/services/telemetry-service', () => ({
  telemetryService: {
    track: vi.fn()
  }
}))

vi.mock('../../src/main/services/claude-code-implementer', () => ({
  ClaudeCodeImplementer: vi.fn()
}))

vi.mock('../../src/main/field/privacy', () => ({
  isFieldCollectionEnabled: vi.fn(() => true)
}))

vi.mock('../../src/main/field/context-builder', () => ({
  buildFieldContextSnapshot: mockBuildFieldContextSnapshot
}))

vi.mock('../../src/main/field/context-formatter', () => ({
  formatFieldContext: mockFormatFieldContext
}))

vi.mock('../../src/main/field/last-injection-cache', () => ({
  cacheLastInjection: mockCacheLastInjection
}))

vi.mock('../../src/main/field/emit', () => ({
  emitFieldEvent: mockEmitFieldEvent
}))

vi.mock('../../src/main/field/checkpoint-hooks', () => ({
  recordCheckpointOnAbort: vi.fn()
}))

import { registerAgentHandlers } from '../../src/main/ipc/agent-handlers'
import { __resetXfpAuditForTest, listXfpAuditEvents } from '../../src/main/xfp/audit'

function createAdapter(id: AgentRuntimeAdapter['id']): AgentRuntimeAdapter {
  return {
    id,
    capabilities: {
      supportsUndo: true,
      supportsRedo: true,
      supportsSteer: true,
      supportsCommands: true,
      supportsPermissionRequests: true,
      supportsQuestionPrompts: true,
      supportsModelSelection: true,
      supportsReconnect: true,
      supportsPartialStreaming: true
    },
    connect: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    cleanup: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([]),
    getAvailableModels: vi.fn().mockResolvedValue([]),
    getModelInfo: vi.fn().mockResolvedValue(null),
    setSelectedModel: vi.fn(),
    getSessionInfo: vi.fn().mockResolvedValue({ revertMessageID: null, revertDiff: null }),
    questionReply: vi.fn(),
    questionReject: vi.fn(),
    permissionReply: vi.fn(),
    permissionList: vi.fn().mockResolvedValue([]),
    undo: vi.fn(),
    redo: vi.fn(),
    listCommands: vi.fn().mockResolvedValue([]),
    sendCommand: vi.fn(),
    renameSession: vi.fn(),
    setMainWindow: vi.fn()
  }
}

function createRuntimeManager(adapters: Record<string, AgentRuntimeAdapter>): AgentRuntimeManager {
  return {
    setMainWindow: vi.fn(),
    getImplementer: vi.fn((id: string) => adapters[id]),
    getCapabilities: vi.fn(),
    cleanupAll: vi.fn()
  } as unknown as AgentRuntimeManager
}

function createDbService(runtimeId: AgentRuntimeAdapter['id']) {
  return {
    getRuntimeIdForSession: vi.fn().mockReturnValue(runtimeId),
    getWorktreeByPath: vi.fn().mockReturnValue({
      id: 'wt-1',
      project_id: 'p-1',
      path: '/repo',
      name: 'repo',
      branch: 'main'
    }),
    getSessionByOpenCodeSessionId: vi.fn().mockReturnValue({ id: 'hive-1' })
  }
}

describe('agent:prompt XFP injection policy', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    __resetXfpAuditForTest()
    mockBuildFieldContextSnapshot.mockResolvedValue({ snapshot: true })
    mockFormatFieldContext.mockReturnValue({
      markdown: '[Field Context]\n## Current Focus\n- File: src/main.ts',
      approxTokens: 18,
      wasTruncated: false
    })
  })

  it.each(['claude-code', 'codex'] as const)(
    'does not prepend full Field Context for %s prompts',
    async (runtimeId) => {
      const adapter = createAdapter(runtimeId)
      const runtimeManager = createRuntimeManager({ [runtimeId]: adapter })
      const dbService = createDbService(runtimeId)
      const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

      registerAgentHandlers(mainWindow, runtimeManager, dbService as any)

      const handler = handlers.get('agent:prompt')!
      const result = await handler(
        {},
        {
          worktreePath: '/repo',
          sessionId: `${runtimeId}-session`,
          parts: [{ type: 'text', text: '这里为什么挂？' }]
        }
      )

      expect(result).toEqual({ success: true })
      expect(mockBuildFieldContextSnapshot).not.toHaveBeenCalled()
      expect(adapter.prompt).toHaveBeenCalledWith(
        '/repo',
        `${runtimeId}-session`,
        [{ type: 'text', text: '这里为什么挂？' }],
        undefined,
        { originalMessage: [{ type: 'text', text: '这里为什么挂？' }] }
      )
      expect(listXfpAuditEvents()).toEqual([])
    }
  )

  it.each(['opencode'] as const)(
    'keeps legacy Field Context injection for %s until it has XFP tools',
    async (runtimeId) => {
      const adapter = createAdapter(runtimeId)
      const runtimeManager = createRuntimeManager({ [runtimeId]: adapter })
      const dbService = createDbService(runtimeId)
      const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

      registerAgentHandlers(mainWindow, runtimeManager, dbService as any)

      const handler = handlers.get('agent:prompt')!
      const result = await handler(
        {},
        {
          worktreePath: '/repo',
          sessionId: `${runtimeId}-session`,
          parts: [{ type: 'text', text: '这里为什么挂？' }]
        }
      )

      expect(result).toEqual({ success: true })
      expect(mockBuildFieldContextSnapshot).toHaveBeenCalledWith({ worktreeId: 'wt-1' })
      expect(adapter.prompt).toHaveBeenCalledWith(
        '/repo',
        `${runtimeId}-session`,
        [
          {
            type: 'text',
            text: '[Field Context]\n## Current Focus\n- File: src/main.ts\n\n[User Message]\n这里为什么挂？'
          }
        ],
        undefined,
        { originalMessage: [{ type: 'text', text: '这里为什么挂？' }] }
      )
      expect(listXfpAuditEvents()).toMatchObject([
        {
          worktreeId: 'wt-1',
          sessionId: 'hive-1',
          runtimeId: 'opencode',
          kind: 'prompt',
          toolName: 'field_delivery',
          input: expect.objectContaining({
            mode: 'legacy-injection',
            hasFieldContextEnvelope: true,
            hasXfpFallbackPrefix: false
          })
        }
      ])
    }
  )

  it.each(['codex', 'opencode'] as const)(
    'keeps slash-command injection bypass for %s',
    async (runtimeId) => {
      const adapter = createAdapter(runtimeId)
      const runtimeManager = createRuntimeManager({ [runtimeId]: adapter })
      const dbService = createDbService(runtimeId)
      const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

      registerAgentHandlers(mainWindow, runtimeManager, dbService as any)

      const handler = handlers.get('agent:prompt')!
      const result = await handler(
        {},
        {
          worktreePath: '/repo',
          sessionId: `${runtimeId}-session`,
          parts: [{ type: 'text', text: '/compact' }]
        }
      )

      expect(result).toEqual({ success: true })
      expect(mockBuildFieldContextSnapshot).not.toHaveBeenCalled()
      expect(adapter.prompt).toHaveBeenCalledWith(
        '/repo',
        `${runtimeId}-session`,
        [{ type: 'text', text: '/compact' }],
        undefined,
        { originalMessage: [{ type: 'text', text: '/compact' }] }
      )
      if (runtimeId === 'opencode') {
        expect(listXfpAuditEvents()).toMatchObject([
          {
            runtimeId: 'opencode',
            kind: 'prompt',
            toolName: 'field_delivery',
            input: expect.objectContaining({
              mode: 'none',
              hasFieldContextEnvelope: false
            })
          }
        ])
      }
    }
  )
})
