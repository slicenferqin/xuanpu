import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { AgentRuntimeManager } from '../../../src/main/services/agent-runtime-manager'
import type { AgentRuntimeAdapter } from '../../../src/main/services/agent-runtime-types'
import type { DatabaseService } from '../../../src/main/db/database'

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
    connect: vi.fn().mockResolvedValue({ sessionId: 'opc-123' }),
    reconnect: vi.fn().mockResolvedValue({ success: true }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([]),
    getAvailableModels: vi.fn().mockResolvedValue([]),
    getModelInfo: vi.fn().mockResolvedValue(null),
    setSelectedModel: vi.fn(),
    getSessionInfo: vi.fn().mockResolvedValue({ revertMessageID: null, revertDiff: null }),
    questionReply: vi.fn().mockResolvedValue(undefined),
    questionReject: vi.fn().mockResolvedValue(undefined),
    permissionReply: vi.fn().mockResolvedValue(undefined),
    permissionList: vi.fn().mockResolvedValue([]),
    undo: vi.fn().mockResolvedValue({}),
    redo: vi.fn().mockResolvedValue({}),
    listCommands: vi.fn().mockResolvedValue([]),
    sendCommand: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    setMainWindow: vi.fn()
  }
}

function createMockDbService(): DatabaseService {
  return {
    getRuntimeIdForSession: vi.fn().mockReturnValue('opencode'),
    getAgentSdkForSession: vi.fn().mockReturnValue('opencode')
  } as unknown as DatabaseService
}

describe('OpenCode Canonical Protocol Routing', () => {
  let manager: AgentRuntimeManager
  let mockOC: AgentRuntimeAdapter
  let mockDb: DatabaseService

  beforeEach(() => {
    mockOC = createMockOpenCodeImpl()
    manager = new AgentRuntimeManager([mockOC])
    mockDb = createMockDbService()
  })

  it('should route agent:connect to OpenCode implementer', async () => {
    const impl = manager.getImplementer('opencode')
    const result = await impl.connect('/proj', 'hive-1')

    expect(mockOC.connect).toHaveBeenCalledWith('/proj', 'hive-1')
    expect(result).toEqual({ sessionId: 'opc-123' })
  })

  it('should route agent:prompt to OpenCode implementer', async () => {
    const impl = manager.getImplementer('opencode')
    await impl.prompt('/proj', 'opc-123', 'hello world')

    expect(mockOC.prompt).toHaveBeenCalledWith('/proj', 'opc-123', 'hello world')
  })

  it('should route agent:undo to OpenCode implementer', async () => {
    const impl = manager.getImplementer('opencode')
    await impl.undo('/proj', 'opc-123', 'hive-1')

    expect(mockOC.undo).toHaveBeenCalledWith('/proj', 'opc-123', 'hive-1')
  })

  it('should route agent:redo to OpenCode implementer', async () => {
    const impl = manager.getImplementer('opencode')
    await impl.redo('/proj', 'opc-123', 'hive-1')

    expect(mockOC.redo).toHaveBeenCalledWith('/proj', 'opc-123', 'hive-1')
  })

  it('should handle OpenCode session lifecycle', async () => {
    const impl = manager.getImplementer('opencode')

    const { sessionId } = await impl.connect('/proj', 'hive-1')
    expect(sessionId).toBe('opc-123')

    await impl.prompt('/proj', sessionId, 'test message')
    expect(mockOC.prompt).toHaveBeenCalled()

    const messages = await impl.getMessages('/proj', sessionId)
    expect(mockOC.getMessages).toHaveBeenCalledWith('/proj', sessionId)
    expect(messages).toEqual([])

    await impl.disconnect('/proj', sessionId)
    expect(mockOC.disconnect).toHaveBeenCalledWith('/proj', sessionId)
  })

  it('should route agent:listCommands to OpenCode implementer', async () => {
    const impl = manager.getImplementer('opencode')
    await impl.listCommands('/proj')

    expect(mockOC.listCommands).toHaveBeenCalledWith('/proj')
  })

  it('should route agent:sendCommand to OpenCode implementer', async () => {
    const impl = manager.getImplementer('opencode')
    await impl.sendCommand('/proj', 'opc-123', '/test', 'arg1')

    expect(mockOC.sendCommand).toHaveBeenCalledWith('/proj', 'opc-123', '/test', 'arg1')
  })
})
