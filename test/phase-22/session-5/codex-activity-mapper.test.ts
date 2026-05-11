/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest'

import { mapCodexManagerEventToActivity } from '../../../src/main/services/codex-activity-mapper'
import type { CodexManagerEvent } from '../../../src/main/services/codex-app-server-manager'

function makeEvent(overrides: Partial<CodexManagerEvent>): CodexManagerEvent {
  return {
    id: 'evt-1',
    kind: 'notification',
    provider: 'codex',
    threadId: 'thread-1',
    createdAt: '2026-05-09T10:00:00.000Z',
    method: '',
    ...overrides
  }
}

function payloadOf(activity: { payload_json?: string | null }): any {
  expect(activity.payload_json).toBeTruthy()
  return JSON.parse(activity.payload_json!)
}

describe('mapCodexManagerEventToActivity goal events', () => {
  it('persists thread/goal/updated as structured session info', () => {
    const activity = mapCodexManagerEventToActivity(
      'hive-1',
      'agent-thread-1',
      makeEvent({
        method: 'thread/goal/updated',
        turnId: 'turn-1',
        payload: {
          threadId: 'thread-1',
          goal: {
            threadId: 'thread-1',
            objective: 'Finish the migration',
            status: 'active',
            tokenBudget: 50000,
            tokensUsed: 1200,
            timeUsedSeconds: 90,
            createdAt: 10,
            updatedAt: 20
          }
        }
      })
    )

    expect(activity).toMatchObject({
      id: 'evt-1',
      session_id: 'hive-1',
      agent_session_id: 'agent-thread-1',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      kind: 'session.info',
      tone: 'info',
      summary: 'Goal updated: Finish the migration'
    })
    expect(payloadOf(activity!)).toMatchObject({
      kind: 'goal.updated',
      source: 'codex',
      status: 'active',
      threadId: 'thread-1',
      goal: {
        objective: 'Finish the migration',
        status: 'active',
        tokenBudget: 50000,
        tokensUsed: 1200,
        timeUsedSeconds: 90
      }
    })
  })

  it('persists thread/goal/cleared as structured session info', () => {
    const activity = mapCodexManagerEventToActivity(
      'hive-1',
      'agent-thread-1',
      makeEvent({
        method: 'thread/goal/cleared',
        payload: { threadId: 'thread-1' }
      })
    )

    expect(activity).toMatchObject({
      kind: 'session.info',
      tone: 'info',
      summary: 'Goal cleared'
    })
    expect(payloadOf(activity!)).toMatchObject({
      kind: 'goal.cleared',
      source: 'codex',
      goal: null,
      status: 'cleared',
      threadId: 'thread-1'
    })
  })

  it('drops invalid goal updates instead of writing empty state', () => {
    const activity = mapCodexManagerEventToActivity(
      'hive-1',
      'agent-thread-1',
      makeEvent({
        method: 'thread/goal/updated',
        payload: { threadId: 'thread-1', goal: { status: 'active' } }
      })
    )

    expect(activity).toBeNull()
  })
})
