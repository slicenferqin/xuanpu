import { describe, expect, it } from 'vitest'

import { deriveCodexTimelineMessages } from '../../../src/renderer/src/lib/codex-timeline'

describe('codex timeline derivation', () => {
  it('attaches tool activities to the nearest assistant turn instead of rendering them above the transcript', () => {
    const messages: SessionMessage[] = [
      {
        id: 'db-user-1',
        session_id: 'session-1',
        role: 'user',
        content: 'Please inspect the repo',
        opencode_message_id: 'turn-1:user',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([
          { type: 'text', text: 'Please inspect the repo', timestamp: '2026-03-14T10:00:00.000Z' }
        ]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:00.000Z'
      },
      {
        id: 'db-assistant-1',
        session_id: 'session-1',
        role: 'assistant',
        content: 'I checked the repo and found the issue.',
        opencode_message_id: 'turn-1:assistant',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([
          {
            type: 'text',
            text: 'I checked the repo and found the issue.',
            timestamp: '2026-03-14T10:00:10.000Z'
          }
        ]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:10.000Z'
      }
    ]

    const activities: SessionActivity[] = [
      {
        id: 'activity-1',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: null,
        item_id: 'tool-1',
        request_id: null,
        kind: 'tool.completed',
        tone: 'tool',
        summary: 'Read',
        payload_json: JSON.stringify({
          item: {
            toolName: 'Read',
            input: { filePath: 'src/index.ts' },
            output: 'ok'
          }
        }),
        sequence: null,
        created_at: '2026-03-14T10:00:03.000Z'
      }
    ]

    const timeline = deriveCodexTimelineMessages(messages, activities)

    expect(timeline).toHaveLength(2)
    expect(timeline[0]?.id).toBe('turn-1:user')
    expect(timeline[1]?.id).toBe('turn-1:assistant')
    expect(timeline[1]?.parts?.some((part) => part.type === 'tool_use')).toBe(true)
  })

  it('projects persisted plan.ready activity into an ExitPlanMode tool card', () => {
    const messages: SessionMessage[] = [
      {
        id: 'db-user-1',
        session_id: 'session-1',
        role: 'user',
        content: 'Plan this change',
        opencode_message_id: 'turn-1:user',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([
          { type: 'text', text: 'Plan this change', timestamp: '2026-03-14T10:00:00.000Z' }
        ]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:00.000Z'
      },
      {
        id: 'db-assistant-1',
        session_id: 'session-1',
        role: 'assistant',
        content: 'Here is the plan.',
        opencode_message_id: 'turn-1:assistant',
        opencode_message_json: null,
        opencode_parts_json: JSON.stringify([
          {
            type: 'text',
            text: 'Here is the plan.',
            timestamp: '2026-03-14T10:00:10.000Z'
          }
        ]),
        opencode_timeline_json: null,
        created_at: '2026-03-14T10:00:10.000Z'
      }
    ]

    const activities: SessionActivity[] = [
      {
        id: 'plan-ready-1',
        session_id: 'session-1',
        agent_session_id: 'thread-1',
        thread_id: 'thread-1',
        turn_id: null,
        item_id: null,
        request_id: 'codex-plan:thread-1',
        kind: 'plan.ready',
        tone: 'info',
        summary: 'Plan ready',
        payload_json: JSON.stringify({
          plan: 'Plan\n\n1. Add the function\n2. Add tests',
          toolUseID: 'codex-exitplan-tool-1'
        }),
        sequence: null,
        created_at: '2026-03-14T10:00:11.000Z'
      }
    ]

    const timeline = deriveCodexTimelineMessages(messages, activities)
    const assistant = timeline.find((message) => message.id === 'turn-1:assistant')

    expect(assistant?.parts?.some(
      (part) =>
        part.type === 'tool_use' &&
        part.toolUse?.name === 'ExitPlanMode' &&
        String(part.toolUse.input?.plan) === 'Plan\n\n1. Add the function\n2. Add tests' &&
        part.toolUse.status === 'pending'
    )).toBe(true)
  })
})
