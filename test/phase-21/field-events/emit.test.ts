import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Mock the database BEFORE importing emit (which transitively imports privacy/sink/db)
vi.mock('../../../src/main/db', () => ({
  getDatabase: vi.fn()
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import { emitFieldEvent } from '../../../src/main/field/emit'
import { getFieldEventSink, resetFieldEventSink } from '../../../src/main/field/sink'
import {
  invalidatePrivacyCache,
  setFieldCollectionEnabledCache
} from '../../../src/main/field/privacy'
import { getEventBus, resetEventBus } from '../../../src/server/event-bus'
import type { FieldEvent } from '../../../src/shared/types/field-event'

describe('emitFieldEvent — Phase 21 M2', () => {
  beforeEach(() => {
    resetFieldEventSink()
    resetEventBus()
    invalidatePrivacyCache()
    setFieldCollectionEnabledCache(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('enqueues to sink on the primary path', () => {
    const sink = getFieldEventSink()
    const enqueueSpy = vi.spyOn(sink, 'enqueue')

    emitFieldEvent({
      type: 'worktree.switch',
      worktreeId: 'w-1',
      projectId: 'p-1',
      sessionId: null,
      relatedEventId: null,
      payload: { fromWorktreeId: null, toWorktreeId: 'w-1', trigger: 'user-click' }
    })

    expect(enqueueSpy).toHaveBeenCalledOnce()
    const [event, serialized] = enqueueSpy.mock.calls[0]
    expect(event.type).toBe('worktree.switch')
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(typeof event.timestamp).toBe('number')
    expect(JSON.parse(serialized)).toEqual({
      fromWorktreeId: null,
      toWorktreeId: 'w-1',
      trigger: 'user-click'
    })
  })

  it('broadcasts on the EventBus as a secondary path', () => {
    const received: FieldEvent[] = []
    getEventBus().on('field:event', (e) => received.push(e))

    emitFieldEvent({
      type: 'terminal.command',
      worktreeId: 'w-1',
      projectId: 'p-1',
      sessionId: null,
      relatedEventId: null,
      payload: { command: 'ls' }
    })

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('terminal.command')
  })

  it('persists even when a bus listener throws', () => {
    const sink = getFieldEventSink()
    const enqueueSpy = vi.spyOn(sink, 'enqueue')

    getEventBus().on('field:event', () => {
      throw new Error('boom')
    })

    expect(() =>
      emitFieldEvent({
        type: 'session.message',
        worktreeId: 'w-1',
        projectId: 'p-1',
        sessionId: 's-1',
        relatedEventId: null,
        payload: {
          agentSdk: 'claude-code',
          agentSessionId: 'a-1',
          text: 'hi',
          attachmentCount: 0
        }
      })
    ).not.toThrow()

    expect(enqueueSpy).toHaveBeenCalledOnce()
  })

  it('drops sensitive events when collection is disabled (gated at emit)', () => {
    const sink = getFieldEventSink()
    const enqueueSpy = vi.spyOn(sink, 'enqueue')
    setFieldCollectionEnabledCache(false)

    emitFieldEvent({
      type: 'session.message',
      worktreeId: 'w-1',
      projectId: 'p-1',
      sessionId: 's-1',
      relatedEventId: null,
      payload: { agentSdk: 'codex', agentSessionId: 'a-1', text: 'secret', attachmentCount: 0 }
    })

    expect(enqueueSpy).not.toHaveBeenCalled()
    expect(sink.getCounters().dropped_privacy).toBe(1)
  })

  it('also gates worktree.switch (no event types are exempt)', () => {
    const sink = getFieldEventSink()
    const enqueueSpy = vi.spyOn(sink, 'enqueue')
    setFieldCollectionEnabledCache(false)

    emitFieldEvent({
      type: 'worktree.switch',
      worktreeId: 'w-1',
      projectId: 'p-1',
      sessionId: null,
      relatedEventId: null,
      payload: { fromWorktreeId: null, toWorktreeId: 'w-1', trigger: 'user-click' }
    })

    expect(enqueueSpy).not.toHaveBeenCalled()
    expect(sink.getCounters().dropped_privacy).toBe(1)
  })

  it('does not throw when payload contains a circular reference', () => {
    const sink = getFieldEventSink()
    const enqueueSpy = vi.spyOn(sink, 'enqueue')

    const circular: Record<string, unknown> = { command: 'echo' }
    circular.self = circular

    expect(() =>
      emitFieldEvent({
        type: 'terminal.command',
        worktreeId: 'w-1',
        projectId: 'p-1',
        sessionId: null,
        relatedEventId: null,
        // @ts-expect-error — deliberately bad payload
        payload: circular
      })
    ).not.toThrow()

    expect(enqueueSpy).not.toHaveBeenCalled()
    expect(sink.getCounters().dropped_invalid).toBe(1)
  })
})
