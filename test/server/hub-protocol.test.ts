import { describe, it, expect } from 'vitest'
import {
  ServerMsgSchema,
  ClientMsgSchema,
  HubMessageSchema,
  MessageRingBuffer,
  SeqCounter,
  DEFAULT_RING_BUFFER_CAPACITY,
  PROTOCOL_VERSION,
  type ServerMsg,
  type HubMessage
} from '../../src/main/services/hub/hub-protocol'

describe('hub-protocol: PROTOCOL_VERSION', () => {
  it('is at least 1', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1)
  })
})

describe('hub-protocol: HubMessage zod schema', () => {
  it('parses a well-formed message with mixed parts', () => {
    const msg: HubMessage = {
      id: 'm1',
      role: 'assistant',
      ts: 1_700_000_000_000,
      seq: 7,
      parts: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', toolUseId: 't1', name: 'read', input: { file: 'x' }, pending: true },
        { type: 'unknown', raw: { weird: 1 } }
      ]
    }
    expect(HubMessageSchema.parse(msg)).toEqual(msg)
  })

  it('rejects an unknown part type', () => {
    expect(() =>
      HubMessageSchema.parse({
        id: 'm1',
        role: 'assistant',
        ts: 0,
        seq: 0,
        parts: [{ type: 'image', url: 'x' }]
      })
    ).toThrow()
  })
})

describe('hub-protocol: ServerMsg discriminated union', () => {
  it('parses session/snapshot', () => {
    const m: ServerMsg = {
      type: 'session/snapshot',
      seq: 0,
      status: 'idle',
      messages: [],
      lastSeq: 0
    }
    expect(ServerMsgSchema.parse(m)).toEqual(m)
  })

  it('parses message/update with appendText op', () => {
    const m: ServerMsg = {
      type: 'message/update',
      seq: 5,
      messageId: 'm1',
      patch: { op: 'appendText', partIdx: 0, value: ' world' }
    }
    expect(ServerMsgSchema.parse(m)).toEqual(m)
  })

  it('parses error without seq', () => {
    const parsed = ServerMsgSchema.parse({ type: 'error', code: 'AUTH_REQUIRED' })
    expect(parsed.type).toBe('error')
  })

  it('rejects an unknown error code', () => {
    expect(() =>
      ServerMsgSchema.parse({ type: 'error', code: 'BANANA' })
    ).toThrow()
  })
})

describe('hub-protocol: ClientMsg', () => {
  it('parses prompt', () => {
    expect(
      ClientMsgSchema.parse({ type: 'prompt', clientMsgId: 'c1', text: 'hi' })
    ).toEqual({ type: 'prompt', clientMsgId: 'c1', text: 'hi' })
  })

  it('parses permission/respond', () => {
    expect(
      ClientMsgSchema.parse({
        type: 'permission/respond',
        requestId: 'r1',
        decision: 'once'
      })
    ).toMatchObject({ type: 'permission/respond' })
  })

  it('rejects bogus messages', () => {
    expect(() => ClientMsgSchema.parse({ type: 'nope' })).toThrow()
    expect(() =>
      ClientMsgSchema.parse({ type: 'permission/respond', requestId: 'r1', decision: 'maybe' })
    ).toThrow()
  })
})

describe('hub-protocol: MessageRingBuffer', () => {
  function makeFrame(seq: number): ServerMsg {
    return { type: 'status', seq, status: 'idle' }
  }

  it('replays nothing when caught up', () => {
    const rb = new MessageRingBuffer(10)
    rb.push(makeFrame(1))
    rb.push(makeFrame(2))
    expect(rb.replayAfter(2)).toEqual({ ok: true, frames: [] })
  })

  it('replays only frames newer than lastSeq', () => {
    const rb = new MessageRingBuffer(10)
    for (let s = 1; s <= 5; s++) rb.push(makeFrame(s))
    const r = rb.replayAfter(3)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.frames.map((f) => f.seq)).toEqual([4, 5])
    }
  })

  it('returns NEED_FULL_RELOAD when the gap has been evicted', () => {
    const rb = new MessageRingBuffer(3)
    for (let s = 1; s <= 6; s++) rb.push(makeFrame(s))
    // buffer now holds seq 4,5,6. Client lastSeq=2 → seq 3 is gone.
    expect(rb.replayAfter(2)).toEqual({ ok: false, code: 'NEED_FULL_RELOAD' })
  })

  it('does not require reload when client is exactly at the oldest boundary', () => {
    const rb = new MessageRingBuffer(3)
    for (let s = 1; s <= 6; s++) rb.push(makeFrame(s))
    // oldest=4, lastSeq=3 → next needed=4 which is present.
    const r = rb.replayAfter(3)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.frames.map((f) => f.seq)).toEqual([4, 5, 6])
  })

  it('default capacity matches the documented value', () => {
    expect(DEFAULT_RING_BUFFER_CAPACITY).toBe(500)
  })

  it('ignores frames without seq (e.g. early errors)', () => {
    const rb = new MessageRingBuffer(3)
    rb.push({ type: 'error', code: 'AUTH_REQUIRED' } as ServerMsg)
    expect(rb.size()).toBe(0)
  })

  it('latestSeq tracks the newest pushed frame', () => {
    const rb = new MessageRingBuffer(10)
    expect(rb.latestSeq()).toBe(0)
    rb.push(makeFrame(42))
    expect(rb.latestSeq()).toBe(42)
  })
})

describe('hub-protocol: SeqCounter', () => {
  it('increments monotonically and supports reset', () => {
    const c = new SeqCounter()
    expect(c.next()).toBe(1)
    expect(c.next()).toBe(2)
    expect(c.current()).toBe(2)
    c.reset()
    expect(c.next()).toBe(1)
    c.reset(100)
    expect(c.next()).toBe(101)
  })
})
