import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { XuanpuAgentTaskRunPanel } from '../../src/renderer/src/components/session-hq/XuanpuAgentTaskRunPanel'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'

const xuanpuAgentOps = {
  listTaskRuns: vi.fn(),
  listEpochs: vi.fn(),
  pauseTaskRun: vi.fn(),
  resumeTaskRun: vi.fn()
}

describe('XuanpuAgentTaskRunPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'xuanpuAgentOps', {
      configurable: true,
      value: xuanpuAgentOps
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
    xuanpuAgentOps.listEpochs.mockResolvedValue([
      {
        id: 'epoch-1',
        taskRunId: 'task-run-1',
        sessionId: 'session-1',
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
    xuanpuAgentOps.pauseTaskRun.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'xuanpuAgentOps')
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
    expect(screen.getByText('tokens')).toBeInTheDocument()
    expect(screen.getByText('1.5k')).toBeInTheDocument()

    await userEvent.click(screen.getByLabelText('Pause task run'))

    await waitFor(() => {
      expect(xuanpuAgentOps.pauseTaskRun).toHaveBeenCalledWith('task-run-1')
    })
  })
})
