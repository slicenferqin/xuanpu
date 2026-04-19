import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'

let activeSessionId = 'sess-1'
let streamCallback: ((event: Record<string, unknown>) => void) | null = null

const mockOnStream = vi.fn((cb: (event: Record<string, unknown>) => void) => {
  streamCallback = cb
  return () => {
    if (streamCallback === cb) {
      streamCallback = null
    }
  }
})

const mockOnBranchRenamed = vi.fn(() => () => {})

Object.defineProperty(window, 'agentOps', {
  writable: true,
  value: {
    onStream: mockOnStream
  }
})

Object.defineProperty(window, 'worktreeOps', {
  writable: true,
  value: {
    onBranchRenamed: mockOnBranchRenamed
  }
})

vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      activeSessionId,
      getSessionMode: vi.fn(() => 'build'),
      getPendingPlan: vi.fn(() => null),
      dequeueFollowUpMessage: vi.fn(() => null),
      requeueFollowUpMessageFront: vi.fn(),
      updateSessionName: vi.fn(),
      sessionsByWorktree: new Map(),
      sessionsByConnection: new Map()
    })
  }
}))

vi.mock('@/stores/useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: () => ({
      updateWorktreeBranch: vi.fn(),
      worktreesByProject: new Map()
    })
  }
}))

vi.mock('@/stores/useConnectionStore', () => ({
  useConnectionStore: {
    getState: () => ({
      connections: []
    })
  }
}))

vi.mock('@/stores/useWorktreeStatusStore', () => ({
  useWorktreeStatusStore: {
    getState: () => ({
      setSessionStatus: vi.fn(),
      clearSessionStatus: vi.fn(),
      setLastMessageTime: vi.fn(),
      sessionStatuses: {}
    })
  }
}))

vi.mock('@/stores/useQuestionStore', () => ({
  useQuestionStore: {
    getState: () => ({
      addQuestion: vi.fn(),
      removeQuestion: vi.fn()
    })
  }
}))

vi.mock('@/stores/usePermissionStore', () => ({
  usePermissionStore: {
    getState: () => ({
      addPermission: vi.fn(),
      removePermission: vi.fn(),
      pendingBySession: new Map()
    })
  }
}))

vi.mock('@/stores/useCommandApprovalStore', () => ({
  useCommandApprovalStore: {
    getState: () => ({
      addApproval: vi.fn(),
      removeApproval: vi.fn(),
      getApprovals: vi.fn(() => [])
    })
  }
}))

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      showUsageIndicator: false,
      commandFilter: { enabled: false, allowlist: [] },
      openSettings: vi.fn()
    })
  }
}))

vi.mock('@/stores/useContextStore', () => ({
  useContextStore: {
    getState: () => ({
      setSessionContextRefreshing: vi.fn(),
      setSessionTokens: vi.fn(),
      addSessionCost: vi.fn(),
      addSessionCostOnce: vi.fn(),
      setModelLimit: vi.fn()
    })
  }
}))

vi.mock('@/stores/useRecentStore', () => ({
  useRecentStore: {
    getState: () => ({
      addWorktreeToRecent: vi.fn(),
      addConnectionToRecent: vi.fn()
    })
  }
}))

vi.mock('@/stores', () => ({
  useUsageStore: {
    getState: () => ({
      fetchUsage: vi.fn(),
      fetchUsageForProvider: vi.fn()
    })
  },
  resolveUsageProvider: vi.fn(() => 'opencode')
}))

vi.mock('@/lib/token-utils', () => ({
  extractTokens: vi.fn(() => null),
  extractCost: vi.fn(() => 0),
  extractCostEventKey: vi.fn(() => null),
  extractModelRef: vi.fn(() => null),
  extractModelUsage: vi.fn(() => null)
}))

vi.mock('@/lib/context-usage', () => ({
  applySessionContextUsage: vi.fn()
}))

vi.mock('@/lib/permissionUtils', () => ({
  checkAutoApprove: vi.fn(() => false)
}))

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn()
  }
}))

import { useAgentEventBridge } from '../../src/renderer/src/hooks/useAgentEventBridge'
import {
  acceptSessionEvent,
  clearStreamingBuffer,
  getSessionEventGuardState,
  getStreamingBuffer,
  resetStreamingBuffersForTests,
  resetSessionEventGuardsForTests,
  setStreamingBuffer,
  useSessionRuntimeStore
} from '../../src/renderer/src/stores/useSessionRuntimeStore'
import type { CanonicalAgentEvent } from '../../src/shared/types/agent-protocol'

function makePartEvent(
  sessionId: string,
  runEpoch: number,
  sessionSequence: number,
  eventId: string
): CanonicalAgentEvent {
  return {
    type: 'message.part.updated',
    sessionId,
    runEpoch,
    sessionSequence,
    eventId,
    sourceChannel: 'agent:stream',
    data: {
      delta: eventId,
      part: { type: 'text', text: eventId }
    }
  }
}

