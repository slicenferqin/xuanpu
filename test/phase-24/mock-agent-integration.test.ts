/**
 * mock-agent integration test — verifies that adding a new agent backend
 * requires only: 1 implementer class + 1 registration.
 *
 * Also acts as a regression test for the AgentRuntimeAdapter contract:
 * any future breaking change to the interface will fail to compile here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'
import { AgentRuntimeManager } from '../../src/main/services/agent-runtime-manager'
import type {
  AgentRuntimeAdapter,
  AgentRuntimeCapabilities
} from '../../src/main/services/agent-runtime-types'
import { emitAgentEvent } from '../../src/shared/lib/normalize-agent-event'

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// ---------------------------------------------------------------------------
// MockAgentImplementer — minimal, no-op adapter for testing
// ---------------------------------------------------------------------------

const MOCK_AGENT_CAPABILITIES: AgentRuntimeCapabilities = {
  supportsUndo: false,
  supportsRedo: false,
  supportsCommands: false,
  supportsPermissionRequests: false,
  supportsQuestionPrompts: false,
  supportsModelSelection: false,
  supportsReconnect: true,
  supportsPartialStreaming: false
}

class MockAgentImplementer implements AgentRuntimeAdapter {
  // TypeScript structural typing lets us use any string for id inside tests;
  // production code extends the AgentRuntimeId union in agent-runtime-types.ts
  readonly id = 'mock-agent' as AgentRuntimeAdapter['id']
  readonly capabilities = MOCK_AGENT_CAPABILITIES
  public cleanupCalls = 0
  public mainWindow: BrowserWindow | null = null
  public connectCalls: Array<{ worktreePath: string; sessionId: string }> = []

  async connect(worktreePath: string, sessionId: string) {
    this.connectCalls.push({ worktreePath, sessionId })
    return { sessionId: `mock-${sessionId}` }
  }
  async reconnect() {
    return { success: true, sessionStatus: 'idle' as const }
  }
  async disconnect() {}
  async cleanup() {
    this.cleanupCalls++
  }
  async prompt() {}
  async abort() {
    return true
  }
  async getMessages() {
    return []
  }
  async getAvailableModels() {
    return {}
  }
  async getModelInfo() {
    return null
  }
  setSelectedModel() {}
  async getSessionInfo() {
    return { revertMessageID: null, revertDiff: null }
  }
  async questionReply() {}
  async questionReject() {}
  async permissionReply() {}
  async permissionList() {
    return []
  }
  async undo() {
    return {}
  }
  async redo() {
    return {}
  }
  async listCommands() {
    return []
  }
  async sendCommand() {}
  async renameSession() {}
  setMainWindow(w: BrowserWindow) {
    this.mainWindow = w
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Mock agent integration', () => {
  let mock: MockAgentImplementer
  let manager: AgentRuntimeManager

  beforeEach(() => {
    mock = new MockAgentImplementer()
    // Registration point 1/1 — this is everything a new agent needs to do
    // to participate in IPC dispatch, event streaming, and lifecycle cleanup.
    manager = new AgentRuntimeManager([mock])
  })

  it('resolves the implementer by id', () => {
    const impl = manager.getImplementer('mock-agent' as 'opencode')
    expect(impl).toBe(mock)
  })

  it('exposes capabilities', () => {
    const caps = manager.getCapabilities('mock-agent' as 'opencode')
    expect(caps).toBe(MOCK_AGENT_CAPABILITIES)
    expect(caps.supportsReconnect).toBe(true)
    expect(caps.supportsCommands).toBe(false)
  })

  it('forwards setMainWindow to the registered agent', () => {
    const fakeWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    } as unknown as BrowserWindow
    manager.setMainWindow(fakeWindow)
    expect(mock.mainWindow).toBe(fakeWindow)
  })

  it('calls cleanup() on every agent during cleanupAll', async () => {
    await manager.cleanupAll()
    expect(mock.cleanupCalls).toBe(1)
  })

  it('delegates lifecycle calls through the adapter', async () => {
    const result = await mock.connect('/tmp/wt', 'hive-123')
    expect(result.sessionId).toBe('mock-hive-123')
    expect(mock.connectCalls).toEqual([{ worktreePath: '/tmp/wt', sessionId: 'hive-123' }])
  })

  it('emits events on the canonical agent:stream channel', () => {
    const sendSpy = vi.fn()
    const fakeWindow = {
      isDestroyed: () => false,
      webContents: { send: sendSpy }
    } as unknown as BrowserWindow

    emitAgentEvent(fakeWindow, {
      type: 'session.status',
      sessionId: 'sess-1',
      data: { status: { type: 'busy' } }
    })

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy.mock.calls[0][0]).toBe('agent:stream')
    const envelope = sendSpy.mock.calls[0][1] as Record<string, unknown>
    expect(envelope.type).toBe('session.status')
    expect(envelope.sessionId).toBe('sess-1')
    expect(envelope.eventId).toBeDefined()
    expect(envelope.sessionSequence).toBe(1)
  })

  it('throws with a clear message for unknown runtime ids', () => {
    expect(() => manager.getImplementer('non-existent' as 'opencode')).toThrow(
      /Unknown agent runtime/i
    )
  })
})

describe('AgentRuntimeAdapter contract', () => {
  it('accepts an agent that omits optional methods (forkSession, clearSelectedModel)', () => {
    const minimal = new MockAgentImplementer()
    expect(minimal.forkSession).toBeUndefined()
    expect(minimal.clearSelectedModel).toBeUndefined()
    // A manager with a minimal implementer must still build without errors.
    expect(() => new AgentRuntimeManager([minimal])).not.toThrow()
  })
})
