import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({
  api: vi.fn()
}))

const wsMock = vi.hoisted(() => {
  let latestSocket: {
    emitFrame: (frame: unknown) => void
    markFullReloadComplete: (lastSeq: number) => void
    getLastSeq: () => number
  } | null = null

  class MockHubWebSocket {
    private frameListeners = new Set<(frame: unknown) => void>()
    private stateListeners = new Set<(state: 'connecting' | 'open' | 'closed') => void>()
    private lastSeq = 0

    constructor(
      _deviceId: string,
      _hiveSessionId: string
    ) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      latestSocket = this
    }

    connect(): void {
      this.emitState('open')
    }

    destroy(): void {}

    send(): boolean {
      return true
    }

    markFullReloadComplete(lastSeq: number): void {
      this.lastSeq = Math.max(this.lastSeq, lastSeq)
    }

    getLastSeq(): number {
      return this.lastSeq
    }

    onFrame(cb: (frame: unknown) => void): () => void {
      this.frameListeners.add(cb)
      return () => this.frameListeners.delete(cb)
    }

    onState(cb: (state: 'connecting' | 'open' | 'closed') => void): () => void {
      this.stateListeners.add(cb)
      cb('connecting')
      return () => this.stateListeners.delete(cb)
    }

    emitFrame(frame: unknown): void {
      for (const listener of this.frameListeners) listener(frame)
    }

    private emitState(state: 'connecting' | 'open' | 'closed'): void {
      for (const listener of this.stateListeners) listener(state)
    }
  }

  return {
    getLatestSocket: () => latestSocket,
    reset: () => {
      latestSocket = null
    },
    MockHubWebSocket
  }
})

vi.mock('../../mobile/src/api/ws', () => ({
  HubWebSocket: wsMock.MockHubWebSocket
}))

vi.mock('../../mobile/src/api/client', () => ({
  api: apiMock.api
}))

import { useSessionStream } from '../../mobile/src/hooks/useSessionStream'

describe('useSessionStream', () => {
  beforeEach(() => {
    wsMock.reset()
    apiMock.api.mockReset()
  })

  it('clears pending plan and command approval cards on session snapshot', () => {
    const { result } = renderHook(() => useSessionStream('device-1', 'hive-1'))
    const latestSocket = wsMock.getLatestSocket()
    expect(latestSocket).not.toBeNull()

    act(() => {
      latestSocket?.emitFrame({
        type: 'plan/request',
        seq: 1,
        requestId: 'plan-1',
        planText: 'Do the thing'
      })
      latestSocket?.emitFrame({
        type: 'command_approval/request',
        seq: 2,
        requestId: 'cmd-1',
        command: 'rm -rf /tmp/foo'
      })
    })

    expect(result.current.state.plan?.requestId).toBe('plan-1')
    expect(result.current.state.commandApproval?.requestId).toBe('cmd-1')

    act(() => {
      latestSocket?.emitFrame({
        type: 'session/snapshot',
        seq: 3,
        status: 'idle',
        lastSeq: 3,
        messages: []
      })
    })

    expect(result.current.state.plan).toBeNull()
    expect(result.current.state.commandApproval).toBeNull()
  })

  it('reloads history when the server asks for a full reload', async () => {
    apiMock.api.mockResolvedValue({
      hiveId: 'hive-1',
      status: 'busy',
      lastSeq: 42,
      hubMessages: [
        {
          id: 'm-1',
          role: 'assistant',
          ts: 123,
          seq: 1,
          parts: [{ type: 'text', text: 'Recovered message' }]
        }
      ]
    })

    const { result } = renderHook(() => useSessionStream('device-1', 'hive-1'))
    const latestSocket = wsMock.getLatestSocket()
    expect(latestSocket).not.toBeNull()

    await act(async () => {
      latestSocket?.emitFrame({
        type: 'error',
        code: 'NEED_FULL_RELOAD',
        message: 'gap evicted'
      })
    })

    await waitFor(() => {
      expect(result.current.state.messages).toHaveLength(1)
    })

    expect(apiMock.api).toHaveBeenCalledWith(
      '/api/sessions/hive-1/history',
      expect.objectContaining({
        signal: expect.any(Object)
      })
    )
    expect(latestSocket?.getLastSeq()).toBe(42)
    expect(result.current.state.status).toBe('busy')
    expect(result.current.state.error).toBeNull()
    expect(result.current.state.messages[0]).toMatchObject({
      id: 'm-1',
      role: 'assistant'
    })
    expect(result.current.state.messages[0]?.parts).toEqual([
      { type: 'text', text: 'Recovered message' }
    ])
  })

  it('drops stale full reload results after switching sessions', async () => {
    let resolveHistory: (value: unknown) => void = () => {}
    const pendingHistory = new Promise((resolve) => {
      resolveHistory = resolve
    })
    apiMock.api.mockReturnValueOnce(pendingHistory)

    const { result, rerender } = renderHook(
      ({ hiveId }) => useSessionStream('device-1', hiveId),
      { initialProps: { hiveId: 'hive-1' } }
    )

    const oldSocket = wsMock.getLatestSocket()
    expect(oldSocket).not.toBeNull()

    await act(async () => {
      oldSocket?.emitFrame({
        type: 'error',
        code: 'NEED_FULL_RELOAD',
        message: 'gap evicted'
      })
    })

    expect(apiMock.api).toHaveBeenCalledTimes(1)
    expect(apiMock.api).toHaveBeenCalledWith(
      '/api/sessions/hive-1/history',
      expect.objectContaining({
        signal: expect.any(Object)
      })
    )

    await act(async () => {
      rerender({ hiveId: 'hive-2' })
    })

    await act(async () => {
      resolveHistory({
        hiveId: 'hive-1',
        status: 'busy',
        lastSeq: 99,
        hubMessages: [
          {
            id: 'stale-1',
            role: 'assistant',
            ts: 321,
            seq: 1,
            parts: [{ type: 'text', text: 'Stale recovery' }]
          }
        ]
      })
      await Promise.resolve()
    })

    expect(result.current.state.messages).toEqual([])
    expect(result.current.state.error).toBeNull()
    expect(result.current.state.status).toBe('idle')
  })
})
