import { describe, it, expect, beforeEach } from 'vitest'
import {
  mapOpenCodeEventToActivity,
  type ToolStartedTracker
} from '../../src/main/services/opencode-activity-mapper'

const HIVE = 'hive-session-1'
const AGENT = 'opencode-session-1'

function freshTracker(): ToolStartedTracker {
  return new Set<string>()
}

describe('mapOpenCodeEventToActivity', () => {
  let tracker: ToolStartedTracker

  beforeEach(() => {
    tracker = freshTracker()
  })

  describe('tool lifecycle (message.part.updated)', () => {
    it('emits tool.started on first running update for a callID', () => {
      const result = mapOpenCodeEventToActivity(
        HIVE,
        AGENT,
        {
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool',
              callID: 'call-1',
              tool: 'Bash',
              toolDisplay: 'bash',
              state: { status: 'running', input: { command: 'ls' } }
            }
          }
        },
        tracker
      )
      expect(result?.kind).toBe('tool.started')
      expect(result?.tone).toBe('tool')
      expect(result?.summary).toBe('bash')
      expect(result?.item_id).toBe('call-1')
      expect(tracker.has('call-1')).toBe(true)
    })

    it('emits tool.updated on subsequent running updates for the same callID', () => {
      tracker.add('call-2')
      const result = mapOpenCodeEventToActivity(
        HIVE,
        AGENT,
        {
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool',
              callID: 'call-2',
              tool: 'Read',
              state: { status: 'running' }
            }
          }
        },
        tracker
      )
      expect(result?.kind).toBe('tool.updated')
      expect(result?.tone).toBe('tool')
    })

    it('emits tool.completed and clears tracker on completed', () => {
      tracker.add('call-3')
      const result = mapOpenCodeEventToActivity(
        HIVE,
        AGENT,
        {
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool',
              callID: 'call-3',
              tool: 'Edit',
              state: { status: 'completed', output: 'done' }
            }
          }
        },
        tracker
      )
      expect(result?.kind).toBe('tool.completed')
      expect(result?.tone).toBe('tool')
      expect(tracker.has('call-3')).toBe(false)
    })

    it('emits tool.failed on error status with error tone', () => {
      tracker.add('call-4')
      const result = mapOpenCodeEventToActivity(
        HIVE,
        AGENT,
        {
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool',
              callID: 'call-4',
              tool: 'Bash',
              state: { status: 'error', error: 'oops' }
            }
          }
        },
        tracker
      )
      expect(result?.kind).toBe('tool.failed')
      expect(result?.tone).toBe('error')
      expect(tracker.has('call-4')).toBe(false)
    })

    it('treats cancelled status as tool.failed', () => {
      const result = mapOpenCodeEventToActivity(
        HIVE,
        AGENT,
        {
          type: 'message.part.updated',
          properties: {
            part: {
              type: 'tool',
              callID: 'call-5',
              tool: 'Grep',
              state: { status: 'cancelled' }
            }
          }
        },
        tracker
      )
      expect(result?.kind).toBe('tool.failed')
      expect(result?.tone).toBe('error')
    })

    it('returns null when part type is not tool', () => {
      const result = mapOpenCodeEventToActivity(
        HIVE,
        AGENT,
        {
          type: 'message.part.updated',
          properties: { part: { type: 'text', text: 'hi' } }
        },
        tracker
      )
      expect(result).toBeNull()
    })

    it('returns null when callID is missing', () => {
      const result = mapOpenCodeEventToActivity(
        HIVE,
        AGENT,
        {
          type: 'message.part.updated',
          properties: { part: { type: 'tool', state: { status: 'running' } } }
        },
        tracker
      )
      expect(result).toBeNull()
    })

    it('returns null on unknown tool status (e.g. pending without callID flow)', () => {
      const result = mapOpenCodeEventToActivity(
        HIVE,
        AGENT,
        {
          type: 'message.part.updated',
          properties: {
            part: { type: 'tool', callID: 'x', state: { status: 'foo' } }
          }
        },
        tracker
      )
      expect(result).toBeNull()
    })
  })

  describe('session lifecycle', () => {
    it('maps session.idle to session.info', () => {
      const result = mapOpenCodeEventToActivity(
        HIVE,
        AGENT,
        { type: 'session.idle', properties: { sessionID: AGENT } },
        tracker
      )
      expect(result?.kind).toBe('session.info')
      expect(result?.tone).toBe('info')
      expect(result?.summary).toBe('Session idle')
    })

    it('maps session.error with extracted message', () => {
      const result = mapOpenCodeEventToActivity(
        HIVE,
        AGENT,
        { type: 'session.error', properties: { error: { message: 'boom' } } },
        tracker
      )
      expect(result?.kind).toBe('session.error')
      expect(result?.tone).toBe('error')
      expect(result?.summary).toBe('boom')
    })

    it('falls back to default summary for session.error without message', () => {
      const result = mapOpenCodeEventToActivity(
        HIVE,
        AGENT,
        { type: 'session.error', properties: {} },
        tracker
      )
      expect(result?.kind).toBe('session.error')
      expect(result?.summary).toBe('Session error')
    })
  })

  describe('HITL events', () => {
    it('maps question.asked to user-input.requested', () => {
      const result = mapOpenCodeEventToActivity(
        HIVE,
        AGENT,
        {
          type: 'question.asked',
          properties: { id: 'q-1', requestId: 'req-1', questions: [] }
        },
        tracker
      )
      expect(result?.kind).toBe('user-input.requested')
      expect(result?.tone).toBe('approval')
      expect(result?.item_id).toBe('q-1')
      expect(result?.request_id).toBe('req-1')
    })

    it('maps permission.asked to approval.requested', () => {
      const result = mapOpenCodeEventToActivity(
        HIVE,
        AGENT,
        {
          type: 'permission.asked',
          properties: { id: 'p-1', permission: 'execute(rm)', patterns: ['rm *'] }
        },
        tracker
      )
      expect(result?.kind).toBe('approval.requested')
      expect(result?.tone).toBe('approval')
      expect(result?.summary).toBe('execute(rm)')
    })

    it('maps command.approval_needed to approval.requested', () => {
      const result = mapOpenCodeEventToActivity(
        HIVE,
        AGENT,
        {
          type: 'command.approval_needed',
          properties: { requestId: 'cmd-1', commandStr: 'git push --force' }
        },
        tracker
      )
      expect(result?.kind).toBe('approval.requested')
      expect(result?.tone).toBe('approval')
      expect(result?.summary).toBe('git push --force')
      expect(result?.request_id).toBe('cmd-1')
    })
  })

  describe('noisy events', () => {
    it('returns null for unknown event types', () => {
      expect(
        mapOpenCodeEventToActivity(HIVE, AGENT, { type: 'server.heartbeat' }, tracker)
      ).toBeNull()
      expect(
        mapOpenCodeEventToActivity(HIVE, AGENT, { type: 'message.updated' }, tracker)
      ).toBeNull()
    })

    it('returns null for events without a type', () => {
      expect(mapOpenCodeEventToActivity(HIVE, AGENT, {}, tracker)).toBeNull()
    })
  })

  describe('payload preservation', () => {
    it('serializes raw event properties into payload_json', () => {
      const result = mapOpenCodeEventToActivity(
        HIVE,
        AGENT,
        { type: 'session.idle', properties: { sessionID: 'opencode-x', extra: 1 } },
        tracker
      )
      expect(result?.payload_json).not.toBeNull()
      const parsed = JSON.parse(result!.payload_json!)
      expect(parsed).toMatchObject({ sessionID: 'opencode-x', extra: 1 })
    })

    it('produces deterministic id for tool transitions (callID:kind)', () => {
      const a = mapOpenCodeEventToActivity(
        HIVE,
        AGENT,
        {
          type: 'message.part.updated',
          properties: {
            part: { type: 'tool', callID: 'fixed-id', tool: 'Bash', state: { status: 'completed' } }
          }
        },
        tracker
      )
      // Re-run with a fresh tracker — same id should be generated.
      const b = mapOpenCodeEventToActivity(
        HIVE,
        AGENT,
        {
          type: 'message.part.updated',
          properties: {
            part: { type: 'tool', callID: 'fixed-id', tool: 'Bash', state: { status: 'completed' } }
          }
        },
        freshTracker()
      )
      expect(a?.id).toBe('fixed-id:tool.completed')
      expect(b?.id).toBe('fixed-id:tool.completed')
    })
  })
})
