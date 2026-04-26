import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

const getSessionTimelineMock = vi.fn()

vi.mock('../../src/main/services/session-timeline-service', () => ({
  getSessionTimeline: (...args: unknown[]) => getSessionTimelineMock(...args)
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
    getSessionTimelineMock.mockReset()
    getSessionTimelineMock.mockReturnValue({
      messages: [],
      compactionMarkers: [],
      revertBoundary: null
    })
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

  it('keeps assistant text from flattened timeline content when structured parts are tool-only', () => {
    getSessionTimelineMock.mockReturnValue({
      messages: [
        {
          id: 'm-1',
          role: 'assistant',
          content: '我已经检查完问题，并给出修复建议。',
          timestamp: '2026-01-01T00:00:00.000Z',
          parts: [
            {
              type: 'tool_use',
              toolUse: {
                id: 'tool-1',
                name: 'commandExecution',
                input: { command: 'pnpm test' },
                status: 'success',
                startTime: 1,
                output: 'ok'
              }
            }
          ]
        }
      ],
      compactionMarkers: [],
      revertBoundary: null
    })

    const snapshot = bridge.getHistorySnapshot('s1', 10)

    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]?.parts).toEqual([
      expect.objectContaining({
        type: 'tool_use',
        name: 'commandExecution'
      }),
      expect.objectContaining({
        type: 'text',
        text: '我已经检查完问题，并给出修复建议。'
      })
    ])
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

  it('emits a finished tool followed by a tool_result sibling part', () => {
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

    // PR42 split tool output into a separate tool_result sibling part — the
    // initial frame appends a tool_use (pending: false) and a follow-up
    // appendPart frame carries the tool_result with the output / isError.
    const append = ws.sent[0] as {
      type: string
      message: { parts: Array<{ type: string; pending?: boolean }> }
    }
    expect(append.type).toBe('message/append')
    const tool = append.message.parts[0]!
    expect(tool.type).toBe('tool_use')
    expect(tool.pending).toBe(false)

    const resultFrame = ws.sent
      .slice(1)
      .find((f) => {
        const fr = f as { patch?: { value?: { type?: string } } }
        return fr.patch?.value?.type === 'tool_result'
      }) as { patch: { value: { type: string; output: unknown; isError: boolean } } } | undefined
    expect(resultFrame).toBeDefined()
    expect(resultFrame!.patch.value.output).toBe('a\nb\n')
    expect(resultFrame!.patch.value.isError).toBe(false)
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
