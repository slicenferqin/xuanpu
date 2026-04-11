import { describe, it, expect, vi, beforeEach } from 'vitest'
import { normalizeAgentEvent } from '../../src/shared/lib/normalize-agent-event'

describe('normalizeAgentEvent', () => {
  describe('EventEnvelope stamping', () => {
    it('generates eventId when missing', () => {
      const raw = {
        type: 'session.updated',
        sessionId: 'sess-1',
        data: { title: 'hello' }
      }
      const result = normalizeAgentEvent(raw, 'opencode:stream')
      expect(result.eventId).toBeDefined()
      expect(typeof result.eventId).toBe('string')
      expect(result.eventId.length).toBeGreaterThan(0)
    })

    it('preserves existing eventId', () => {
      const raw = {
        type: 'session.updated',
        sessionId: 'sess-1',
        eventId: 'existing-id',
        data: { title: 'hello' }
      }
      const result = normalizeAgentEvent(raw, 'opencode:stream')
      expect(result.eventId).toBe('existing-id')
    })

    it('sets sessionSequence to 0 when missing', () => {
      const raw = {
        type: 'session.updated',
        sessionId: 'sess-1',
        data: { title: 'hello' }
      }
      const result = normalizeAgentEvent(raw, 'opencode:stream')
      expect(result.sessionSequence).toBe(0)
    })

    it('preserves existing sessionSequence', () => {
      const raw = {
        type: 'session.updated',
        sessionId: 'sess-1',
        sessionSequence: 42,
        data: { title: 'hello' }
      }
      const result = normalizeAgentEvent(raw, 'opencode:stream')
      expect(result.sessionSequence).toBe(42)
    })

    it('tags sourceChannel', () => {
      const raw = {
        type: 'session.updated',
        sessionId: 'sess-1',
        data: { title: 'hello' }
      }
      const result1 = normalizeAgentEvent(raw, 'opencode:stream')
      expect(result1.sourceChannel).toBe('opencode:stream')

      const raw2 = { ...raw }
      const result2 = normalizeAgentEvent(raw2, 'agent:stream')
      expect(result2.sourceChannel).toBe('agent:stream')
    })

    it('generates unique eventIds for different events', () => {
      const raw1 = { type: 'session.updated', sessionId: 's1', data: {} }
      const raw2 = { type: 'session.updated', sessionId: 's1', data: {} }
      const e1 = normalizeAgentEvent(raw1, 'opencode:stream')
      const e2 = normalizeAgentEvent(raw2, 'opencode:stream')
      expect(e1.eventId).not.toBe(e2.eventId)
    })
  })

  describe('statusPayload normalization', () => {
    it('promotes data.status to top-level statusPayload when missing', () => {
      const raw = {
        type: 'session.status',
        sessionId: 'sess-1',
        data: { status: { type: 'idle' } }
      }
      const result = normalizeAgentEvent(raw, 'opencode:stream')
      expect(result.type).toBe('session.status')
      if (result.type === 'session.status') {
        expect(result.statusPayload).toEqual({ type: 'idle' })
        expect(result.data.status).toEqual({ type: 'idle' })
      }
    })

    it('fills data.status from top-level statusPayload when data.status is missing', () => {
      const raw = {
        type: 'session.status',
        sessionId: 'sess-1',
        data: {},
        statusPayload: { type: 'busy', attempt: 1 }
      }
      const result = normalizeAgentEvent(raw, 'opencode:stream')
      if (result.type === 'session.status') {
        expect(result.statusPayload).toEqual({ type: 'busy', attempt: 1 })
        expect(result.data.status).toEqual({ type: 'busy', attempt: 1 })
      }
    })

    it('keeps both when both exist', () => {
      const raw = {
        type: 'session.status',
        sessionId: 'sess-1',
        data: { status: { type: 'retry', attempt: 2, next: 5000 } },
        statusPayload: { type: 'retry', attempt: 2, next: 5000 }
      }
      const result = normalizeAgentEvent(raw, 'opencode:stream')
      if (result.type === 'session.status') {
        expect(result.statusPayload).toEqual({ type: 'retry', attempt: 2, next: 5000 })
        expect(result.data.status).toEqual({ type: 'retry', attempt: 2, next: 5000 })
      }
    })

    it('does not touch non-status events', () => {
      const raw = {
        type: 'session.updated',
        sessionId: 'sess-1',
        data: { title: 'hello' }
      }
      const result = normalizeAgentEvent(raw, 'opencode:stream')
      // Should not have statusPayload
      expect((result as Record<string, unknown>).statusPayload).toBeUndefined()
    })
  })

  describe('event type pass-through', () => {
    it('preserves all canonical event types', () => {
      const types = [
        'session.materialized',
        'session.status',
        'session.updated',
        'session.warning',
        'session.error',
        'session.context_compacted',
        'session.compaction_started',
        'session.idle',
        'session.commands_available',
        'session.model_limits',
        'session.context_usage',
        'message.part.updated',
        'message.updated',
        'question.asked',
        'question.replied',
        'question.rejected',
        'permission.asked',
        'permission.replied',
        'command.approval_needed',
        'command.approval_replied',
        'command.approval_problem',
        'plan.ready',
        'plan.resolved'
      ] as const

      for (const eventType of types) {
        const raw = { type: eventType, sessionId: 'sess-1', data: {} }
        const result = normalizeAgentEvent(raw, 'opencode:stream')
        expect(result.type).toBe(eventType)
        expect(result.sessionId).toBe('sess-1')
      }
    })

    it('preserves childSessionId when present', () => {
      const raw = {
        type: 'message.part.updated',
        sessionId: 'parent-1',
        childSessionId: 'child-1',
        data: { delta: 'hello' }
      }
      const result = normalizeAgentEvent(raw, 'opencode:stream')
      expect(result.childSessionId).toBe('child-1')
    })

    it('preserves runtimeId when present', () => {
      const raw = {
        type: 'session.status',
        sessionId: 'sess-1',
        runtimeId: 'claude-code',
        data: { status: { type: 'idle' } }
      }
      const result = normalizeAgentEvent(raw, 'opencode:stream')
      expect(result.runtimeId).toBe('claude-code')
    })
  })

  describe('legacy field compatibility', () => {
    it('handles missing data field gracefully for status events', () => {
      const raw = {
        type: 'session.status',
        sessionId: 'sess-1',
        statusPayload: { type: 'idle' }
      }
      const result = normalizeAgentEvent(raw, 'opencode:stream')
      if (result.type === 'session.status') {
        expect(result.statusPayload).toEqual({ type: 'idle' })
        expect(result.data.status).toEqual({ type: 'idle' })
      }
    })
  })
})

