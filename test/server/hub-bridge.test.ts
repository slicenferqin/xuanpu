import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import {
  HubBridge,
  CONFIRM_TIMEOUT_MS,
  AGENT_STREAM_CHANNEL,
  wrapBrowserWindow,
  type PromptConfirmer
} from '../../src/main/services/hub/hub-bridge'
import { HubRegistry, WS_OPEN, type HubSubscriber } from '../../src/main/services/hub/hub-registry'
import type { CanonicalAgentEvent } from '../../src/shared/types/agent-protocol'
import type { AgentRuntimeManager } from '../../src/main/services/agent-runtime-manager'
import type { AgentRuntimeAdapter } from '../../src/main/services/agent-runtime-types'

function makeWs(): HubSubscriber & { sent: unknown[] } {
  const sent: unknown[] = []
  return {
    sent,
    readyState: WS_OPEN,
    send(data: string) {
      sent.push(JSON.parse(data))
    }
  }
}

function makeRuntimeStub(overrides: Partial<AgentRuntimeAdapter> = {}): {
  runtime: AgentRuntimeAdapter
  manager: AgentRuntimeManager
} {
  const runtime: Partial<AgentRuntimeAdapter> = {
    id: 'claude-code',
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => true),
    permissionReply: vi.fn(async () => undefined),
    questionReply: vi.fn(async () => undefined),
    questionReject: vi.fn(async () => undefined),
    ...overrides
  }
  const manager: Partial<AgentRuntimeManager> = {
    getImplementer: vi.fn(() => runtime as AgentRuntimeAdapter)
  }
  return {
    runtime: runtime as AgentRuntimeAdapter,
    manager: manager as AgentRuntimeManager
  }
}

function envelope(event: Partial<CanonicalAgentEvent> & { sessionId: string }): CanonicalAgentEvent {
  return {
    eventId: 'evt-1',
    sessionSequence: 1,
    runEpoch: 1,
    runtimeId: 'claude-code',
    ...event
  } as CanonicalAgentEvent
}

describe('hub-bridge: webContents shim', () => {
  it('mirrors send() and forwards to bridge.onIpcEvent', () => {
    const sentToReal: Array<[string, unknown[]]> = []
    const fakeWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 7,
        isDestroyed: () => false,
        send: (channel: string, ...args: unknown[]) => {
          sentToReal.push([channel, args])
        }
      }
    } as unknown as Electron.BrowserWindow

    const onIpc = vi.fn()
    const stub = { onIpcEvent: onIpc } as unknown as HubBridge
    const wrapped = wrapBrowserWindow(fakeWindow, stub)
    wrapped.webContents.send('agent:stream', { foo: 1 })
    wrapped.webContents.send('other:channel', { bar: 2 })

    expect(sentToReal).toEqual([
      ['agent:stream', [{ foo: 1 }]],
      ['other:channel', [{ bar: 2 }]]
    ])
    expect(onIpc).toHaveBeenCalledTimes(2)
    expect(onIpc).toHaveBeenNthCalledWith(1, 'agent:stream', [{ foo: 1 }])
  })
})

