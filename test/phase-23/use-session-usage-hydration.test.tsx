import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineMessage } from '../../src/shared/lib/timeline-types'
import {
  applyCompletedMessageUsage,
  useSessionUsageHydration
} from '../../src/renderer/src/hooks/useSessionUsageHydration'
import { useContextStore } from '../../src/renderer/src/stores/useContextStore'

const SESSION_ID = 'usage-hydration-session'

function resetContextStore(): void {
  useContextStore.setState({
    tokensBySession: {},
    modelBySession: {},
    contextSnapshotsBySession: {},
    costBySession: {},
    costEventKeysBySession: {},
    modelLimits: {}
  })
}

function installUsageOps(totalCost = 0): ReturnType<typeof vi.fn> {
  const fetchSessionSummary = vi.fn().mockResolvedValue({
    success: true,
    data: { total_cost: totalCost }
  })
  Object.defineProperty(window, 'usageAnalyticsOps', {
    writable: true,
    configurable: true,
    value: { fetchSessionSummary }
  })
  return fetchSessionSummary
}

function installAgentMessages(messages: unknown[]): ReturnType<typeof vi.fn> {
  const getMessages = vi.fn().mockResolvedValue({
    success: true,
    messages
  })
  Object.defineProperty(window, 'agentOps', {
    writable: true,
    configurable: true,
    value: { getMessages }
  })
  return getMessages
}

function assistantMessage(id: string, usage: TimelineMessage['usage']): TimelineMessage {
  return {
    id,
    role: 'assistant',
    content: 'done',
    timestamp: '2026-05-26T00:00:00.000Z',
    usage,
    modelRef: { providerID: 'codex', modelID: 'gpt-test' }
  }
}

describe('useSessionUsageHydration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetContextStore()
    installUsageOps()
    installAgentMessages([])
  })

  it('hydrates persisted cost and timeline token snapshots without clobbering live tokens', async () => {
    const fetchSessionSummary = installUsageOps(4.25)
    const timelineMessages = [
      assistantMessage('assistant-1', {
        input: 10,
        output: 5,
        reasoning: 2,
        cacheRead: 3,
        cacheWrite: 1
      })
    ]

    renderHook(() =>
      useSessionUsageHydration({
        sessionId: SESSION_ID,
        timelineMessages,
        worktreePath: null,
        runtimeSessionId: null,
        currentProviderId: 'codex'
      })
    )

    await waitFor(() => {
      expect(fetchSessionSummary).toHaveBeenCalledWith(SESSION_ID)
      expect(useContextStore.getState().costBySession[SESSION_ID]).toBe(4.25)
      expect(useContextStore.getState().tokensBySession[SESSION_ID]).toEqual({
        input: 10,
        output: 5,
        reasoning: 2,
        cacheRead: 3,
        cacheWrite: 1
      })
    })

    renderHook(() =>
      useSessionUsageHydration({
        sessionId: SESSION_ID,
        timelineMessages: [
          assistantMessage('assistant-2', {
            input: 99,
            output: 99,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0
          })
        ],
        worktreePath: null,
        runtimeSessionId: null,
        currentProviderId: 'codex'
      })
    )

    expect(useContextStore.getState().tokensBySession[SESSION_ID]).toEqual({
      input: 10,
      output: 5,
      reasoning: 2,
      cacheRead: 3,
      cacheWrite: 1
    })
  })

  it('hydrates usage from SDK transcript messages when runtime messages are available', async () => {
    const getMessages = installAgentMessages([
      {
        info: { role: 'assistant' },
        usage: { input: 3, output: 4 },
        cost: 0.75,
        model: 'codex/gpt-5-mini'
      },
      {
        info: { role: 'assistant' },
        usage: { input: 8, output: 1, cacheRead: 2 },
        cost: 1.25,
        model: 'codex/gpt-5'
      }
    ])

    renderHook(() =>
      useSessionUsageHydration({
        sessionId: SESSION_ID,
        timelineMessages: [],
        worktreePath: '/tmp/project',
        runtimeSessionId: 'runtime-1',
        currentProviderId: 'codex'
      })
    )

    await waitFor(() => {
      expect(getMessages).toHaveBeenCalledWith('/tmp/project', 'runtime-1')
      expect(useContextStore.getState().tokensBySession[SESSION_ID]).toEqual({
        input: 8,
        output: 1,
        reasoning: 0,
        cacheRead: 2,
        cacheWrite: 0
      })
      expect(useContextStore.getState().costBySession[SESSION_ID]).toBe(2)
    })
  })

  it('applies completed message usage events with cost dedupe and model limits', () => {
    applyCompletedMessageUsage(
      SESSION_ID,
      {
        id: 'message-1',
        usage: { input: 11, output: 7 },
        cost: 0.42,
        model: 'codex/gpt-5',
        modelUsage: {
          'gpt-5': {
            inputTokens: 11,
            outputTokens: 7,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.42,
            contextWindow: 272000
          }
        }
      },
      'codex'
    )
    applyCompletedMessageUsage(
      SESSION_ID,
      {
        id: 'message-1',
        usage: { input: 11, output: 7 },
        cost: 0.42,
        model: 'codex/gpt-5'
      },
      'codex'
    )

    expect(useContextStore.getState().tokensBySession[SESSION_ID]).toEqual({
      input: 11,
      output: 7,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0
    })
    expect(useContextStore.getState().costBySession[SESSION_ID]).toBe(0.42)
    expect(useContextStore.getState().modelLimits['*::gpt-5']).toBe(272000)
  })
})
