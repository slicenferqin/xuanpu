import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineMessage } from '../../src/shared/lib/timeline-types'
import { useSessionMissionTasks } from '../../src/renderer/src/hooks/useSessionMissionTasks'
import { useSessionRuntimeStore } from '../../src/renderer/src/stores/useSessionRuntimeStore'

const SESSION_ID = 'mission-tasks-session'

function resetRuntimeStore(): void {
  const state = useSessionRuntimeStore.getState()
  for (const sessionId of state.sessions.keys()) {
    state.clearSession(sessionId)
  }
  state.clearSessionTasks(SESSION_ID)
}

function userMessage(id: string): TimelineMessage {
  return {
    id,
    role: 'user',
    content: `user ${id}`,
    timestamp: '2026-05-26T00:00:00.000Z'
  }
}

describe('useSessionMissionTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRuntimeStore()
  })

  it('mirrors streamed task tool updates into runtime task state', () => {
    const { result } = renderHook(() =>
      useSessionMissionTasks({
        sessionId: SESSION_ID,
        timelineMessages: [userMessage('u-1')]
      })
    )

    act(() => {
      result.current.applyMissionTaskToolEvent(
        'TodoWrite',
        {
          todos: [
            {
              id: 'task-1',
              content: 'Read the plan',
              status: 'in_progress',
              priority: 'high'
            }
          ]
        },
        'tool-1'
      )
    })

    expect(useSessionRuntimeStore.getState().getSessionTasks(SESSION_ID)).toEqual([
      {
        id: 'task-1',
        content: 'Read the plan',
        status: 'in_progress',
        priority: 'high'
      }
    ])
  })

  it('clears shared tasks when the latest user round changes', async () => {
    useSessionRuntimeStore.getState().setSessionTasks(SESSION_ID, [
      {
        id: 'task-1',
        content: 'Old round task',
        status: 'pending'
      }
    ])
    const { rerender } = renderHook(
      ({ messages }) =>
        useSessionMissionTasks({
          sessionId: SESSION_ID,
          timelineMessages: messages
        }),
      {
        initialProps: {
          messages: [userMessage('u-1')]
        }
      }
    )

    rerender({ messages: [userMessage('u-1'), userMessage('u-2')] })

    await waitFor(() => {
      expect(useSessionRuntimeStore.getState().getSessionTasks(SESSION_ID)).toEqual([])
    })
  })
})