describe('hub-bridge: outbound translation', () => {
  let registry: HubRegistry
  let bridge: HubBridge
  let confirmer: PromptConfirmer

  beforeEach(() => {
    registry = new HubRegistry({ localDeviceId: 'd' })
    confirmer = { confirm: vi.fn(async () => ({ approved: true })) }
    bridge = new HubBridge({
      registry,
      runtimeManager: makeRuntimeStub().manager,
      confirmer
    })
  })

  it('emits status frames with monotonic seq and updates registry status', () => {
    const ws = makeWs()
    registry.subscribe(ws, 'd', 's1')
    bridge.onIpcEvent(
      AGENT_STREAM_CHANNEL,
      [
        envelope({
          type: 'session.status',
          sessionId: 's1',
          data: { status: { type: 'busy' } },
          statusPayload: { type: 'busy' }
        })
      ]
    )
    expect(ws.sent).toEqual([{ type: 'status', seq: 1, status: 'busy' }])
    expect(registry.getSession('d', 's1')?.status).toBe('busy')
  })

  it('wraps unmodelled events as message/append with an UnknownPart', () => {
    const ws = makeWs()
    registry.subscribe(ws, 'd', 's1')
    bridge.onIpcEvent(
      AGENT_STREAM_CHANNEL,
      [
        envelope({
          type: 'message.updated',
          sessionId: 's1',
          data: { id: 'm1', role: 'assistant' }
        })
      ]
    )
    expect(ws.sent).toHaveLength(1)
    const frame = ws.sent[0] as { type: string; seq: number; message: { parts: unknown[] } }
    expect(frame.type).toBe('message/append')
    expect(frame.seq).toBe(1)
    expect(frame.message.parts[0]).toMatchObject({ type: 'unknown' })
  })

  it('ignores events from non-primary runtimes', () => {
    const ws = makeWs()
    registry.subscribe(ws, 'd', 's1')
    bridge.onIpcEvent(
      AGENT_STREAM_CHANNEL,
      [
        envelope({
          type: 'session.status',
          sessionId: 's1',
          runtimeId: 'opencode',
          data: { status: { type: 'busy' } },
          statusPayload: { type: 'busy' }
        })
      ]
    )
    expect(ws.sent).toHaveLength(0)
  })

  it('translates permission.asked into permission/request', () => {
    const ws = makeWs()
    registry.subscribe(ws, 'd', 's1')
    bridge.onIpcEvent(
      AGENT_STREAM_CHANNEL,
      [
        envelope({
          type: 'permission.asked',
          sessionId: 's1',
          data: {
            id: 'req-1',
            sessionID: 'sdk-1',
            permission: 'read',
            patterns: [],
            metadata: { tool: 'Read' },
            always: []
          }
        })
      ]
    )
    expect(ws.sent[0]).toMatchObject({
      type: 'permission/request',
      seq: 1,
      requestId: 'req-1',
      toolName: 'Read'
    })
  })

  it('emits ToolResultPart on tool completion (output appended as sibling part)', () => {
    const ws = makeWs()
    registry.subscribe(ws, 'd', 's1')

    // 1) running tool — opens bubble, no result yet
    bridge.onIpcEvent(AGENT_STREAM_CHANNEL, [
      envelope({
        type: 'message.part.updated',
        sessionId: 's1',
        data: {
          part: {
            type: 'tool',
            callID: 'call-A',
            tool: 'Bash',
            state: { status: 'running', input: { command: 'ls' } }
          }
        }
      })
    ])
    expect(ws.sent).toHaveLength(1)
    const open = ws.sent[0] as { type: string; message: { parts: unknown[] } }
    expect(open.type).toBe('message/append')
    expect(open.message.parts).toHaveLength(1)
    expect(open.message.parts[0]).toMatchObject({ type: 'tool_use', pending: true })

    // 2) completed tool — replacePart (pending → done) AND appendPart for tool_result
    ws.sent.length = 0
    bridge.onIpcEvent(AGENT_STREAM_CHANNEL, [
      envelope({
        type: 'message.part.updated',
        sessionId: 's1',
        data: {
          part: {
            type: 'tool',
            callID: 'call-A',
            tool: 'Bash',
            state: {
              status: 'completed',
              input: { command: 'ls' },
              output: 'file-a\nfile-b\n'
            }
          }
        }
      })
    ])
    expect(ws.sent).toHaveLength(2)
    const replace = ws.sent[0] as { patch?: { op?: string; value?: { pending?: boolean } } }
    expect(replace.patch?.op).toBe('replacePart')
    expect(replace.patch?.value?.pending).toBe(false)
    const result = ws.sent[1] as {
      patch?: { op?: string; value?: { type?: string; output?: unknown; isError?: boolean } }
    }
    expect(result.patch?.op).toBe('appendPart')
    expect(result.patch?.value?.type).toBe('tool_result')
    expect(result.patch?.value?.output).toBe('file-a\nfile-b\n')
    expect(result.patch?.value?.isError).toBe(false)
  })

  it('emits ToolResultPart with isError=true on error status', () => {
    const ws = makeWs()
    registry.subscribe(ws, 'd', 's1')
    bridge.onIpcEvent(AGENT_STREAM_CHANNEL, [
      envelope({
        type: 'message.part.updated',
        sessionId: 's1',
        data: {
          part: {
            type: 'tool',
            callID: 'call-B',
            tool: 'Bash',
            state: { status: 'running', input: { command: 'fail' } }
          }
        }
      })
    ])
    bridge.onIpcEvent(AGENT_STREAM_CHANNEL, [
      envelope({
        type: 'message.part.updated',
        sessionId: 's1',
        data: {
          part: {
            type: 'tool',
            callID: 'call-B',
            tool: 'Bash',
            state: {
              status: 'error',
              input: { command: 'fail' },
              error: 'permission denied',
              output: 'permission denied'
            }
          }
        }
      })
    ])
    const lastFrame = ws.sent[ws.sent.length - 1] as {
      patch?: { value?: { type?: string; isError?: boolean; output?: unknown } }
    }
    expect(lastFrame.patch?.value?.type).toBe('tool_result')
    expect(lastFrame.patch?.value?.isError).toBe(true)
  })

  it('truncates large tool output to 4 KB', () => {
    const ws = makeWs()
    registry.subscribe(ws, 'd', 's1')
    const huge = 'x'.repeat(10000)
    bridge.onIpcEvent(AGENT_STREAM_CHANNEL, [
      envelope({
        type: 'message.part.updated',
        sessionId: 's1',
        data: {
          part: {
            type: 'tool',
            callID: 'big',
            tool: 'Bash',
            state: { status: 'completed', input: { command: 'echo' }, output: huge }
          }
        }
      })
    ])
    const resultFrame = ws.sent.find((f) => {
      const fr = f as { patch?: { value?: { type?: string } } }
      return fr.patch?.value?.type === 'tool_result'
    }) as { patch: { value: { output: string } } }
    expect(resultFrame.patch.value.output.length).toBeLessThan(4500)
    expect(resultFrame.patch.value.output).toContain('truncated')
  })
})

