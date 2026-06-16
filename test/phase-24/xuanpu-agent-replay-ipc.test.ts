import { beforeEach, describe, expect, it, vi } from 'vitest'

type IpcCallback = (event: unknown, ...args: unknown[]) => unknown

const handlers = new Map<string, IpcCallback>()
const turnRepoMock = vi.hoisted(() => ({
  listProviderRequestSummariesForTaskRun: vi.fn(() => []),
  getProviderRequestReplay: vi.fn((snapshotId: string) =>
    snapshotId === 'snapshot-1'
      ? {
          id: 'snapshot-1',
          turnId: 'turn-1',
          sessionId: 'session-1',
          xfpPacketId: 'packet-1',
          taskRunId: 'task-run-1',
          userRoundId: 'round-1',
          contextSegmentId: 'segment-1',
          contextSegmentOrdinal: 0,
          providerCallSeq: 0,
          providerRequestHash: 'hash-1',
          prefixHash: 'prefix-1',
          managedContextJson: '{"zones":["field"]}',
          providerMessagesJson: '{"promptMessage":{"role":"user"}}',
          providerToolsJson: '[{"name":"read_file"}]',
          providerConfigJson: '{"providerID":"openai","modelID":"gpt-test"}',
          decisionsJson: '{"providerExecution":"enabled"}',
          managedApproxTokens: 100,
          providerEstimatedInputTokens: 120,
          maxContextTokens: 150000,
          createdAt: '2026-06-16T00:00:00.000Z'
        }
      : null
  )
}))
const taskRunRepoMock = vi.hoisted(() => ({
  getTaskRun: vi.fn(),
  listContextSegmentsForTaskRun: vi.fn(() => []),
  listEpochsForTaskRun: vi.fn(() => []),
  listTaskRunsForSession: vi.fn(() => []),
  listUserRoundsForTaskRun: vi.fn(() => []),
  renewLease: vi.fn(),
  updateTaskRunStatus: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, cb: IpcCallback) => handlers.set(channel, cb)
  }
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('../../src/main/db', () => ({
  getDatabase: vi.fn(() => ({
    listSessionPendingMessages: vi.fn(() => []),
    cancelSessionPendingMessage: vi.fn(),
    createSessionPendingMessage: vi.fn()
  }))
}))

vi.mock('../../src/main/db/task-run-repository', () => taskRunRepoMock)
vi.mock('../../src/main/db/turn-repository', () => turnRepoMock)

import { registerXuanpuAgentHandlers } from '../../src/main/ipc/xuanpu-agent-handlers'

describe('xuanpu-agent replay IPC', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  it('returns a provider request replay snapshot by snapshot id', async () => {
    registerXuanpuAgentHandlers()

    const getReplay = handlers.get('xuanpu-agent:getProviderRequestReplay')
    expect(getReplay).toBeTypeOf('function')

    await expect(getReplay?.({}, 'snapshot-1')).resolves.toMatchObject({
      id: 'snapshot-1',
      providerMessagesJson: '{"promptMessage":{"role":"user"}}',
      providerToolsJson: '[{"name":"read_file"}]',
      providerConfigJson: '{"providerID":"openai","modelID":"gpt-test"}',
      decisionsJson: '{"providerExecution":"enabled"}'
    })
    expect(turnRepoMock.getProviderRequestReplay).toHaveBeenCalledWith('snapshot-1')
  })
})
