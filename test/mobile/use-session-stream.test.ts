import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const wsMock = vi.hoisted(() => {
  let latestSocket: {
    emitFrame: (frame: unknown) => void
  } | null = null

  class MockHubWebSocket {
    private frameListeners = new Set<(frame: unknown) => void>()
    private stateListeners = new Set<(state: 'connecting' | 'open' | 'closed') => void>()

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

import { useSessionStream } from '../../mobile/src/hooks/useSessionStream'

describe('useSessionStream', () => {
  beforeEach(() => {
    wsMock.reset()
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
})
