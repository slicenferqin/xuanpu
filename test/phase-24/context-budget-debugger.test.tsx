import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ContextBudgetDebugger } from '../../src/renderer/src/components/sessions/ContextBudgetDebugger'

function installFieldOpsMock(): Window['fieldOps'] {
  const fieldOps = {
    listContextPackages: vi.fn().mockImplementation(async (query: { sessionId?: string }) =>
      query.sessionId === 'hive-session'
        ? [
            {
              id: 'pkg-123456789',
              sessionId: 'hive-session',
              worktreeId: 'worktree-1',
              runtimeId: 'xuanpu-agent',
              modelProviderId: 'anthropic',
              modelId: 'claude-haiku-4-5',
              createdAt: 1000,
              budgetProfile: 'balanced',
              approxTokens: 256,
              sections: [
                {
                  id: 'current-field',
                  kind: 'current_field',
                  title: 'Current Field',
                  included: true,
                  approxTokens: 96,
                  source: 'field-context'
                },
                {
                  id: 'retrieved-episodes',
                  kind: 'retrieved_episodes',
                  title: 'Retrieved Episodes',
                  included: false,
                  approxTokens: 0,
                  source: 'field_episode_blocks',
                  reason: 'Gated retrieval did not match this turn'
                }
              ],
              renderedMarkdown: null,
              renderedMarkdownStored: false,
              decisions: {
                renderedMarkdownPolicy: 'omitted-by-default',
                retrievedEpisodeCount: 0,
                frozenEpisodeCandidateCount: 2
              }
            }
          ]
        : []
    ),
    listEpisodeBlocks: vi.fn().mockImplementation(async (query: { sessionId?: string }) =>
      query.sessionId === 'hive-session'
        ? [
            {
              id: 'episode-123456789',
              worktreeId: 'worktree-1',
              sessionId: 'hive-session',
              createdAt: 2000,
              kind: 'turns',
              title: 'Frozen Conversation Turns',
              summaryMarkdown: '## Frozen Conversation Turns\n\n- **user:** keep pnpm',
              keyFacts: [],
              constraints: ['keep using pnpm'],
              files: ['src/main/services/xuanpu-agent/runtime.ts'],
              commands: ['pnpm vitest run test/phase-24/xuanpu-agent-runtime.test.ts'],
              failures: [],
              rawRefs: [{ type: 'session_message', id: 'm-1', role: 'user' }],
              tokenEstimate: 64,
              confidence: 'medium'
            }
          ]
        : []
    )
  } as unknown as Window['fieldOps']

  Object.defineProperty(window, 'fieldOps', {
    configurable: true,
    writable: true,
    value: fieldOps
  })

  return fieldOps
}

function installXuanpuAgentOpsMock(): Window['xuanpuAgentOps'] {
  const replay = {
    id: 'snapshot-1',
    turnId: 'turn-1',
    sessionId: 'hive-session',
    xfpPacketId: 'packet-1',
    taskRunId: 'task-run-1',
    userRoundId: 'round-1',
    contextSegmentId: 'segment-1',
    contextSegmentOrdinal: 0,
    providerCallSeq: 0,
    providerRequestHash: 'hash-abcdef1234567890',
    prefixHash: 'prefix-abcdef1234567890',
    managedApproxTokens: 256,
    providerEstimatedInputTokens: 300,
    maxContextTokens: 150000,
    createdAt: '2026-06-16T00:00:00.000Z',
    managedContextJson: JSON.stringify({ zones: ['field', 'history'] }),
    providerMessagesJson: JSON.stringify({
      systemPrompt: ['system'],
      promptMessage: { role: 'user', content: [{ type: 'text', text: 'current request' }] }
    }),
    providerToolsJson: JSON.stringify([{ name: 'read_file' }]),
    providerConfigJson: JSON.stringify({ providerID: 'openai', modelID: 'gpt-test' }),
    decisionsJson: JSON.stringify({ providerExecution: 'enabled' })
  }
  const xuanpuAgentOps = {
    listTaskRuns: vi.fn().mockResolvedValue([
      {
        id: 'task-run-1',
        sessionId: 'hive-session',
        worktreeId: 'worktree-1',
        projectId: 'project-1',
        originMessageId: 'msg-1',
        status: 'running',
        autonomy: 'long',
        objective: 'inspect requests',
        leaseExpiresAt: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        epochCount: 1,
        startedAt: '2026-06-16T00:00:00.000Z',
        completedAt: null,
        errorMessage: null
      }
    ]),
    listEpochs: vi.fn().mockResolvedValue([]),
    listUserRounds: vi.fn().mockResolvedValue([]),
    listContextSegments: vi.fn().mockResolvedValue([]),
    listProviderRequests: vi.fn().mockResolvedValue([
      {
        id: 'snapshot-1',
        turnId: 'turn-1',
        sessionId: 'hive-session',
        taskRunId: 'task-run-1',
        userRoundId: 'round-1',
        contextSegmentId: 'segment-1',
        contextSegmentOrdinal: 0,
        providerCallSeq: 0,
        providerRequestHash: 'hash-abcdef1234567890',
        prefixHash: 'prefix-abcdef1234567890',
        managedApproxTokens: 256,
        providerEstimatedInputTokens: 300,
        maxContextTokens: 150000,
        createdAt: '2026-06-16T00:00:00.000Z'
      }
    ]),
    getProviderRequestReplay: vi.fn().mockResolvedValue(replay),
    pauseTaskRun: vi.fn(),
    resumeTaskRun: vi.fn()
  } as unknown as Window['xuanpuAgentOps']

  Object.defineProperty(window, 'xuanpuAgentOps', {
    configurable: true,
    writable: true,
    value: xuanpuAgentOps
  })

  return xuanpuAgentOps
}

