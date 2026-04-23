/**
 * HubWebSocket: thin wrapper around `WebSocket` that:
 *  - reconnects with exponential backoff (1s → 2s → 4s … capped 10s)
 *  - remembers `lastSeq` so reconnects send `{type:'resume', lastSeq}`
 *  - dispatches typed `ServerMsg` frames to subscribers
 *  - exposes `state: 'connecting'|'open'|'closed'` for UI status bars
 *
 * Server protocol mirrors `src/main/services/hub/hub-protocol.ts`. We
 * deliberately keep the union loose here — the mobile UI deals with
 * arbitrary `ServerMsg` shapes via discriminated `type`.
 */

import { getApiBase } from './client'

export type ConnectionState = 'connecting' | 'open' | 'closed'

export interface ServerFrame {
  type: string
  seq?: number
  // ...payload
  [key: string]: unknown
}

export interface ClientFrame {
  type: string
  // ...payload
  [key: string]: unknown
}

export type FrameListener = (frame: ServerFrame) => void
export type StateListener = (state: ConnectionState) => void

const MAX_BACKOFF_MS = 10_000

function wsUrl(deviceId: string, hiveSessionId: string): string {
  const base = getApiBase()
  const u = new URL(base)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = `/ws/ui/${encodeURIComponent(deviceId)}/${encodeURIComponent(hiveSessionId)}`
  u.search = ''
  return u.toString()
}

export class HubWebSocket {
  private ws: WebSocket | null = null
  private lastSeq = 0
  private backoff = 1000
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  private _state: ConnectionState = 'closed'
  private readonly frameListeners = new Set<FrameListener>()
  private readonly stateListeners = new Set<StateListener>()

  constructor(
    private readonly deviceId: string,
    private readonly hiveSessionId: string
  ) {}

  get state(): ConnectionState {
    return this._state
  }

  connect(): void {
    if (this.destroyed) return
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    this.setState('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl(this.deviceId, this.hiveSessionId))
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.backoff = 1000
      this.setState('open')
      // Ask the server to replay anything we missed since lastSeq.
      if (this.lastSeq > 0) {
        this.send({ type: 'resume', lastSeq: this.lastSeq })
      }
    }
    ws.onmessage = (e) => {
      let frame: ServerFrame
      try {
        frame = JSON.parse(e.data as string) as ServerFrame
      } catch {
        return
      }
      if (typeof frame.seq === 'number' && frame.seq > this.lastSeq) {
        this.lastSeq = frame.seq
      }
      for (const l of this.frameListeners) l(frame)
    }
    ws.onerror = () => {
      // The browser will fire onclose right after.
    }
    ws.onclose = () => {
      this.ws = null
      this.setState('closed')
      this.scheduleReconnect()
    }
  }

  send(frame: ClientFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    try {
      this.ws.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  destroy(): void {
    this.destroyed = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
  }

  onFrame(cb: FrameListener): () => void {
    this.frameListeners.add(cb)
    return () => this.frameListeners.delete(cb)
  }

  onState(cb: StateListener): () => void {
    this.stateListeners.add(cb)
    cb(this._state)
    return () => this.stateListeners.delete(cb)
  }

  private setState(s: ConnectionState): void {
    if (this._state === s) return
    this._state = s
    for (const l of this.stateListeners) l(s)
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return
    if (this.retryTimer) return
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }
}
