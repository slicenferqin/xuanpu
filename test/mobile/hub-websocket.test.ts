import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HubWebSocket, type ConnectionState, type ServerFrame } from '../../mobile/src/api/ws'

class MockBrowserWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly sent: unknown[] = []
  readyState = MockBrowserWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor(readonly url: string) {
    sockets.push(this)
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as unknown)
  }

  close(): void {
    this.readyState = MockBrowserWebSocket.CLOSED
  }

  open(): void {
    this.readyState = MockBrowserWebSocket.OPEN
    this.onopen?.()
  }

  message(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  closeFromServer(): void {
    this.readyState = MockBrowserWebSocket.CLOSED
    this.onclose?.()
  }
}

let sockets: MockBrowserWebSocket[] = []

describe('HubWebSocket reconnect resume', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sockets = []
    vi.stubGlobal('WebSocket', MockBrowserWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reconnects with the latest received seq as resume cursor', async () => {
    const frames: ServerFrame[] = []
    const states: ConnectionState[] = []
    const ws = new HubWebSocket('device-1', 'hive-1')
    ws.onFrame((frame) => frames.push(frame))
    ws.onState((state) => states.push(state))

    ws.connect()

    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.url).toContain('/ws/ui/device-1/hive-1')
    sockets[0]?.open()
    expect(sockets[0]?.sent).toEqual([])

    sockets[0]?.message({ type: 'status', seq: 1, status: 'busy' })
    sockets[0]?.message({ type: 'status', seq: 2, status: 'idle' })
    sockets[0]?.closeFromServer()

    expect(states.at(-1)).toBe('closed')

    await vi.advanceTimersByTimeAsync(1000)

    expect(sockets).toHaveLength(2)
    sockets[1]?.open()
    expect(sockets[1]?.sent).toEqual([{ type: 'resume', lastSeq: 2 }])

    sockets[1]?.message({ type: 'status', seq: 3, status: 'busy' })
    sockets[1]?.closeFromServer()

    await vi.advanceTimersByTimeAsync(1000)

    expect(sockets).toHaveLength(3)
    sockets[2]?.open()
    expect(sockets[2]?.sent).toEqual([{ type: 'resume', lastSeq: 3 }])
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2, 3])

    ws.destroy()
  })

  it('uses the REST full-reload seq as the next resume cursor', async () => {
    const ws = new HubWebSocket('device-1', 'hive-1')
    ws.connect()

    expect(sockets).toHaveLength(1)
    sockets[0]?.open()
    sockets[0]?.message({ type: 'status', seq: 5, status: 'busy' })

    ws.markFullReloadComplete(42)
    ws.markFullReloadComplete(7)
    sockets[0]?.closeFromServer()

    await vi.advanceTimersByTimeAsync(1000)

    expect(sockets).toHaveLength(2)
    sockets[1]?.open()
    expect(sockets[1]?.sent).toEqual([{ type: 'resume', lastSeq: 42 }])

    ws.destroy()
  })
})
