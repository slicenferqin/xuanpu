/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: any[]) => any>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler)
    })
  },
  app: {
    getPath: vi.fn(() => '/tmp')
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

vi.mock('../../../src/main/services/opencode-service', () => ({
  openCodeService: {
    setMainWindow: vi.fn()
  }
}))

import { registerAgentHandlers } from '../../../src/main/ipc/agent-handlers'
import type { AgentRuntimeManager } from '../../../src/main/services/agent-runtime-manager'
import type { DatabaseService } from '../../../src/main/db/database'
import type { AgentSdkImplementer } from '../../../src/main/services/agent-sdk-types'

function createMockImplementer(id: 'claude-code' | 'opencode'): AgentSdkImplementer & {
  undo: ReturnType<typeof vi.fn>
  redo: ReturnType<typeof vi.fn>
} {
  return {
    id,
    capabilities: {
      supportsUndo: true,
      supportsRedo: id === 'opencode',
      supportsSteer: false,
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
    prompt: vi.fn(),
    abort: vi.fn(),
    getMessages: vi.fn(),
    getAvailableModels: vi.fn(),
    getModelInfo: vi.fn(),
    setSelectedModel: vi.fn(),
    clearSelectedModel: vi.fn(),
    getSessionInfo: vi.fn(),
    questionReply: vi.fn(),
    questionReject: vi.fn(),
    permissionReply: vi.fn(),
    permissionList: vi.fn(),
    undo: vi.fn().mockResolvedValue({
      revertMessageID: `${id}-revert-1`,
      restoredPrompt: `${id} prompt`,
      revertDiff: `${id} diff`
    }),
    redo:
      id === 'claude-code'
        ? vi.fn().mockRejectedValue(new Error('Redo is not supported for Claude Code sessions'))
        : vi.fn().mockResolvedValue({ revertMessageID: null }),
    listCommands: vi.fn(),
    sendCommand: vi.fn(),
    renameSession: vi.fn(),
    setMainWindow: vi.fn()
  } as unknown as AgentSdkImplementer & {
    undo: ReturnType<typeof vi.fn>
    redo: ReturnType<typeof vi.fn>
  }
}

function createMockRuntimeManager(
  claudeImpl: AgentSdkImplementer,
  opencodeImpl: AgentSdkImplementer
): AgentRuntimeManager {
  return {
    setMainWindow: vi.fn(),
    getImplementer: vi.fn((runtimeId: string) => {
      if (runtimeId === 'claude-code') return claudeImpl
      if (runtimeId === 'opencode') return opencodeImpl
      throw new Error(`Unknown runtime: ${runtimeId}`)
    }),
    getCapabilities: vi.fn(),
    cleanup: vi.fn()
  } as unknown as AgentRuntimeManager
}

function createMockDbService(runtimeId: 'opencode' | 'claude-code'): DatabaseService {
  return {
    getRuntimeIdForSession: vi.fn().mockReturnValue(runtimeId)
  } as unknown as DatabaseService
}

const mockEvent = {} as any

describe('IPC agent:undo / agent:redo routing', () => {
  let claudeImpl: ReturnType<typeof createMockImplementer>
  let opencodeImpl: ReturnType<typeof createMockImplementer>

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    claudeImpl = createMockImplementer('claude-code')
    opencodeImpl = createMockImplementer('opencode')
  })

  it('routes undo to the Claude implementer', async () => {
    const runtimeManager = createMockRuntimeManager(claudeImpl, opencodeImpl)
    const dbService = createMockDbService('claude-code')
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerAgentHandlers(mainWindow, runtimeManager, dbService)

    const handler = handlers.get('agent:undo')!
    const result = await handler(mockEvent, {
      worktreePath: '/project',
      sessionId: 'claude-session-1'
    })

    expect(dbService.getRuntimeIdForSession).toHaveBeenCalledWith('claude-session-1')
    expect(runtimeManager.getImplementer).toHaveBeenCalledWith('claude-code')
    expect(claudeImpl.undo).toHaveBeenCalledWith('/project', 'claude-session-1', '')
    expect(opencodeImpl.undo).not.toHaveBeenCalled()
    expect(result).toEqual({
      success: true,
      revertMessageID: 'claude-code-revert-1',
      restoredPrompt: 'claude-code prompt',
      revertDiff: 'claude-code diff'
    })
  })

  it('routes undo to the OpenCode implementer', async () => {
    const runtimeManager = createMockRuntimeManager(claudeImpl, opencodeImpl)
    const dbService = createMockDbService('opencode')
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerAgentHandlers(mainWindow, runtimeManager, dbService)

    const handler = handlers.get('agent:undo')!
    const result = await handler(mockEvent, {
      worktreePath: '/project',
      sessionId: 'oc-session-1'
    })

    expect(runtimeManager.getImplementer).toHaveBeenCalledWith('opencode')
    expect(opencodeImpl.undo).toHaveBeenCalledWith('/project', 'oc-session-1', '')
    expect(result).toEqual({
      success: true,
      revertMessageID: 'opencode-revert-1',
      restoredPrompt: 'opencode prompt',
      revertDiff: 'opencode diff'
    })
  })

  it('surfaces the Claude redo unsupported error through the handler envelope', async () => {
    const runtimeManager = createMockRuntimeManager(claudeImpl, opencodeImpl)
    const dbService = createMockDbService('claude-code')
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerAgentHandlers(mainWindow, runtimeManager, dbService)

    const handler = handlers.get('agent:redo')!
    const result = await handler(mockEvent, {
      worktreePath: '/project',
      sessionId: 'claude-session-1'
    })

    expect(claudeImpl.redo).toHaveBeenCalledWith('/project', 'claude-session-1', '')
    expect(result).toMatchObject({
      success: false,
      error: 'Redo is not supported for Claude Code sessions',
      errorCode: 'INTERNAL_ERROR'
    })
  })

  it('routes redo to the OpenCode implementer', async () => {
    const runtimeManager = createMockRuntimeManager(claudeImpl, opencodeImpl)
    const dbService = createMockDbService('opencode')
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerAgentHandlers(mainWindow, runtimeManager, dbService)

    const handler = handlers.get('agent:redo')!
    const result = await handler(mockEvent, {
      worktreePath: '/project',
      sessionId: 'oc-session-1'
    })

    expect(opencodeImpl.redo).toHaveBeenCalledWith('/project', 'oc-session-1', '')
    expect(result).toEqual({
      success: true,
      revertMessageID: null
    })
  })
})
