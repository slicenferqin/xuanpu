/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  OPENCODE_CAPABILITIES,
  CLAUDE_CODE_CAPABILITIES
} from '../../../src/main/services/agent-sdk-types'

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
import type { AgentSdkCapabilities } from '../../../src/main/services/agent-sdk-types'

function createMockRuntimeManager(): AgentRuntimeManager {
  return {
    setMainWindow: vi.fn(),
    getImplementer: vi.fn(),
    getCapabilities: vi.fn((runtimeId: string): AgentSdkCapabilities => {
      if (runtimeId === 'claude-code') return CLAUDE_CODE_CAPABILITIES
      return OPENCODE_CAPABILITIES
    }),
    cleanup: vi.fn()
  } as unknown as AgentRuntimeManager
}

function createMockDbService(runtimeId: 'opencode' | 'claude-code' | null): DatabaseService {
  return {
    getRuntimeIdForSession: vi.fn().mockReturnValue(runtimeId)
  } as unknown as DatabaseService
}

const mockEvent = {} as any

describe('IPC agent:capabilities', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  it('returns CLAUDE_CODE_CAPABILITIES for claude-code sessions', async () => {
    const runtimeManager = createMockRuntimeManager()
    const dbService = createMockDbService('claude-code')
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerAgentHandlers(mainWindow, runtimeManager, dbService)

    const handler = handlers.get('agent:capabilities')!
    const result = await handler(mockEvent, { sessionId: 'claude-session-1' })

    expect(dbService.getRuntimeIdForSession).toHaveBeenCalledWith('claude-session-1')
    expect(runtimeManager.getCapabilities).toHaveBeenCalledWith('claude-code')
    expect(result).toEqual({
      success: true,
      capabilities: CLAUDE_CODE_CAPABILITIES
    })
  })

  it('returns OPENCODE_CAPABILITIES for opencode sessions', async () => {
    const runtimeManager = createMockRuntimeManager()
    const dbService = createMockDbService('opencode')
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerAgentHandlers(mainWindow, runtimeManager, dbService)

    const handler = handlers.get('agent:capabilities')!
    const result = await handler(mockEvent, { sessionId: 'oc-session-1' })

    expect(dbService.getRuntimeIdForSession).toHaveBeenCalledWith('oc-session-1')
    expect(runtimeManager.getCapabilities).toHaveBeenCalledWith('opencode')
    expect(result).toEqual({
      success: true,
      capabilities: OPENCODE_CAPABILITIES
    })
  })

  it('defaults to opencode capabilities when runtime id is unavailable', async () => {
    const runtimeManager = createMockRuntimeManager()
    const dbService = createMockDbService(null)
    const mainWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } } as any

    registerAgentHandlers(mainWindow, runtimeManager, dbService)

    const handler = handlers.get('agent:capabilities')!
    const result = await handler(mockEvent, { sessionId: 'unknown-session' })

    expect(result).toEqual({
      success: true,
      capabilities: OPENCODE_CAPABILITIES
    })
  })
})
