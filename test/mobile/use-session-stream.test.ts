import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({
  api: vi.fn()
}))

const wsMock = vi.hoisted(() => {
  let sendResult = true
  let sentFrames: unknown[] = []
  let latestSocket: {
    emitFrame: (frame: unknown) => void
    markFullReloadComplete: (lastSeq: number) => void
    getLastSeq: () => number
  } | null = null

  class MockHubWebSocket {
    private frameListeners = new Set<(frame: unknown) => void>()
    private stateListeners = new Set<(state: 'connecting' | 'open' | 'closed') => void>()
    private lastSeq = 0

    constructor(_deviceId: string, _hiveSessionId: string) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      latestSocket = this
    }

    connect(): void {
      this.emitState('open')
    }

    destroy(): void {}

    send(frame: unknown): boolean {
      if (sendResult) {
        sentFrames.push(frame)
      }
      return sendResult
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
    getSentFrames: () => sentFrames,
    setSendResult: (value: boolean) => {
      sendResult = value
    },
    reset: () => {
      sendResult = true
      sentFrames = []
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

  it('keeps permission card and shows send error when permission response cannot be sent', () => {
    const { result } = renderHook(() => useSessionStream('device-1', 'hive-1'))
    const latestSocket = wsMock.getLatestSocket()
    expect(latestSocket).not.toBeNull()

    act(() => {
      latestSocket?.emitFrame({
        type: 'permission/request',
        seq: 1,
        requestId: 'perm-1',
        toolName: 'Bash'
      })
    })

    expect(result.current.state.permission?.requestId).toBe('perm-1')

    wsMock.setSendResult(false)
    act(() => {
      result.current.respondPermission('once')
    })

    expect(result.current.state.permission?.requestId).toBe('perm-1')
    expect(result.current.state.error).toMatchObject({
      code: 'SEND_FAILED',
      message: 'Connection is not open. Please retry.'
    })
    expect(wsMock.getSentFrames()).toEqual([])

    wsMock.setSendResult(true)
    act(() => {
      result.current.respondPermission('once')
    })

    expect(result.current.state.permission).toBeNull()
    expect(result.current.state.error).toBeNull()
    expect(wsMock.getSentFrames()).toEqual([
      expect.objectContaining({ type: 'permission/respond', requestId: 'perm-1' })
    ])
  })

  it('keeps question, plan, and command approval cards when responses cannot be sent', () => {
    const { result } = renderHook(() => useSessionStream('device-1', 'hive-1'))
    const latestSocket = wsMock.getLatestSocket()
    expect(latestSocket).not.toBeNull()

    act(() => {
      latestSocket?.emitFrame({
        type: 'question/request',
        seq: 1,
        requestId: 'question-1',
        question: 'Pick one'
      })
      latestSocket?.emitFrame({
        type: 'plan/request',
        seq: 2,
        requestId: 'plan-1',
        planText: 'Do the thing'
      })
      latestSocket?.emitFrame({
        type: 'command_approval/request',
        seq: 3,
        requestId: 'cmd-1',
        command: 'pnpm test'
      })
    })

    wsMock.setSendResult(false)
    act(() => {
      result.current.respondQuestion([['A']])
      result.current.respondPlan('approve')
      result.current.respondCommandApproval('approve_once')
    })

    expect(result.current.state.question?.requestId).toBe('question-1')
    expect(result.current.state.plan?.requestId).toBe('plan-1')
    expect(result.current.state.commandApproval?.requestId).toBe('cmd-1')
    expect(result.current.state.error?.code).toBe('SEND_FAILED')
    expect(wsMock.getSentFrames()).toEqual([])
  })

  it('clears interactive cards after responses are sent', () => {
    const { result } = renderHook(() => useSessionStream('device-1', 'hive-1'))
    const latestSocket = wsMock.getLatestSocket()
    expect(latestSocket).not.toBeNull()

    act(() => {
      latestSocket?.emitFrame({
        type: 'permission/request',
        seq: 1,
        requestId: 'perm-1',
        toolName: 'Bash'
      })
      latestSocket?.emitFrame({
        type: 'question/request',
        seq: 2,
        requestId: 'question-1',
        question: 'Pick one'
      })
      latestSocket?.emitFrame({
        type: 'plan/request',
        seq: 3,
        requestId: 'plan-1',
        planText: 'Do the thing'
      })
      latestSocket?.emitFrame({
        type: 'command_approval/request',
        seq: 4,
        requestId: 'cmd-1',
        command: 'pnpm test'
      })
    })

    act(() => {
      result.current.respondPermission('always')
      result.current.respondQuestion([['A']])
      result.current.respondPlan('approve')
      result.current.respondCommandApproval('approve_once')
    })

    expect(result.current.state.permission).toBeNull()
    expect(result.current.state.question).toBeNull()
    expect(result.current.state.plan).toBeNull()
    expect(result.current.state.commandApproval).toBeNull()
    expect(wsMock.getSentFrames()).toEqual([
      expect.objectContaining({ type: 'permission/respond', requestId: 'perm-1' }),
      expect.objectContaining({ type: 'question/respond', requestId: 'question-1' }),
      expect.objectContaining({ type: 'plan/respond', requestId: 'plan-1' }),
      expect.objectContaining({ type: 'command_approval/respond', requestId: 'cmd-1' })
    ])
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

    const { result, rerender } = renderHook(({ hiveId }) => useSessionStream('device-1', hiveId), {
      initialProps: { hiveId: 'hive-1' }
    })

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
