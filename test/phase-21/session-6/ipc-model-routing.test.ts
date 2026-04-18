/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture registered IPC handlers
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
import type { AgentRuntimeAdapter } from '../../../src/main/services/agent-runtime-types'

function createMockClaudeImpl(): AgentRuntimeAdapter {
  return {
    id: 'claude-code' as const,
    capabilities: {
      supportsUndo: false,
      supportsRedo: false,
      supportsCommands: false,
      supportsPermissionRequests: false,
      supportsQuestionPrompts: false,
      supportsModelSelection: true,
      supportsReconnect: false,
      supportsPartialStreaming: false
    },
    connect: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    cleanup: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([]),
    getAvailableModels: vi.fn().mockResolvedValue([{ id: 'claude-code', models: {} }]),
    getModelInfo: vi.fn().mockResolvedValue({
      id: 'opus',
      name: 'Opus 4.7',
      limit: { context: 200000, output: 32000 }
    }),
    setSelectedModel: vi.fn(),
    getSessionInfo: vi.fn().mockResolvedValue({ revertMessageID: null, revertDiff: null }),
    questionReply: vi.fn(),
    questionReject: vi.fn(),
    permissionReply: vi.fn(),
    permissionList: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    listCommands: vi.fn(),
    sendCommand: vi.fn(),
    renameSession: vi.fn(),
    setMainWindow: vi.fn()
  }
}

function createMockOpenCodeImpl(): AgentRuntimeAdapter {
  return {
    id: 'opencode' as const,
    capabilities: {
      supportsUndo: true,
      supportsRedo: true,
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
    getAvailableModels: vi.fn().mockResolvedValue([{ id: 'opencode', models: {} }]),
    getModelInfo: vi.fn().mockResolvedValue({
      id: 'opus',
      name: 'Opus 4.7',
      limit: { context: 200000, output: 32000 }
    }),
    setSelectedModel: vi.fn(),
    getSessionInfo: vi.fn().mockResolvedValue({ revertMessageID: null, revertDiff: null }),
    questionReply: vi.fn(),
    questionReject: vi.fn(),
    permissionReply: vi.fn(),
    permissionList: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    listCommands: vi.fn(),
    sendCommand: vi.fn(),
    renameSession: vi.fn(),
    setMainWindow: vi.fn()
  }
}

function createMockRuntimeManager(
  openCodeImpl: AgentRuntimeAdapter,
  claudeImpl: AgentRuntimeAdapter
): AgentRuntimeManager {
  return {
    getImplementer: vi.fn((id: string) => {
      if (id === 'opencode') return openCodeImpl
      if (id === 'claude-code') return claudeImpl
      throw new Error(`Unknown agent SDK: ${id}`)
    }),
    getCapabilities: vi.fn(),
    cleanupAll: vi.fn()
  } as unknown as AgentRuntimeManager
}

const mockEvent = {} as any

describe('IPC agent:models runtime-aware routing', () => {
  let claudeImpl: AgentRuntimeAdapter
  let openCodeImpl: AgentRuntimeAdapter

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
    openCodeImpl = createMockOpenCodeImpl()
  })

  it('agent:models without runtimeId routes to OpenCode', async () => {
    const runtimeManager = createMockRuntimeManager(openCodeImpl, claudeImpl)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerAgentHandlers(mainWindow, runtimeManager)

    const handler = handlers.get('agent:models')!
    expect(handler).toBeDefined()

    await handler(mockEvent, undefined)

    expect(runtimeManager.getImplementer).toHaveBeenCalledWith('opencode')
    expect(openCodeImpl.getAvailableModels).toHaveBeenCalled()
    expect(claudeImpl.getAvailableModels).not.toHaveBeenCalled()
  })

  it('agent:models with runtimeId claude-code routes to Claude', async () => {
    const runtimeManager = createMockRuntimeManager(openCodeImpl, claudeImpl)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerAgentHandlers(mainWindow, runtimeManager)

    const handler = handlers.get('agent:models')!
    await handler(mockEvent, { runtimeId: 'claude-code' })

    expect(runtimeManager.getImplementer).toHaveBeenCalledWith('claude-code')
    expect(claudeImpl.getAvailableModels).toHaveBeenCalled()
    expect(openCodeImpl.getAvailableModels).not.toHaveBeenCalled()
  })
})

