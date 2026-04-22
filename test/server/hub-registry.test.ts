import { describe, it, expect, vi } from 'vitest'
import { HubRegistry, WS_OPEN, type HubSubscriber } from '../../src/main/services/hub/hub-registry'
import type { ServerMsg } from '../../src/main/services/hub/hub-protocol'

function makeWs(): HubSubscriber & { sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    readyState: WS_OPEN,
    send(data: string) {
      sent.push(data)
    }
  }
}

function statusFrame(seq: number): ServerMsg {
  return { type: 'status', seq, status: 'idle' }
}

describe('HubRegistry: devices', () => {
  it('includes the local device by default', () => {
    const r = new HubRegistry({ localDeviceId: 'dev-1', localDeviceName: 'laptop' })
    const devs = r.listDevices()
    expect(devs).toHaveLength(1)
    expect(devs[0].id).toBe('dev-1')
    expect(devs[0].name).toBe('laptop')
    expect(devs[0].online).toBe(true)
  })

  it('computes a stable localDeviceId when not provided', () => {
    const a = new HubRegistry()
    const b = new HubRegistry()
    expect(a.localDeviceId).toBe(b.localDeviceId)
    expect(a.localDeviceId).toMatch(/.+-[0-9a-f]{12}$/)
  })
})

describe('HubRegistry: subscribe/broadcast', () => {
  it('broadcasts to multiple subscribers and buffers frames', () => {
    const r = new HubRegistry({ localDeviceId: 'd' })
    const a = makeWs()
    const b = makeWs()
    r.subscribe(a, 'd', 's1')
    r.subscribe(b, 'd', 's1')
    const seq = r.nextSeq('d', 's1')
    r.broadcast('d', 's1', statusFrame(seq))
    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(1)
    expect(JSON.parse(a.sent[0])).toMatchObject({ type: 'status', seq: 1 })
  })

  it('subscribe replays buffered frames and returns current seq/status', () => {
    const r = new HubRegistry({ localDeviceId: 'd' })
    for (let i = 0; i < 3; i++) {
      const s = r.nextSeq('d', 's1')
      r.broadcast('d', 's1', statusFrame(s))
    }
    r.setStatus('d', 's1', 'busy')
    const ws = makeWs()
    const snap = r.subscribe(ws, 'd', 's1')
    expect(snap.status).toBe('busy')
    expect(snap.lastSeq).toBe(3)
    expect(snap.frames.map((f) => f.seq)).toEqual([1, 2, 3])
  })

  it('does not deliver to sockets with non-OPEN readyState and prunes them', () => {
    const r = new HubRegistry({ localDeviceId: 'd' })
    const open = makeWs()
    const closed = makeWs()
    closed.readyState = 3 // CLOSED
    r.subscribe(open, 'd', 's1')
    r.subscribe(closed, 'd', 's1')
    r.broadcast('d', 's1', statusFrame(r.nextSeq('d', 's1')))
    expect(open.sent).toHaveLength(1)
    expect(closed.sent).toHaveLength(0)
    expect(r.subscriberCount('d', 's1')).toBe(1)
  })

  it('prunes subscribers whose send throws', () => {
    const r = new HubRegistry({ localDeviceId: 'd' })
    const bad: HubSubscriber = {
      readyState: WS_OPEN,
      send: vi.fn(() => {
        throw new Error('boom')
      })
    }
    r.subscribe(bad, 'd', 's1')
    r.broadcast('d', 's1', statusFrame(r.nextSeq('d', 's1')))
    expect(r.subscriberCount('d', 's1')).toBe(0)
  })

  it('unsubscribe with no key removes ws from every session', () => {
    const r = new HubRegistry({ localDeviceId: 'd' })
    const ws = makeWs()
    r.subscribe(ws, 'd', 's1')
    r.subscribe(ws, 'd', 's2')
    r.unsubscribe(ws)
    expect(r.subscriberCount('d', 's1')).toBe(0)
    expect(r.subscriberCount('d', 's2')).toBe(0)
  })

  it('unsubscribe with key only removes that subscription', () => {
    const r = new HubRegistry({ localDeviceId: 'd' })
    const ws = makeWs()
    r.subscribe(ws, 'd', 's1')
    r.subscribe(ws, 'd', 's2')
    r.unsubscribe(ws, 'd', 's1')
    expect(r.subscriberCount('d', 's1')).toBe(0)
    expect(r.subscriberCount('d', 's2')).toBe(1)
  })
})

describe('HubRegistry: status tracking', () => {
  it('setStatus lazily creates the session and keeps the value', () => {
    const r = new HubRegistry({ localDeviceId: 'd' })
    r.setStatus('d', 's1', 'busy')
    expect(r.getSession('d', 's1')?.status).toBe('busy')
  })
})