describe('ContextBudgetDebugger', () => {
  let fieldOps: Window['fieldOps']

  beforeEach(() => {
    fieldOps = installFieldOpsMock()
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'fieldOps')
    Reflect.deleteProperty(window, 'xuanpuAgentOps')
  })

  it('loads xuanpu-agent context packages with privacy-preserving markdown reads', async () => {
    render(
      <ContextBudgetDebugger
        sessionId="hive-session"
        runtimeSessionId="runtime-session"
        worktreeId="worktree-1"
      />
    )

    fireEvent.click(screen.getByText('Context Budget'))

    await waitFor(() => {
      expect(fieldOps.listContextPackages).toHaveBeenCalledWith({
        worktreeId: 'worktree-1',
        sessionId: 'runtime-session',
        runtimeId: 'xuanpu-agent',
        includeRenderedMarkdown: false,
        limit: 5
      })
      expect(fieldOps.listContextPackages).toHaveBeenCalledWith({
        worktreeId: 'worktree-1',
        sessionId: 'hive-session',
        runtimeId: 'xuanpu-agent',
        includeRenderedMarkdown: false,
        limit: 5
      })
      expect(fieldOps.listEpisodeBlocks).toHaveBeenCalledWith({
        worktreeId: 'worktree-1',
        sessionId: 'runtime-session',
        limit: 5
      })
      expect(fieldOps.listEpisodeBlocks).toHaveBeenCalledWith({
        worktreeId: 'worktree-1',
        sessionId: 'hive-session',
        limit: 5
      })
    })

    expect(await screen.findByText('Current Field')).toBeInTheDocument()
    expect(screen.getByText('Retrieved Episodes')).toBeInTheDocument()
    expect(screen.getAllByText(/balanced/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/~256 tokens/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/omitted-by-default/).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByText('Episodes'))
    expect(await screen.findByText('Frozen Conversation Turns')).toBeInTheDocument()
    expect(screen.getByText(/keep using pnpm/)).toBeInTheDocument()
    expect(screen.getByText(/src\/main\/services\/xuanpu-agent\/runtime\.ts/)).toBeInTheDocument()
  })

  it('replays provider-visible input for a provider request snapshot', async () => {
    const xuanpuAgentOps = installXuanpuAgentOpsMock()

    render(
      <ContextBudgetDebugger
        sessionId="hive-session"
        runtimeSessionId="runtime-session"
        worktreeId="worktree-1"
      />
    )

    fireEvent.click(screen.getByText('Context Budget'))
    fireEvent.click(await screen.findByText('Requests'))

    await waitFor(() => {
      expect(xuanpuAgentOps.listTaskRuns).toHaveBeenCalledWith('hive-session')
      expect(xuanpuAgentOps.listProviderRequests).toHaveBeenCalledWith('task-run-1')
    })

    fireEvent.click(await screen.findByText('hash-abc'))

    await waitFor(() => {
      expect(xuanpuAgentOps.getProviderRequestReplay).toHaveBeenCalledWith('snapshot-1')
    })

    expect(await screen.findByTestId('provider-request-replay')).toBeInTheDocument()
    expect(screen.getByText('provider messages')).toBeInTheDocument()
    expect(screen.getByText(/current request/)).toBeInTheDocument()
    expect(screen.getByText('provider tools')).toBeInTheDocument()
    expect(screen.getByText(/read_file/)).toBeInTheDocument()
    expect(screen.getByText('provider config')).toBeInTheDocument()
    expect(screen.getByText(/gpt-test/)).toBeInTheDocument()
    expect(screen.getByText('decisions')).toBeInTheDocument()
    expect(screen.getByText(/providerExecution/)).toBeInTheDocument()
  })
})
