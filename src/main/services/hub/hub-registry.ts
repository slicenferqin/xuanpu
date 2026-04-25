/**
 * In-memory registry of hub devices, active sessions and WS subscribers.
 *
 * M1 scope:
 * - A single device: this machine. id = `${hostname}-${macHash}`, name = hostname.
 * - Active sessions keyed by `${deviceId}:${hiveSessionId}`.
 * - Each active session owns a MessageRingBuffer + SeqCounter + a Set of
 *   subscribers. Subscribers are opaque `HubSubscriber` objects so tests can
 *   drive the registry without a real `ws` instance.
 *
 * Busy/status is set externally via `setStatus(key, status)` — the hub-bridge
 * (task #40) will translate `session-status-changed` IPC events into these
 * calls. The registry itself doesn't listen to ipcMain to stay test-friendly.
 */

import { hostname, networkInterfaces } from 'os'
import { createHash } from 'crypto'
import { MessageRingBuffer, SeqCounter, type ServerMsg, type HubSessionStatus } from './hub-protocol'

export interface HubDevice {
  id: string
  name: string
  hostname: string
  online: boolean
  lastSeen: number
}

/**
 * Minimal WS-like contract the registry calls. Matches the `ws.WebSocket`
 * methods we use at runtime but is deliberately tiny so unit tests can pass
 * in a `{ send, close }` stub.
 */
export interface HubSubscriber {
  send(data: string): void
  /** Optional — closed subscribers are dropped on next broadcast. */
  readyState?: number
}

/** Matches `ws.WebSocket.OPEN` without importing the whole package here. */
export const WS_OPEN = 1

export interface ActiveSession {
  deviceId: string
  hiveSessionId: string
  status: HubSessionStatus
  ringBuffer: MessageRingBuffer
  seq: SeqCounter
  subscribers: Set<HubSubscriber>
}

export interface SubscribeResult {
  status: HubSessionStatus
  lastSeq: number
  /** Replay of any frames currently in the ring buffer. */
  frames: ServerMsg[]
}

function sessionKey(deviceId: string, hiveSessionId: string): string {
  return `${deviceId}:${hiveSessionId}`
}

function computeLocalDeviceId(): string {
  const host = hostname()
  const ifaces = networkInterfaces()
  const macs: string[] = []
  for (const list of Object.values(ifaces)) {
    if (!list) continue
    for (const iface of list) {
      if (iface.mac && iface.mac !== '00:00:00:00:00:00') macs.push(iface.mac)
    }
  }
  macs.sort()
  const macHash = createHash('sha256').update(macs.join(',') || host).digest('hex').slice(0, 12)
  return `${host}-${macHash}`
}

export class HubRegistry {
  private readonly devices = new Map<string, HubDevice>()
  private readonly activeSessions = new Map<string, ActiveSession>()
  readonly localDeviceId: string

  constructor(opts?: { localDeviceId?: string; localDeviceName?: string }) {
    this.localDeviceId = opts?.localDeviceId ?? computeLocalDeviceId()
    const host = hostname()
    this.devices.set(this.localDeviceId, {
      id: this.localDeviceId,
      name: opts?.localDeviceName ?? host,
      hostname: host,
      online: true,
      lastSeen: Date.now()
    })
  }

  // ─── Devices ──────────────────────────────────────────────────────────────

  listDevices(): HubDevice[] {
    return Array.from(this.devices.values())
  }

  getDevice(deviceId: string): HubDevice | null {
    return this.devices.get(deviceId) ?? null
  }

  touchDevice(deviceId: string): void {
    const d = this.devices.get(deviceId)
    if (d) {
      d.online = true
      d.lastSeen = Date.now()
    }
  }

  // ─── Active sessions ──────────────────────────────────────────────────────

  /** Lazily create (or fetch) the runtime state for a session. */
  ensureSession(deviceId: string, hiveSessionId: string): ActiveSession {
    const key = sessionKey(deviceId, hiveSessionId)
    let s = this.activeSessions.get(key)
    if (!s) {
      s = {
        deviceId,
        hiveSessionId,
        status: 'idle',
        ringBuffer: new MessageRingBuffer(),
        seq: new SeqCounter(),
        subscribers: new Set()
      }
      this.activeSessions.set(key, s)
    }
    return s
  }

  getSession(deviceId: string, hiveSessionId: string): ActiveSession | null {
    return this.activeSessions.get(sessionKey(deviceId, hiveSessionId)) ?? null
  }

  setStatus(deviceId: string, hiveSessionId: string, status: HubSessionStatus): void {
    const s = this.ensureSession(deviceId, hiveSessionId)
    s.status = status
  }

  // ─── Subscriptions ────────────────────────────────────────────────────────

  subscribe(ws: HubSubscriber, deviceId: string, hiveSessionId: string): SubscribeResult {
    const s = this.ensureSession(deviceId, hiveSessionId)
    s.subscribers.add(ws)
    const replay = s.ringBuffer.replayAfter(0)
    return {
      status: s.status,
      lastSeq: s.seq.current(),
      frames: replay.ok ? replay.frames : []
    }
  }

  unsubscribe(ws: HubSubscriber, deviceId?: string, hiveSessionId?: string): void {
    if (deviceId && hiveSessionId) {
      this.activeSessions.get(sessionKey(deviceId, hiveSessionId))?.subscribers.delete(ws)
      return
    }
    // No key => remove from every session (ws disconnected).
    for (const s of this.activeSessions.values()) s.subscribers.delete(ws)
  }

  /**
   * Push a frame to the session's ring buffer and forward to every
   * subscriber. The caller is responsible for having assigned `frame.seq`
   * via the session's SeqCounter before pushing.
   */
  broadcast(deviceId: string, hiveSessionId: string, frame: ServerMsg): void {
    const s = this.ensureSession(deviceId, hiveSessionId)
    s.ringBuffer.push(frame)
    const payload = JSON.stringify(frame)
    for (const ws of s.subscribers) {
      if (ws.readyState !== undefined && ws.readyState !== WS_OPEN) {
        s.subscribers.delete(ws)
        continue
      }
      try {
        ws.send(payload)
      } catch {
        s.subscribers.delete(ws)
      }
    }
  }

  /** Allocate the next seq for a session — helper for the bridge. */
  nextSeq(deviceId: string, hiveSessionId: string): number {
    return this.ensureSession(deviceId, hiveSessionId).seq.next()
  }

  subscriberCount(deviceId: string, hiveSessionId: string): number {
    return this.activeSessions.get(sessionKey(deviceId, hiveSessionId))?.subscribers.size ?? 0
  }

  listActiveSessionKeys(): string[] {
    return Array.from(this.activeSessions.keys())
  }

  clear(): void {
    this.activeSessions.clear()
  }
}
