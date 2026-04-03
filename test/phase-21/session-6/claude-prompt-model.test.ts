/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  ipcMain: { handle: vi.fn() }
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

const { mockQuery, mockMaybeWithPMR } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockMaybeWithPMR: vi.fn(async (options: any) => options)
}))

vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn().mockResolvedValue({ query: mockQuery })
}))

vi.mock('../../../src/main/services/claude-transcript-reader', () => ({
  readClaudeTranscript: vi.fn().mockResolvedValue([]),
  translateEntry: vi.fn().mockReturnValue(null)
}))

vi.mock('../../../src/main/services/claude-project-memory-loader', () => ({
  maybeWithClaudeProjectMemory: mockMaybeWithPMR
}))

import { ClaudeCodeImplementer } from '../../../src/main/services/claude-code-implementer'

function createMockWindow() {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as any
}

describe('ClaudeCodeImplementer prompt model selection', () => {
  let impl: ClaudeCodeImplementer

  beforeEach(async () => {
    mockQuery.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: vi.fn().mockResolvedValue({ done: true, value: undefined })
      }),
      interrupt: vi.fn(),
      close: vi.fn()
    }))
    mockMaybeWithPMR.mockImplementation(async (options: any) => options)

    impl = new ClaudeCodeImplementer()
    impl.setMainWindow(createMockWindow())
  })

  it('prompt passes model in options when modelOverride provided', async () => {
    const { sessionId } = await impl.connect('/test/path', 'hive-session-1')

    await impl.prompt('/test/path', sessionId, 'hello', {
      providerID: 'claude-code',
      modelID: 'opus'
    })

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ model: 'opus' })
      })
    )
  })

  it('prompt uses selectedModel default when no override', async () => {
    const { sessionId } = await impl.connect('/test/path', 'hive-session-2')

    await impl.prompt('/test/path', sessionId, 'hello')

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ model: 'sonnet' })
      })
    )
  })

  it('prompt uses model set via setSelectedModel', async () => {
    impl.setSelectedModel({ providerID: 'claude-code', modelID: 'haiku' })

    const { sessionId } = await impl.connect('/test/path', 'hive-session-3')

    await impl.prompt('/test/path', sessionId, 'hello')

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ model: 'haiku' })
      })
    )
  })

  it('prompt calls maybeWithClaudeProjectMemory with options containing cwd and model', async () => {
    const { sessionId } = await impl.connect('/test/path', 'hive-session-4')

    await impl.prompt('/test/path', sessionId, 'hello')

    expect(mockMaybeWithPMR).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/test/path',
        model: 'sonnet'
      })
    )
  })
})
