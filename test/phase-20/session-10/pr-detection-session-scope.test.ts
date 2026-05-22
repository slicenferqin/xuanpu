import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { usePRDetection } from '../../../src/renderer/src/hooks/usePRDetection'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'
import { useSessionRuntimeStore } from '../../../src/renderer/src/stores/useSessionRuntimeStore'
import type { CanonicalAgentEvent } from '../../../src/shared/types/agent-protocol'

const mockOnStream = vi.fn(() => () => {})
const mockGetMessages = vi.fn()
const mockAttachPR = vi.fn()

Object.defineProperty(window, 'agentOps', {
  writable: true,
  value: {
    onStream: mockOnStream,
    getMessages: mockGetMessages
  }
})

Object.defineProperty(window, 'db', {
  writable: true,
  value: {
    worktree: {
      attachPR: mockAttachPR
    }
  }
})

const mockWorktreeState: {
  worktreesByProject: Map<string, Array<{ id: string; path: string }>>
} = {
  worktreesByProject: new Map()
}

const mockSessionState: {
  sessionsByWorktree: Map<string, Array<{ id: string; opencode_session_id: string | null }>>
} = {
  sessionsByWorktree: new Map()
}

vi.mock('@/stores/useWorktreeStore', () => ({
  useWorktreeStore: Object.assign(
    <T>(selector: (state: typeof mockWorktreeState) => T): T => selector(mockWorktreeState),
    {
      getState: () => mockWorktreeState
    }
  )
}))

vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: Object.assign(
    <T>(selector: (state: typeof mockSessionState) => T): T => selector(mockSessionState),
    {
      getState: () => mockSessionState
    }
  )
}))

function makeTextDeltaEvent(
  sessionId: string,
  delta: string,
  sequence: number
): CanonicalAgentEvent {
  return {
    type: 'message.part.updated',
    sessionId,
    runEpoch: 1,
    sessionSequence: sequence,
    eventId: `${sessionId}-${sequence}`,
    sourceChannel: 'agent:stream',
    data: {
      part: {
        type: 'text',
        text: delta
      },
      delta
    }
  } as CanonicalAgentEvent
}

describe('Session 10: PR detection session scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAttachPR.mockResolvedValue({ success: true })
    mockGetMessages.mockResolvedValue({ success: true, messages: [] })

    mockWorktreeState.worktreesByProject = new Map([
      [
        'project-1',
        [
          { id: 'wt-1', path: '/repo/wt-1' },
          { id: 'wt-2', path: '/repo/wt-2' }
        ]
      ]
    ])

    mockSessionState.sessionsByWorktree = new Map([
      [
        'wt-1',
        [
          {
            id: 'session-1',
            opencode_session_id: null
          }
        ]
      ],
      [
        'wt-2',
        [
          {
            id: 'session-2',
            opencode_session_id: null
          }
        ]
      ]
    ])

    useGitStore.setState({
      prCreation: new Map(),
      attachedPR: new Map(),
      fileStatusesByWorktree: new Map(),
      branchInfoByWorktree: new Map(),
      conflictsByWorktree: {},
      remoteInfo: new Map(),
      prTargetBranch: new Map(),
      reviewTargetBranch: new Map(),
      defaultMergeBranch: new Map(),
      selectedMergeBranch: new Map(),
      selectedDiffBranch: new Map(),
      mergeSelectionVersion: 0,
      isLoading: false,
      error: null,
      isCommitting: false,
      isPushing: false,
      isPulling: false
    })

    useSessionRuntimeStore.getState().clearSession('session-1')
    useSessionRuntimeStore.getState().clearSession('session-2')
  })

  afterEach(() => {
    cleanup()
  })

  test('consumes accepted runtime events without subscribing to the raw stream', () => {
    act(() => {
      useGitStore.getState().setPrCreation('wt-1', {
        creating: true,
        sessionId: 'session-1'
      })
      useGitStore.getState().setPrCreation('wt-2', {
        creating: true,
        sessionId: 'session-2'
      })
    })

    renderHook(() => usePRDetection('wt-1'))
    expect(mockOnStream).not.toHaveBeenCalled()

    act(() => {
      useSessionRuntimeStore
        .getState()
        .dispatchToSession(
          'session-2',
          makeTextDeltaEvent('session-2', 'https://github.com/org/repo/pull/22', 1)
        )
    })

    expect(useGitStore.getState().prCreation.get('wt-1')?.creating).toBe(true)
    expect(useGitStore.getState().prCreation.get('wt-2')?.creating).toBe(true)
    expect(useGitStore.getState().attachedPR.get('wt-1')).toBeUndefined()

    act(() => {
      useSessionRuntimeStore
        .getState()
        .dispatchToSession(
          'session-1',
          makeTextDeltaEvent('session-1', 'https://github.com/org/repo/pull/11', 2)
        )
    })

    expect(useGitStore.getState().prCreation.get('wt-1')).toBeUndefined()
    expect(useGitStore.getState().attachedPR.get('wt-1')).toEqual({
      number: 11,
      url: 'https://github.com/org/repo/pull/11'
    })
    expect(mockAttachPR).toHaveBeenCalledWith('wt-1', 11, 'https://github.com/org/repo/pull/11')
    expect(mockGetMessages).not.toHaveBeenCalled()
  })

  test('detects a PR URL split across accepted runtime text deltas', () => {
    act(() => {
      useGitStore.getState().setPrCreation('wt-1', {
        creating: true,
        sessionId: 'session-1'
      })
    })

    renderHook(() => usePRDetection('wt-1'))

    act(() => {
      const runtime = useSessionRuntimeStore.getState()
      runtime.dispatchToSession('session-1', makeTextDeltaEvent('session-1', 'Created at ', 1))
      runtime.dispatchToSession(
        'session-1',
        makeTextDeltaEvent('session-1', 'https://github.com/', 2)
      )
      runtime.dispatchToSession('session-1', makeTextDeltaEvent('session-1', 'org/repo/pull/', 3))
      runtime.dispatchToSession('session-1', makeTextDeltaEvent('session-1', '77', 4))
    })

    expect(useGitStore.getState().prCreation.get('wt-1')).toBeUndefined()
    expect(useGitStore.getState().attachedPR.get('wt-1')).toEqual({
      number: 77,
      url: 'https://github.com/org/repo/pull/77'
    })
  })
})