describe('IPC agent:setModel runtime-aware routing', () => {
  let claudeImpl: AgentRuntimeAdapter
  let openCodeImpl: AgentRuntimeAdapter

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
    openCodeImpl = createMockOpenCodeImpl()
  })

  it('agent:setModel without runtimeId routes to OpenCode', async () => {
    const runtimeManager = createMockRuntimeManager(openCodeImpl, claudeImpl)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerAgentHandlers(mainWindow, runtimeManager)

    const handler = handlers.get('agent:setModel')!
    expect(handler).toBeDefined()

    await handler(mockEvent, { providerID: 'anthropic', modelID: 'opus' })

    expect(runtimeManager.getImplementer).toHaveBeenCalledWith('opencode')
    expect(openCodeImpl.setSelectedModel).toHaveBeenCalledWith({
      providerID: 'anthropic',
      modelID: 'opus'
    })
    expect(claudeImpl.setSelectedModel).not.toHaveBeenCalled()
  })

  it('agent:setModel with runtimeId claude-code routes to Claude', async () => {
    const runtimeManager = createMockRuntimeManager(openCodeImpl, claudeImpl)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerAgentHandlers(mainWindow, runtimeManager)

    const handler = handlers.get('agent:setModel')!
    await handler(mockEvent, {
      providerID: 'claude-code',
      modelID: 'opus',
      runtimeId: 'claude-code'
    })

    expect(runtimeManager.getImplementer).toHaveBeenCalledWith('claude-code')
    expect(claudeImpl.setSelectedModel).toHaveBeenCalledWith({
      providerID: 'claude-code',
      modelID: 'opus',
      runtimeId: 'claude-code'
    })
    expect(openCodeImpl.setSelectedModel).not.toHaveBeenCalled()
  })
})

describe('IPC agent:modelInfo runtime-aware routing', () => {
  let claudeImpl: AgentRuntimeAdapter
  let openCodeImpl: AgentRuntimeAdapter

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
    openCodeImpl = createMockOpenCodeImpl()
  })

  it('agent:modelInfo without runtimeId routes to OpenCode', async () => {
    const runtimeManager = createMockRuntimeManager(openCodeImpl, claudeImpl)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerAgentHandlers(mainWindow, runtimeManager)

    const handler = handlers.get('agent:modelInfo')!
    expect(handler).toBeDefined()

    await handler(mockEvent, { worktreePath: '/path', modelId: 'opus' })

    expect(runtimeManager.getImplementer).toHaveBeenCalledWith('opencode')
    expect(openCodeImpl.getModelInfo).toHaveBeenCalledWith('/path', 'opus')
    expect(claudeImpl.getModelInfo).not.toHaveBeenCalled()
  })

  it('agent:modelInfo with runtimeId claude-code routes to Claude', async () => {
    const runtimeManager = createMockRuntimeManager(openCodeImpl, claudeImpl)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerAgentHandlers(mainWindow, runtimeManager)

    const handler = handlers.get('agent:modelInfo')!
    await handler(mockEvent, {
      worktreePath: '/path',
      modelId: 'opus',
      runtimeId: 'claude-code'
    })

    expect(runtimeManager.getImplementer).toHaveBeenCalledWith('claude-code')
    expect(claudeImpl.getModelInfo).toHaveBeenCalledWith('/path', 'opus')
    expect(openCodeImpl.getModelInfo).not.toHaveBeenCalled()
  })
})

describe('IPC agent:models failure when runtimeManager is missing', () => {
  let claudeImpl: AgentRuntimeAdapter

  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    claudeImpl = createMockClaudeImpl()
  })

  it('agent:models returns an error when runtimeManager is null', async () => {
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerAgentHandlers(mainWindow, undefined, undefined)

    const handler = handlers.get('agent:models')!
    const result = await handler(mockEvent, { runtimeId: 'claude-code' })

    expect(claudeImpl.getAvailableModels).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: false })
  })
})
