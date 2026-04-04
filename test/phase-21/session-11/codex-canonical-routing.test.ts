import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../../src/main/services/codex-app-server-manager', () => ({
  CodexAppServerManager: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    off: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    prompt: vi.fn(),
    abort: vi.fn()
  }))
}))

import { AgentRuntimeManager } from '../../../src/main/services/agent-runtime-manager'
import { CodexImplementer } from '../../../src/main/services/codex-implementer'
import type { AgentRuntimeAdapter } from '../../../src/main/services/agent-runtime-types'

describe('Codex Canonical Protocol Routing', () => {
  let manager: AgentRuntimeManager
  let codexImpl: CodexImplementer

  beforeEach(() => {
    codexImpl = new CodexImplementer()
    manager = new AgentRuntimeManager([codexImpl])
  })

  it('should route agent:connect to Codex implementer', async () => {
    const connectSpy = vi.spyOn(codexImpl, 'connect').mockResolvedValue({ sessionId: 'codex-thread-1' })

    const impl = manager.getImplementer('codex')
    const result = await impl.connect('/proj', 'hive-1')

    expect(connectSpy).toHaveBeenCalledWith('/proj', 'hive-1')
    expect(result).toEqual({ sessionId: 'codex-thread-1' })
  })

  it('should pass codexFastMode option through agent:prompt', async () => {
    const promptSpy = vi.spyOn(codexImpl, 'prompt').mockResolvedValue(undefined)

    const impl = manager.getImplementer('codex')
    await impl.prompt('/proj', 'thread-1', 'test message', undefined, { codexFastMode: true })

    expect(promptSpy).toHaveBeenCalledWith('/proj', 'thread-1', 'test message', undefined, { codexFastMode: true })
  })

  it('should handle Codex permission requests', async () => {
    const permissionReplySpy = vi.spyOn(codexImpl, 'permissionReply').mockResolvedValue(undefined)

    const impl = manager.getImplementer('codex')
    await impl.permissionReply('req-1', 'once', '/proj')

    expect(permissionReplySpy).toHaveBeenCalledWith('req-1', 'once', '/proj')
  })

  it('should support undo but not redo for Codex sessions', () => {
    const impl = manager.getImplementer('codex')

    expect(impl.capabilities.supportsUndo).toBe(true)
    expect(impl.capabilities.supportsRedo).toBe(false)
  })

  it('should NOT support commands for Codex sessions', () => {
    const impl = manager.getImplementer('codex')

    expect(impl.capabilities.supportsCommands).toBe(false)
  })

  it('should handle Codex session lifecycle', async () => {
    const connectSpy = vi.spyOn(codexImpl, 'connect').mockResolvedValue({ sessionId: 'thread-1' })
    const promptSpy = vi.spyOn(codexImpl, 'prompt').mockResolvedValue(undefined)
    const getMessagesSpy = vi.spyOn(codexImpl, 'getMessages').mockResolvedValue([])
    const disconnectSpy = vi.spyOn(codexImpl, 'disconnect').mockResolvedValue(undefined)

    const impl = manager.getImplementer('codex')

    const { sessionId } = await impl.connect('/proj', 'hive-1')
    expect(sessionId).toBe('thread-1')

    await impl.prompt('/proj', sessionId, 'test message')
    expect(promptSpy).toHaveBeenCalled()

    const messages = await impl.getMessages('/proj', sessionId)
    expect(getMessagesSpy).toHaveBeenCalledWith('/proj', sessionId)
    expect(messages).toEqual([])

    await impl.disconnect('/proj', sessionId)
    expect(disconnectSpy).toHaveBeenCalledWith('/proj', sessionId)
  })

  it('should route agent:getAvailableModels to Codex implementer', async () => {
    const getModelsSpy = vi.spyOn(codexImpl, 'getAvailableModels').mockResolvedValue([])

    const impl = manager.getImplementer('codex')
    await impl.getAvailableModels()

    expect(getModelsSpy).toHaveBeenCalled()
  })

  it('should route agent:questionReply to Codex implementer', async () => {
    const questionReplySpy = vi.spyOn(codexImpl, 'questionReply').mockResolvedValue(undefined)

    const impl = manager.getImplementer('codex')
    await impl.questionReply('req-1', [['answer1']], '/proj')

    expect(questionReplySpy).toHaveBeenCalledWith('req-1', [['answer1']], '/proj')
  })
})
