import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { XuanpuAgentTaskRunPanel } from '../../src/renderer/src/components/session-hq/XuanpuAgentTaskRunPanel'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { useSessionRuntimeStore } from '../../src/renderer/src/stores/useSessionRuntimeStore'

const xuanpuAgentOps = {
  listTaskRuns: vi.fn(),
  listEpochs: vi.fn(),
  listUserRounds: vi.fn(),
  listContextSegments: vi.fn(),
  listProviderRequests: vi.fn(),
  exportTaskRunReport: vi.fn(),
  pauseTaskRun: vi.fn(),
  resumeTaskRun: vi.fn()
}

const projectOps = {
  openPath: vi.fn()
}

class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe('XuanpuAgentTaskRunPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'xuanpuAgentOps', {
      configurable: true,
      value: xuanpuAgentOps
    })
    Object.defineProperty(window, 'projectOps', {
      configurable: true,
      value: projectOps
    })
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: ResizeObserverMock
    })
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: ResizeObserverMock
    })
    xuanpuAgentOps.listTaskRuns.mockResolvedValue([
      {
        id: 'task-run-1',
        sessionId: 'session-1',
        worktreeId: 'w-1',
        projectId: 'p-1',
        originMessageId: 'msg-1',
        status: 'running',
        autonomy: 'long',
        objective: 'finish the runtime',
        leaseExpiresAt: '2026-06-05T01:00:00.000Z',
        totalInputTokens: 1200,
        totalOutputTokens: 300,
        totalCost: 0.04,
        epochCount: 2,
        startedAt: '2026-06-05T00:00:00.000Z',
        completedAt: null,
        errorMessage: null
      }
    ])
    xuanpuAgentOps.listUserRounds.mockResolvedValue([
      {
        id: 'round-1',
        taskRunId: 'task-run-1',
        sessionId: 'session-1',
        ordinal: 0,
        origin: 'user-originated',
        status: 'running',
        userMessageId: 'msg-user-1',
        promptText: 'finish the runtime',
        providerRequestCount: 1,
        contextSegmentCount: 2,
        startedAt: '2026-06-05T00:00:00.000Z',
        completedAt: null,
        errorMessage: null
      }
    ])
    xuanpuAgentOps.listContextSegments.mockResolvedValue([
      {
        id: 'epoch-1',
        taskRunId: 'task-run-1',
        sessionId: 'session-1',
        userRoundId: 'round-1',
        ordinal: 0,
        status: 'checkpointed',
        checkpointId: 'ck-1',
        providerCallCount: 12,
        startFillRatio: 0.1,
        endFillRatio: 0.35,
        closeReason: 'checkpoint',
        startedAt: '2026-06-05T00:00:00.000Z',
        closedAt: '2026-06-05T00:10:00.000Z'
      },
      {
        id: 'epoch-2',
        taskRunId: 'task-run-1',
        sessionId: 'session-1',
        userRoundId: 'round-1',
        ordinal: 1,
        status: 'running',
        checkpointId: null,
        providerCallCount: 3,
        startFillRatio: 0.12,
        endFillRatio: null,
        closeReason: null,
        startedAt: '2026-06-05T00:10:00.000Z',
        closedAt: null
      }
    ])
    xuanpuAgentOps.listProviderRequests.mockResolvedValue([
      {
        id: 'snapshot-1',
        turnId: 'turn-1',
        sessionId: 'session-1',
        taskRunId: 'task-run-1',
        userRoundId: 'round-1',
        contextSegmentId: 'epoch-1',
        contextSegmentOrdinal: 0,
        providerCallSeq: 0,
        providerRequestHash: 'hash-1234567890abcdef',
        prefixHash: null,
        managedApproxTokens: 1200,
        providerEstimatedInputTokens: 1500,
        maxContextTokens: 150000,
        createdAt: '2026-06-05T00:00:00.000Z'
      }
    ])
    xuanpuAgentOps.pauseTaskRun.mockResolvedValue({ success: true })
    xuanpuAgentOps.resumeTaskRun.mockResolvedValue({ success: true })
    xuanpuAgentOps.exportTaskRunReport.mockResolvedValue({
      success: true,
      taskRunId: 'task-run-1',
      format: 'markdown',
      filePath: '/tmp/task-run-report.md'
    })
    projectOps.openPath.mockResolvedValue('')
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'xuanpuAgentOps')
    Reflect.deleteProperty(window, 'projectOps')
    Reflect.deleteProperty(window, 'ResizeObserver')
    Reflect.deleteProperty(globalThis, 'ResizeObserver')
  })

  it('renders task-run metrics and pauses an idle running task run', async () => {
    render(
      <TooltipProvider>
        <XuanpuAgentTaskRunPanel
          sessionId="session-1"
          lifecycle="idle"
          pendingCount={0}
          onResumeQueued={vi.fn(async () => false)}
        />
      </TooltipProvider>
    )

    expect(await screen.findByText('running')).toBeInTheDocument()
    expect(screen.getByText('/long')).toBeInTheDocument()
    expect(screen.getByText('calls')).toBeInTheDocument()
    expect(screen.getByText('15')).toBeInTheDocument()
    expect(screen.getByText('rounds')).toBeInTheDocument()
    expect(screen.getByText('segments')).toBeInTheDocument()
    expect(screen.getByText('requests')).toBeInTheDocument()
    expect(screen.getByText('1:user')).toBeInTheDocument()
    expect(screen.getByText('tokens')).toBeInTheDocument()
    expect(screen.getByText('1.5k')).toBeInTheDocument()

    await userEvent.click(screen.getByLabelText('Pause task run'))

    await waitFor(() => {
      expect(xuanpuAgentOps.pauseTaskRun).toHaveBeenCalledWith('task-run-1')
    })
  })

  it('resumes a paused idle task run and drains queued pending messages', async () => {
    const hydratePendingMessages = vi
      .spyOn(useSessionRuntimeStore.getState(), 'hydratePendingMessages')
      .mockResolvedValueOnce()
    const onResumeQueued = vi.fn(async () => true)
    xuanpuAgentOps.listTaskRuns.mockResolvedValue([
      {
        id: 'task-run-1',
        sessionId: 'session-1',
        worktreeId: 'w-1',
        projectId: 'p-1',
        originMessageId: 'msg-1',
        status: 'paused',
        autonomy: 'long',
        objective: 'finish the runtime',
        leaseExpiresAt: '2026-06-05T01:00:00.000Z',
        totalInputTokens: 1200,
        totalOutputTokens: 300,
        totalCost: 0.04,
        epochCount: 2,
        startedAt: '2026-06-05T00:00:00.000Z',
        completedAt: null,
        errorMessage: 'no progress'
      }
    ])
    xuanpuAgentOps.listUserRounds.mockResolvedValue([])
    xuanpuAgentOps.listContextSegments.mockResolvedValue([])
    xuanpuAgentOps.listProviderRequests.mockResolvedValue([])

    render(
      <TooltipProvider>
        <XuanpuAgentTaskRunPanel
          sessionId="session-1"
          lifecycle="idle"
          pendingCount={0}
          onResumeQueued={onResumeQueued}
        />
      </TooltipProvider>
    )

    expect(await screen.findByText('paused')).toBeInTheDocument()
    expect(screen.getByText('no progress')).toBeInTheDocument()

    await userEvent.click(screen.getByLabelText('Resume task run'))

    await waitFor(() => {
      expect(xuanpuAgentOps.resumeTaskRun).toHaveBeenCalledWith('task-run-1')
      expect(hydratePendingMessages).toHaveBeenCalledWith('session-1')
      expect(onResumeQueued).toHaveBeenCalled()
    })

    hydratePendingMessages.mockRestore()
  })

  it('exports a task-run report from the panel action', async () => {
    render(
      <TooltipProvider>
        <XuanpuAgentTaskRunPanel
          sessionId="session-1"
          lifecycle="idle"
          pendingCount={0}
          onResumeQueued={vi.fn(async () => false)}
        />
      </TooltipProvider>
    )

    expect(await screen.findByText('running')).toBeInTheDocument()

    await userEvent.click(screen.getByLabelText('Export task run report'))

    await waitFor(() => {
      expect(xuanpuAgentOps.exportTaskRunReport).toHaveBeenCalledWith({
        taskRunId: 'task-run-1',
        format: 'markdown'
      })
      expect(projectOps.openPath).toHaveBeenCalledWith('/tmp/task-run-report.md')
    })
  })
})
