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
  AGENT_STREAM_CHANNEL,
  wrapBrowserWindow
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

  beforeEach(() => {
    registry = new HubRegistry({ localDeviceId: 'd' })
    bridge = new HubBridge({
      registry,
      runtimeManager: makeRuntimeStub().manager
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

  it('drops metadata-only message.updated events', () => {
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
    expect(ws.sent).toHaveLength(0)
  })

  it('translates events from non-primary runtimes (codex/opencode) too', () => {
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
    // Hub now serves multi-runtime sessions (codex/opencode emit the same
    // canonical protocol), so non-primary events are no longer filtered out.
    expect(ws.sent).toHaveLength(1)
    expect((ws.sent[0] as { type: string }).type).toBe('status')
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
})

describe('hub-bridge: inbound client messages', () => {
  it('forwards prompt straight to runtime (no confirm gate)', async () => {
    const registry = new HubRegistry({ localDeviceId: 'd' })
    const { runtime, manager } = makeRuntimeStub()
    const bridge = new HubBridge({ registry, runtimeManager: manager })
    bridge.registerSessionRouting('s1', '/wt', 'agent-1')

    const ws = makeWs()
    await bridge.handleClientMessage(ws, 's1', {
      type: 'prompt',
      clientMsgId: 'c1',
      text: 'do thing'
    })
    expect(runtime.prompt).toHaveBeenCalledWith('/wt', 'agent-1', 'do thing')
    expect(ws.sent).toHaveLength(0)
  })

  it('interrupt → runtime.abort', async () => {
    const registry = new HubRegistry({ localDeviceId: 'd' })
    const { runtime, manager } = makeRuntimeStub()
    const bridge = new HubBridge({ registry, runtimeManager: manager })
    bridge.registerSessionRouting('s1', '/wt', 'agent-1')
    const ws = makeWs()
    await bridge.handleClientMessage(ws, 's1', { type: 'interrupt' })
    expect(runtime.abort).toHaveBeenCalledWith('/wt', 'agent-1')
  })

  it('permission/respond forwards decision', async () => {
    const registry = new HubRegistry({ localDeviceId: 'd' })
    const { runtime, manager } = makeRuntimeStub()
    const bridge = new HubBridge({ registry, runtimeManager: manager })
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
    const bridge = new HubBridge({ registry, runtimeManager: manager })
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
      runtimeManager: manager
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

describe('hub-bridge: routingResolver lazy fallback', () => {
  it('awaits an async resolver, caches the result, and routes the prompt to the runtime', async () => {
    const registry = new HubRegistry({ localDeviceId: 'd' })
    const { runtime, manager } = makeRuntimeStub()
    const resolver = vi.fn(async (_h: string) => ({
      worktreePath: '/tmp/wt',
      agentSessionId: 'agent-42'
    }))
    const bridge = new HubBridge({
      registry,
      runtimeManager: manager,
      routingResolver: resolver
    })

    const ws = makeWs()
    await bridge.handleClientMessage(ws, 'hive-x', {
      type: 'prompt',
      clientMsgId: 'c1',
      text: 'hi'
    })

    expect(resolver).toHaveBeenCalledTimes(1)
    expect(runtime.prompt).toHaveBeenCalledWith('/tmp/wt', 'agent-42', 'hi')
    expect(ws.sent).toEqual([])

    // Second call should hit the cache, not the resolver again.
    await bridge.handleClientMessage(ws, 'hive-x', {
      type: 'prompt',
      clientMsgId: 'c2',
      text: 'again'
    })
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(runtime.prompt).toHaveBeenCalledTimes(2)
  })

  it('emits SESSION_NOT_FOUND when both in-memory and async resolver miss', async () => {
    const registry = new HubRegistry({ localDeviceId: 'd' })
    const { runtime, manager } = makeRuntimeStub()
    const bridge = new HubBridge({
      registry,
      runtimeManager: manager,
      routingResolver: async () => null
    })

    const ws = makeWs()
    await bridge.handleClientMessage(ws, 'unknown-hive', {
      type: 'prompt',
      clientMsgId: 'c1',
      text: 'hi'
    })

    expect(runtime.prompt).not.toHaveBeenCalled()
    expect(ws.sent).toEqual([
      { type: 'error', code: 'SESSION_NOT_FOUND', message: 'no routing for unknown-hive' }
    ])
  })
})

describe('hub-bridge: P1 information fidelity (system notices + tool output)', () => {
  it('translates session.error into a system/notice frame', () => {
    const registry = new HubRegistry({ localDeviceId: 'd' })
    const bridge = new HubBridge({
      registry,
      runtimeManager: makeRuntimeStub().manager
    })
    const ws = makeWs()
    registry.subscribe(ws, 'd', 's1')

    bridge.onIpcEvent(AGENT_STREAM_CHANNEL, [
      envelope({
        type: 'session.error',
        sessionId: 's1',
        data: { message: '出大事了' }
      })
    ])

    expect(ws.sent).toHaveLength(1)
    const f = ws.sent[0] as {
      type: string
      level: string
      category: string
      text: string
    }
    expect(f.type).toBe('system/notice')
    expect(f.level).toBe('error')
    expect(f.category).toBe('session_error')
    expect(f.text).toBe('出大事了')
  })

  it('throttles session.context_usage notices to one per 10s per session', () => {
    const registry = new HubRegistry({ localDeviceId: 'd' })
    let now = 1_000_000
    const bridge = new HubBridge({
      registry,
      runtimeManager: makeRuntimeStub().manager,
      now: () => now
    })
    const ws = makeWs()
    registry.subscribe(ws, 'd', 's1')

    const fire = (): void => {
      bridge.onIpcEvent(AGENT_STREAM_CHANNEL, [
        envelope({
          type: 'session.context_usage',
          sessionId: 's1',
          data: { message: 'tokens: 1000' }
        })
      ])
    }

    fire() // emits
    now += 5_000
    fire() // throttled
    now += 6_000
    fire() // emits (>10s since first)

    const notices = ws.sent.filter(
      (f) => (f as { type: string }).type === 'system/notice'
    )
    expect(notices).toHaveLength(2)
  })

  it('emits a finished tool with output set on the tool_use part', () => {
    const registry = new HubRegistry({ localDeviceId: 'd' })
    const bridge = new HubBridge({
      registry,
      runtimeManager: makeRuntimeStub().manager
    })
    const ws = makeWs()
    registry.subscribe(ws, 'd', 's1')

    bridge.onIpcEvent(AGENT_STREAM_CHANNEL, [
      envelope({
        type: 'message.part.updated',
        sessionId: 's1',
        data: {
          part: {
            type: 'tool',
            callID: 'call-1',
            tool: 'Bash',
            state: { input: { command: 'ls' }, status: 'completed', output: 'a\nb\n' }
          }
        }
      })
    ])

    const append = ws.sent[0] as {
      type: string
      message: { parts: Array<{ type: string; output?: unknown; pending?: boolean; isError?: boolean }> }
    }
    expect(append.type).toBe('message/append')
    const tool = append.message.parts[0]!
    expect(tool.type).toBe('tool_use')
    expect(tool.pending).toBe(false)
    expect(tool.isError).toBe(false)
    expect(tool.output).toBe('a\nb\n')
  })
})

describe('hub-bridge: P3 plan + command_approval round trip', () => {
  it('translates plan.ready into plan/request, and routes plan/respond to runtime', async () => {
    const registry = new HubRegistry({ localDeviceId: 'd' })
    const planApprove = vi.fn(async () => undefined)
    const planReject = vi.fn(async () => undefined)
    const { runtime, manager } = makeRuntimeStub()
    Object.assign(runtime as unknown as Record<string, unknown>, { planApprove, planReject })
    const bridge = new HubBridge({
      registry,
      runtimeManager: manager,
      routingResolver: () => ({ worktreePath: '/wt', agentSessionId: 'a' })
    })
    const ws = makeWs()
    registry.subscribe(ws, 'd', 's1')

    bridge.onIpcEvent(AGENT_STREAM_CHANNEL, [
      envelope({
        type: 'plan.ready',
        sessionId: 's1',
        data: { requestId: 'req-1', planText: 'do X' }
      })
    ])

    const f = ws.sent[0] as { type: string; requestId: string; planText: string }
    expect(f.type).toBe('plan/request')
    expect(f.requestId).toBe('req-1')
    expect(f.planText).toBe('do X')

    await bridge.handleClientMessage(ws, 's1', {
      type: 'plan/respond',
      requestId: 'req-1',
      decision: 'approve'
    })
    expect(planApprove).toHaveBeenCalledWith('/wt', 's1', 'req-1')
    expect(planReject).not.toHaveBeenCalled()
  })

  it('translates command.approval_needed and routes command_approval/respond', async () => {
    const registry = new HubRegistry({ localDeviceId: 'd' })
    const commandApprovalReply = vi.fn(async () => undefined)
    const { runtime, manager } = makeRuntimeStub()
    Object.assign(runtime as unknown as Record<string, unknown>, { commandApprovalReply })
    const bridge = new HubBridge({
      registry,
      runtimeManager: manager,
      routingResolver: () => ({ worktreePath: '/wt', agentSessionId: 'a' })
    })
    const ws = makeWs()
    registry.subscribe(ws, 'd', 's1')

    bridge.onIpcEvent(AGENT_STREAM_CHANNEL, [
      envelope({
        type: 'command.approval_needed',
        sessionId: 's1',
        data: { requestId: 'cmd-1', command: 'rm -rf /', cwd: '/tmp' }
      })
    ])

    const f = ws.sent[0] as { type: string; command: string; cwd?: string }
    expect(f.type).toBe('command_approval/request')
    expect(f.command).toBe('rm -rf /')
    expect(f.cwd).toBe('/tmp')

    await bridge.handleClientMessage(ws, 's1', {
      type: 'command_approval/respond',
      requestId: 'cmd-1',
      decision: 'reject',
      message: 'no thanks'
    })
    expect(commandApprovalReply).toHaveBeenCalledWith('/wt', 'cmd-1', 'reject', 'no thanks')
  })
})
