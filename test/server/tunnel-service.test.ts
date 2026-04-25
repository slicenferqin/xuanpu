import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import { EventEmitter } from 'events'
import {
  TunnelService,
  type TunnelStatus,
  detectPlatform
} from '../../src/main/services/hub/tunnel-service'

/** Minimal stub of ChildProcessWithoutNullStreams. */
class FakeChild extends EventEmitter {
  killed = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()

  kill(sig?: NodeJS.Signals | number): boolean {
    this.killed = true
    // Emulate cloudflared exiting on SIGTERM.
    setImmediate(() => {
      this.emit('exit', 0, sig ?? 'SIGTERM')
      this.emit('close', 0, sig ?? 'SIGTERM')
    })
    return true
  }

  emitStderr(line: string): void {
    this.stderr.emit('data', Buffer.from(line))
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }
}

function track(service: TunnelService): TunnelStatus[] {
  const seen: TunnelStatus[] = []
  service.on('statusChange', (s) => seen.push(s))
  return seen
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TunnelService: happy path', () => {
  it('transitions stopped -> starting -> running{url} when cloudflared prints URL', () => {
    const child = new FakeChild()
    const spawn = vi.fn(() => child) as unknown as typeof import('child_process').spawn
    const svc = new TunnelService({
      resolveBinary: () => '/fake/cloudflared',
      spawn
    })
    const seen = track(svc)

    svc.start(8317)
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith(
      '/fake/cloudflared',
      ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://127.0.0.1:8317'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    )

    child.emitStderr('2026-04-22 INFO Thank you for trying Cloudflare Tunnel\n')
    child.emitStderr('|  https://calm-field-9801.trycloudflare.com\n')

    const running = svc.status
    expect(running).toEqual({ state: 'running', url: 'https://calm-field-9801.trycloudflare.com' })
    expect(seen.map((s) => s.state)).toEqual(['starting', 'running'])
  })

  it('parses URL on stdout too', () => {
    const child = new FakeChild()
    const svc = new TunnelService({
      resolveBinary: () => '/fake/cloudflared',
      spawn: (() => child) as unknown as typeof import('child_process').spawn
    })
    svc.start(8317)
    child.stdout.emit('data', Buffer.from('https://foo-bar-baz.trycloudflare.com\n'))
    expect(svc.status.state).toBe('running')
  })

  it('uses the provided hub host when the server is bound on IPv6 loopback', () => {
    const child = new FakeChild()
    const spawn = vi.fn(() => child) as unknown as typeof import('child_process').spawn
    const svc = new TunnelService({
      resolveBinary: () => '/fake/cloudflared',
      spawn
    })

    svc.start(8317, '::1')

    expect(spawn).toHaveBeenCalledWith(
      '/fake/cloudflared',
      ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://[::1]:8317'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    )
  })
})

describe('TunnelService: missing binary', () => {
  it('moves to error when resolveBinary returns null', () => {
    const svc = new TunnelService({
      resolveBinary: () => null,
      spawn: vi.fn() as unknown as typeof import('child_process').spawn
    })
    const seen = track(svc)
    svc.start(8317)
    expect(svc.status.state).toBe('error')
    expect(seen.map((s) => s.state)).toEqual(['error'])
  })
})

describe('TunnelService: auto-restart with exponential backoff', () => {
  it('retries up to maxRestarts then transitions to error', () => {
    const children: FakeChild[] = []
    const spawn = vi.fn(() => {
      const c = new FakeChild()
      children.push(c)
      return c
    }) as unknown as typeof import('child_process').spawn

    const svc = new TunnelService({
      resolveBinary: () => '/fake/cloudflared',
      spawn,
      baseBackoffMs: 1000,
      maxRestarts: 2
    })
    svc.start(8317)

    // First child exits unexpectedly.
    children[0].emitExit(1)
    expect(svc.status.state).toBe('starting')

    // First backoff: 1000ms
    vi.advanceTimersByTime(1000)
    expect(spawn).toHaveBeenCalledTimes(2)

    // Second child also exits.
    children[1].emitExit(1)
    expect(svc.status.state).toBe('starting')

    // Second backoff: 1000 * 3 = 3000ms
    vi.advanceTimersByTime(3000)
    expect(spawn).toHaveBeenCalledTimes(3)

    // Third child exits — no restarts left.
    children[2].emitExit(1)
    expect(svc.status.state).toBe('error')
    expect(spawn).toHaveBeenCalledTimes(3)
  })

  it('resets restart counter after a successful URL', () => {
    const children: FakeChild[] = []
    const spawn = vi.fn(() => {
      const c = new FakeChild()
      children.push(c)
      return c
    }) as unknown as typeof import('child_process').spawn
    const svc = new TunnelService({
      resolveBinary: () => '/fake/cloudflared',
      spawn,
      baseBackoffMs: 1000,
      maxRestarts: 2
    })
    svc.start(8317)

    // Child 1: publish URL → running.
    children[0].emitStderr('https://one.trycloudflare.com\n')
    expect(svc.status.state).toBe('running')

    // Child 1 dies unexpectedly.
    children[0].emitExit(1)
    vi.advanceTimersByTime(1000)
    expect(spawn).toHaveBeenCalledTimes(2)

    // Child 2 also publishes URL → counter resets.
    children[1].emitStderr('https://two.trycloudflare.com\n')
    expect(svc.status.state).toBe('running')

    // It dies again; since counter reset, we still have both attempts available.
    children[1].emitExit(1)
    vi.advanceTimersByTime(1000)
    expect(spawn).toHaveBeenCalledTimes(3)
  })
})

describe('TunnelService: manual stop', () => {
  it('stop() clears enabled and suppresses further restarts', async () => {
    const children: FakeChild[] = []
    const spawn = vi.fn(() => {
      const c = new FakeChild()
      children.push(c)
      return c
    }) as unknown as typeof import('child_process').spawn
    const svc = new TunnelService({
      resolveBinary: () => '/fake/cloudflared',
      spawn,
      baseBackoffMs: 1000
    })
    svc.start(8317)
    children[0].emitStderr('https://x.trycloudflare.com\n')
    expect(svc.status.state).toBe('running')

    const stopP = svc.stop()
    // FakeChild.kill schedules the exit via setImmediate; flush microtasks + timers.
    await vi.advanceTimersByTimeAsync(1)
    await stopP

    expect(svc.status).toEqual({ state: 'stopped' })
    // No further restarts.
    vi.advanceTimersByTime(10_000)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('stop() before any spawn succeeds is a no-op', async () => {
    const svc = new TunnelService({
      resolveBinary: () => null,
      spawn: vi.fn() as unknown as typeof import('child_process').spawn
    })
    await svc.stop()
    expect(svc.status).toEqual({ state: 'stopped' })
  })
})

describe('detectPlatform', () => {
  it('returns a recognised platform string on this runner', () => {
    const p = detectPlatform()
    expect(p).toMatch(/^(darwin|linux|windows)-(amd64|arm64)$/)
  })
})