// ---------------------------------------------------------------------------
// emitAgentEvent tests (main-process context, requires Electron mock)
// ---------------------------------------------------------------------------
describe('emitAgentEvent', () => {
  let emitAgentEvent: typeof import('../../src/shared/lib/normalize-agent-event').emitAgentEvent
  let resetSessionSequence: typeof import('../../src/shared/lib/normalize-agent-event').resetSessionSequence

  beforeEach(async () => {
    // Dynamic import to get fresh module state per test
    vi.resetModules()
    const mod = await import('../../src/shared/lib/normalize-agent-event')
    emitAgentEvent = mod.emitAgentEvent
    resetSessionSequence = mod.resetSessionSequence
  })

  it('does nothing when mainWindow is null', () => {
    expect(() =>
      emitAgentEvent(null as never, {
        type: 'session.updated',
        sessionId: 'sess-1',
        data: { title: 'hi' }
      })
    ).not.toThrow()
  })

  it('stamps eventId and sessionSequence', () => {
    let captured: unknown
    const mockWindow = {
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, data: unknown) => {
          captured = data
        }
      }
    }
    emitAgentEvent(mockWindow as never, {
      type: 'session.updated',
      sessionId: 'sess-1',
      data: { title: 'hello' }
    })

    const event = captured as Record<string, unknown>
    expect(event.eventId).toBeDefined()
    expect(event.sessionSequence).toBe(1)
    expect(event.type).toBe('session.updated')
  })

  it('increments sessionSequence per session', () => {
    const events: unknown[] = []
    const mockWindow = {
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, data: unknown) => {
          events.push(data)
        }
      }
    }
    emitAgentEvent(mockWindow as never, {
      type: 'session.status',
      sessionId: 'sess-A',
      data: { status: { type: 'busy' } }
    })
    emitAgentEvent(mockWindow as never, {
      type: 'session.status',
      sessionId: 'sess-A',
      data: { status: { type: 'idle' } }
    })
    emitAgentEvent(mockWindow as never, {
      type: 'session.status',
      sessionId: 'sess-B',
      data: { status: { type: 'busy' } }
    })

    expect((events[0] as Record<string, unknown>).sessionSequence).toBe(1)
    expect((events[1] as Record<string, unknown>).sessionSequence).toBe(2)
    expect((events[2] as Record<string, unknown>).sessionSequence).toBe(1) // different session
  })

  it('sends on opencode:stream channel', () => {
    let capturedChannel: string | undefined
    const mockWindow = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, _data: unknown) => {
          capturedChannel = channel
        }
      }
    }
    emitAgentEvent(mockWindow as never, {
      type: 'session.updated',
      sessionId: 'sess-1',
      data: { title: 'hi' }
    })
    expect(capturedChannel).toBe('opencode:stream')
  })

  it('resets sequence counter via resetSessionSequence', () => {
    const events: unknown[] = []
    const mockWindow = {
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, data: unknown) => {
          events.push(data)
        }
      }
    }
    emitAgentEvent(mockWindow as never, {
      type: 'session.status',
      sessionId: 'sess-X',
      data: { status: { type: 'busy' } }
    })
    expect((events[0] as Record<string, unknown>).sessionSequence).toBe(1)

    resetSessionSequence('sess-X')

    emitAgentEvent(mockWindow as never, {
      type: 'session.status',
      sessionId: 'sess-X',
      data: { status: { type: 'busy' } }
    })
    expect((events[1] as Record<string, unknown>).sessionSequence).toBe(1) // reset
  })
})