describe('hub-bridge: inbound prompt + confirmation', () => {
  it('runs prompt only after desktop confirmation', async () => {
    const registry = new HubRegistry({ localDeviceId: 'd' })
    const { runtime, manager } = makeRuntimeStub()
    const confirmer: PromptConfirmer = {
      confirm: vi.fn(async () => ({ approved: true }))
    }
    const bridge = new HubBridge({ registry, runtimeManager: manager, confirmer })
    bridge.registerSessionRouting('s1', '/wt', 'agent-1')

    const ws = makeWs()
    await bridge.handleClientMessage(ws, 's1', {
      type: 'prompt',
      clientMsgId: 'c1',
      text: 'do thing'
    })
    expect(confirmer.confirm).toHaveBeenCalledOnce()
    expect(runtime.prompt).toHaveBeenCalledWith('/wt', 'agent-1', 'do thing')
    expect(ws.sent).toHaveLength(0)
  })

  it('emits CONFIRM_TIMEOUT and skips runtime.prompt when confirmer hangs', async () => {
    vi.useFakeTimers()
    const registry = new HubRegistry({ localDeviceId: 'd' })
    const { runtime, manager } = makeRuntimeStub()
    const confirmer: PromptConfirmer = {
      // never resolves
      confirm: vi.fn(() => new Promise(() => undefined))
    }
    const bridge = new HubBridge({ registry, runtimeManager: manager, confirmer })
    bridge.registerSessionRouting('s1', '/wt', 'agent-1')
    const ws = makeWs()
    const p = bridge.handleClientMessage(ws, 's1', {
      type: 'prompt',
      clientMsgId: 'c1',
      text: 'do thing'
    })
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS + 10)
    await p
    expect(runtime.prompt).not.toHaveBeenCalled()
    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'CONFIRM_TIMEOUT' })
    vi.useRealTimers()
  })

  it('interrupt → runtime.abort, no confirmation', async () => {
    const registry = new HubRegistry({ localDeviceId: 'd' })
    const { runtime, manager } = makeRuntimeStub()
    const confirmer: PromptConfirmer = { confirm: vi.fn(async () => ({ approved: true })) }
    const bridge = new HubBridge({ registry, runtimeManager: manager, confirmer })
    bridge.registerSessionRouting('s1', '/wt', 'agent-1')
    const ws = makeWs()
    await bridge.handleClientMessage(ws, 's1', { type: 'interrupt' })
    expect(runtime.abort).toHaveBeenCalledWith('/wt', 'agent-1')
    expect(confirmer.confirm).not.toHaveBeenCalled()
  })

  it('permission/respond forwards decision', async () => {
    const registry = new HubRegistry({ localDeviceId: 'd' })
    const { runtime, manager } = makeRuntimeStub()
    const confirmer: PromptConfirmer = { confirm: vi.fn() }
    const bridge = new HubBridge({ registry, runtimeManager: manager, confirmer })
    bridge.registerSessionRouting('s1', '/wt', 'agent-1')
    const ws = makeWs()
    await bridge.handleClientMessage(ws, 's1', {
      type: 'permission/respond',
      requestId: 'r1',
      decision: 'always'
    })
    expect(runtime.permissionReply).toHaveBeenCalledWith('r1', 'always', '/wt', undefined)
  })

  it('rejects bogus client messages with BAD_REQUEST', async () => {
    const registry = new HubRegistry({ localDeviceId: 'd' })
    const { manager } = makeRuntimeStub()
    const confirmer: PromptConfirmer = { confirm: vi.fn() }
    const bridge = new HubBridge({ registry, runtimeManager: manager, confirmer })
    bridge.registerSessionRouting('s1', '/wt', 'agent-1')
    const ws = makeWs()
    await bridge.handleClientMessage(ws, 's1', { type: 'nope' })
    expect(ws.sent[0]).toMatchObject({ type: 'error', code: 'BAD_REQUEST' })
  })

  it('resume replays buffered frames after lastSeq', async () => {
    const registry = new HubRegistry({ localDeviceId: 'd' })
    const { manager } = makeRuntimeStub()
    const bridge = new HubBridge({
      registry,
      runtimeManager: manager,
      confirmer: { confirm: vi.fn() }
    })
    // Seed three frames
    for (let i = 0; i < 3; i++) {
      bridge.onIpcEvent(AGENT_STREAM_CHANNEL, [
        envelope({
          type: 'session.status',
          sessionId: 's1',
          data: { status: { type: 'idle' } },
          statusPayload: { type: 'idle' }
        })
      ])
    }
    const ws = makeWs()
    await bridge.handleClientMessage(ws, 's1', { type: 'resume', lastSeq: 1 })
    expect(ws.sent.map((f) => (f as { seq: number }).seq)).toEqual([2, 3])
  })
})