describe('session event run guard', () => {
  beforeEach(() => {
    resetSessionEventGuardsForTests()
  })

  test('isolates 5 interleaved sessions by sessionId and runEpoch', () => {
    const acceptedBySession = new Map<string, string[]>()
    const events = [
      makePartEvent('sess-1', 1, 1, 's1-r1-1'),
      makePartEvent('sess-2', 1, 1, 's2-r1-1'),
      makePartEvent('sess-3', 2, 4, 's3-r2-4'),
      makePartEvent('sess-4', 1, 1, 's4-r1-1'),
      makePartEvent('sess-5', 3, 9, 's5-r3-9'),
      makePartEvent('sess-1', 1, 2, 's1-r1-2'),
      makePartEvent('sess-3', 1, 5, 's3-r1-stale'),
      makePartEvent('sess-2', 1, 1, 's2-r1-dup'),
      makePartEvent('sess-1', 2, 3, 's1-r2-3'),
      makePartEvent('sess-1', 1, 99, 's1-r1-late'),
      makePartEvent('sess-5', 2, 10, 's5-r2-late')
    ]

    for (const event of events) {
      const result = acceptSessionEvent(event)
      if (!result.accepted) continue
      const bucket = acceptedBySession.get(event.sessionId) ?? []
      bucket.push(event.eventId)
      acceptedBySession.set(event.sessionId, bucket)
    }

    expect(acceptedBySession.get('sess-1')).toEqual(['s1-r1-1', 's1-r1-2', 's1-r2-3'])
    expect(acceptedBySession.get('sess-2')).toEqual(['s2-r1-1'])
    expect(acceptedBySession.get('sess-3')).toEqual(['s3-r2-4'])
    expect(acceptedBySession.get('sess-4')).toEqual(['s4-r1-1'])
    expect(acceptedBySession.get('sess-5')).toEqual(['s5-r3-9'])

    expect(getSessionEventGuardState('sess-1')).toEqual({
      activeRunEpoch: 2,
      lastAppliedSequence: 3
    })
    expect(getSessionEventGuardState('sess-3')).toEqual({
      activeRunEpoch: 2,
      lastAppliedSequence: 4
    })
  })
})

describe('useAgentEventBridge runEpoch guard', () => {
  const sessionIds = ['sess-1', 'sess-2', 'sess-3', 'sess-4', 'sess-5'] as const

  beforeEach(() => {
    vi.clearAllMocks()
    activeSessionId = 'sess-1'
    streamCallback = null
    resetStreamingBuffersForTests()
    resetSessionEventGuardsForTests()

    for (const sessionId of sessionIds) {
      clearStreamingBuffer(sessionId)
      useSessionRuntimeStore.getState().clearSession(sessionId)
    }
  })

  afterEach(() => {
    cleanup()
  })

  test('dispatches only events from the active run for each session and clears stale overlays', () => {
    const received = new Map<string, string[]>()
    const unsubscribers = sessionIds.map((sessionId) =>
      useSessionRuntimeStore.getState().subscribeToSessionEvents(sessionId, (event) => {
        const bucket = received.get(sessionId) ?? []
        bucket.push(event.eventId)
        received.set(sessionId, bucket)
      })
    )

    setStreamingBuffer('sess-1', {
      activeRunEpoch: 0,
      lastAppliedSequence: -1,
      mirrorVersion: 0,
      parts: [{ type: 'text', text: 'old overlay' }],
      childParts: new Map(),
      streamingContent: 'old overlay',
      isStreaming: true
    })

    renderHook(() => useAgentEventBridge())
    expect(streamCallback).not.toBeNull()

    streamCallback!(makePartEvent('sess-1', 1, 1, 's1-r1-1'))
    streamCallback!(makePartEvent('sess-2', 1, 1, 's2-r1-1'))
    activeSessionId = 'sess-3'
    streamCallback!(makePartEvent('sess-3', 2, 4, 's3-r2-4'))
    streamCallback!(makePartEvent('sess-4', 1, 1, 's4-r1-1'))
    streamCallback!(makePartEvent('sess-5', 3, 9, 's5-r3-9'))
    streamCallback!(makePartEvent('sess-1', 1, 2, 's1-r1-2'))
    streamCallback!(makePartEvent('sess-3', 1, 5, 's3-r1-stale'))
    streamCallback!(makePartEvent('sess-2', 1, 1, 's2-r1-dup'))
    streamCallback!(makePartEvent('sess-1', 2, 3, 's1-r2-3'))
    streamCallback!(makePartEvent('sess-1', 1, 99, 's1-r1-late'))

    expect(received.get('sess-1')).toEqual(['s1-r1-1', 's1-r1-2', 's1-r2-3'])
    expect(received.get('sess-2')).toEqual(['s2-r1-1'])
    expect(received.get('sess-3')).toEqual(['s3-r2-4'])
    expect(received.get('sess-4')).toEqual(['s4-r1-1'])
    expect(received.get('sess-5')).toEqual(['s5-r3-9'])

    expect(getStreamingBuffer('sess-1')).toMatchObject({
      activeRunEpoch: 2,
      lastAppliedSequence: 3,
      streamingContent: 's1-r2-3',
      isStreaming: true
    })

    for (const unsubscribe of unsubscribers) {
      unsubscribe()
    }
  })
})
