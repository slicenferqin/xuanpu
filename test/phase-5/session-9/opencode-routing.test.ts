import { beforeEach, describe, expect, test, vi } from 'vitest'

const mockDb = {
  getSessionMessageByOpenCodeId: vi.fn(),
  upsertSessionMessageByOpenCodeId: vi.fn(),
  upsertSessionActivity: vi.fn(),
  updateSession: vi.fn(),
  getWorktreeBySessionId: vi.fn(),
  updateWorktree: vi.fn(),
  getSession: vi.fn(),
  getProject: vi.fn()
}

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp')
  }
}))

vi.mock('../../../src/main/db', () => ({
  getDatabase: () => mockDb
}))

import { OPENCODE_CAPABILITIES } from '../../../src/main/services/agent-runtime-types'
import { openCodeService } from '../../../src/main/services/opencode-service'

function createInstance() {
  return {
    client: {
      session: {
        get: vi.fn().mockResolvedValue({ data: {} })
      }
    },
    server: { url: 'http://localhost', close: vi.fn() },
    sessionMap: new Map<string, string>([
      ['/repo/a::opc-session-1', 'hive-session-a'],
      ['/repo/b::opc-session-1', 'hive-session-b']
    ]),
    sessionDirectories: new Map<string, string>(),
    directorySubscriptions: new Map(),
    childToParentMap: new Map<string, string>(),
    toolStartedTrackerByHiveSession: new Map(),
    titleGenerationStartedByHiveSession: new Map(),
    userMessageIdsByHiveSession: new Map(),
    messageBuffersByHiveSession: new Map(),
    planEmittedByHiveSession: new Map()
  }
}

async function invokeHandleEvent(instance: unknown, rawEvent: unknown, directory?: string) {
  return (
    openCodeService as never as {
      handleEvent: (instance: unknown, rawEvent: unknown, directory?: string) => Promise<void>
    }
  ).handleEvent(instance, rawEvent, directory)
}

describe('Session 9: OpenCode session routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.getSessionMessageByOpenCodeId.mockReturnValue(null)
    mockDb.getWorktreeBySessionId.mockReturnValue(null)
    mockDb.getSession.mockReturnValue(null)
    mockDb.upsertSessionActivity.mockReturnValue(undefined)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
        text: async () => ''
      })
    )
  })

  test('routes event to correct hive session when opencode session IDs collide across directories', async () => {
    expect(openCodeService.capabilities).toEqual(OPENCODE_CAPABILITIES)
    expect(openCodeService.capabilities.supportsSteer).toBe(false)

    const send = vi.fn()

    openCodeService.setMainWindow({
      isDestroyed: () => false,
      webContents: { send }
    } as never)

    const instance = createInstance()

    await invokeHandleEvent(
      instance,
      {
        data: {
          type: 'session.idle',
          properties: {
            sessionID: 'opc-session-1'
          }
        }
      },
      '/repo/a'
    )

    expect(send).toHaveBeenCalledWith(
      'agent:stream',
      expect.objectContaining({ sessionId: 'hive-session-a', type: 'session.idle' })
    )
  })

  test('routes message.updated without touching DB transcript persistence', async () => {
    const send = vi.fn()

    openCodeService.setMainWindow({
      isDestroyed: () => false,
      isFocused: () => true,
      webContents: { send }
    } as never)

    const instance = createInstance()

    await invokeHandleEvent(
      instance,
      {
        data: {
          type: 'message.updated',
          properties: {
            sessionID: 'opc-session-1',
            info: { messageID: 'msg-1' },
            message: { id: 'msg-1', role: 'assistant' },
            parts: [{ type: 'text', text: 'hello' }]
          }
        }
      },
      '/repo/b'
    )

    expect(send).toHaveBeenCalledWith(
      'agent:stream',
      expect.objectContaining({ sessionId: 'hive-session-b', type: 'message.updated' })
    )
    expect(mockDb.getSessionMessageByOpenCodeId).not.toHaveBeenCalled()
    expect(mockDb.upsertSessionMessageByOpenCodeId).not.toHaveBeenCalled()
  })

  test('message.updated emits session.context_usage when assistant tokens are present', async () => {
    const send = vi.fn()

    openCodeService.setMainWindow({
      isDestroyed: () => false,
      isFocused: () => true,
      webContents: { send }
    } as never)

    const instance = createInstance()

    await invokeHandleEvent(
      instance,
      {
        data: {
          type: 'message.updated',
          properties: {
            sessionID: 'opc-session-1',
            info: {
              id: 'msg-ctx-1',
              sessionID: 'opc-session-1',
              role: 'assistant',
              providerID: 'anthropic',
              modelID: 'claude-opus-4-5-20251101',
              tokens: {
                input: 100,
                output: 50,
                reasoning: 20,
                cache: { read: 10, write: 5 }
              }
            }
          }
        }
      },
      '/repo/b'
    )

    const streamCalls = send.mock.calls.filter((call) => call[0] === 'agent:stream')
    expect(streamCalls).toEqual(
      expect.arrayContaining([
        [
          'agent:stream',
          expect.objectContaining({
            type: 'message.updated',
            sessionId: 'hive-session-b'
          })
        ],
        [
          'agent:stream',
          expect.objectContaining({
            type: 'session.context_usage',
            sessionId: 'hive-session-b',
            data: expect.objectContaining({
              tokens: {
                input: 100,
                output: 50,
                reasoning: 20,
                cacheRead: 10,
                cacheWrite: 5
              },
              model: {
                providerID: 'anthropic',
                modelID: 'claude-opus-4-5-20251101'
              }
            })
          })
        ]
      ])
    )
  })

  test('message.part.updated compaction emits session.compaction_started', async () => {
    const send = vi.fn()

    openCodeService.setMainWindow({
      isDestroyed: () => false,
      isFocused: () => true,
      webContents: { send }
    } as never)

    const instance = createInstance()

    await invokeHandleEvent(
      instance,
      {
        data: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'cmp-1',
              sessionID: 'opc-session-1',
              messageID: 'msg-1',
              type: 'compaction',
              auto: true
            }
          }
        }
      },
      '/repo/b'
    )

    expect(send).toHaveBeenCalledWith(
      'agent:stream',
      expect.objectContaining({
        type: 'session.compaction_started',
        sessionId: 'hive-session-b',
        data: { auto: true }
      })
    )
  })

  test('session.compacted emits session.context_compacted', async () => {
    const send = vi.fn()

    openCodeService.setMainWindow({
      isDestroyed: () => false,
      isFocused: () => true,
      webContents: { send }
    } as never)

    const instance = createInstance()

    await invokeHandleEvent(
      instance,
      {
        data: {
          type: 'session.compacted',
          properties: {
            sessionID: 'opc-session-1'
          }
        }
      },
      '/repo/b'
    )

    expect(send).toHaveBeenCalledWith(
      'agent:stream',
      expect.objectContaining({
        type: 'session.context_compacted',
        sessionId: 'hive-session-b'
      })
    )
  })

  test('tracks and clears pending question / approval ownership by request id', async () => {
    const instance = createInstance()

    await invokeHandleEvent(
      instance,
      {
        data: {
          type: 'question.asked',
          properties: { id: 'q-1', requestId: 'q-1', sessionID: 'opc-session-1' }
        }
      },
      '/repo/b'
    )
    await invokeHandleEvent(
      instance,
      {
        data: {
          type: 'permission.asked',
          properties: { id: 'perm-1', sessionID: 'opc-session-1' }
        }
      },
      '/repo/b'
    )
    await invokeHandleEvent(
      instance,
      {
        data: {
          type: 'command.approval_needed',
          properties: { requestId: 'cmd-1', sessionID: 'opc-session-1' }
        }
      },
      '/repo/b'
    )

    expect(openCodeService.hasPendingQuestion?.('q-1')).toBe(true)
    expect(openCodeService.hasPendingApproval?.('perm-1')).toBe(true)
    expect(openCodeService.hasPendingApproval?.('cmd-1')).toBe(true)

    await openCodeService.questionReply('q-1', [['ok']], '/repo/b')
    await openCodeService.permissionReply('perm-1', 'once', '/repo/b')
    await openCodeService.permissionReply('cmd-1', 'reject', '/repo/b')

    expect(openCodeService.hasPendingQuestion?.('q-1')).toBe(false)
    expect(openCodeService.hasPendingApproval?.('perm-1')).toBe(false)
    expect(openCodeService.hasPendingApproval?.('cmd-1')).toBe(false)
  })

  test('abort flushes latest assistant snapshot and forces idle status', async () => {
    const send = vi.fn()
    openCodeService.setMainWindow({
      isDestroyed: () => false,
      isFocused: () => true,
      webContents: { send }
    } as never)

    const instance = createInstance()
    instance.client.session.abort = vi.fn().mockResolvedValue({ data: true })
    instance.client.session.messages = vi.fn().mockResolvedValue({
      data: [
        {
          info: {
            id: 'assistant-1',
            sessionID: 'opc-session-1',
            role: 'assistant'
          },
          parts: [{ type: 'text', text: 'partial answer' }]
        }
      ]
    })

    ;(openCodeService as never as { instance: unknown }).instance = instance

    const ok = await openCodeService.abort('/repo/b', 'opc-session-1')

    expect(ok).toBe(true)
    expect(send).toHaveBeenCalledWith(
      'agent:stream',
      expect.objectContaining({ type: 'message.updated', sessionId: 'hive-session-b' })
    )
    expect(send).toHaveBeenCalledWith(
      'agent:stream',
      expect.objectContaining({
        type: 'session.status',
        sessionId: 'hive-session-b',
        statusPayload: { type: 'idle' }
      })
    )
  })

  test('plan-mode assistant turn end synthesizes a plan.ready event', async () => {
    const send = vi.fn()
    openCodeService.setMainWindow({
      isDestroyed: () => false,
      isFocused: () => true,
      webContents: { send }
    } as never)

    const instance = createInstance()
    ;(openCodeService as never as { instance: unknown }).instance = instance

    // First: a part with the plan markdown (so the buffer has the text)
    await invokeHandleEvent(
      instance,
      {
        data: {
          type: 'message.part.updated',
          properties: {
            sessionID: 'opc-session-1',
            part: {
              type: 'text',
              id: 'prt-plan-text-1',
              messageID: 'msg-plan-1',
              text: '## Plan\n- step 1\n- step 2'
            }
          }
        }
      },
      '/repo/b'
    )

    // Then: message.updated with finish:stop / agent:plan completes the turn
    await invokeHandleEvent(
      instance,
      {
        data: {
          type: 'message.updated',
          properties: {
            sessionID: 'opc-session-1',
            info: {
              id: 'msg-plan-1',
              sessionID: 'opc-session-1',
              role: 'assistant',
              agent: 'plan',
              mode: 'plan',
              finish: 'stop',
              time: { created: 1000, completed: 2000 }
            }
          }
        }
      },
      '/repo/b'
    )

    const planReadyCall = send.mock.calls.find(
      (call) => call[0] === 'agent:stream' && call[1]?.type === 'plan.ready'
    )
    expect(planReadyCall).toBeDefined()
    expect(planReadyCall![1]).toMatchObject({
      type: 'plan.ready',
      sessionId: 'hive-session-b',
      data: {
        plan: '## Plan\n- step 1\n- step 2',
        toolUseID: 'msg-plan-1'
      }
    })
    // requestId is stable + namespaced so multiple plans don't collide
    expect(planReadyCall![1].data.requestId).toBe(
      'opencode-plan:hive-session-b:msg-plan-1'
    )

    // The matching `plan.ready` SessionActivity row must also be persisted —
    // PlanCard rendering in the durable timeline goes through
    // parsePlanPartFromActivity, which only sees activity rows. Without this
    // row the FAB pops up but no card appears in the message stream.
    const planActivityCall = mockDb.upsertSessionActivity.mock.calls.find(
      (call) => call[0]?.kind === 'plan.ready'
    )
    expect(planActivityCall).toBeDefined()
    expect(planActivityCall![0]).toMatchObject({
      id: 'opencode-plan:hive-session-b:msg-plan-1',
      session_id: 'hive-session-b',
      agent_session_id: 'opc-session-1',
      kind: 'plan.ready',
      tone: 'info',
      request_id: 'opencode-plan:hive-session-b:msg-plan-1',
      item_id: 'msg-plan-1'
    })
    const persistedPayload = JSON.parse(planActivityCall![0].payload_json as string)
    expect(persistedPayload).toMatchObject({
      plan: '## Plan\n- step 1\n- step 2',
      toolUseID: 'msg-plan-1',
      requestId: 'opencode-plan:hive-session-b:msg-plan-1'
    })

    // Idempotent: a re-emitted message.updated for the same id should NOT fire
    // a second plan.ready (the renderer guards on requestId, but defense in depth).
    send.mockClear()
    await invokeHandleEvent(
      instance,
      {
        data: {
          type: 'message.updated',
          properties: {
            sessionID: 'opc-session-1',
            info: {
              id: 'msg-plan-1',
              sessionID: 'opc-session-1',
              role: 'assistant',
              agent: 'plan',
              mode: 'plan',
              finish: 'stop',
              time: { created: 1000, completed: 2000 }
            }
          }
        }
      },
      '/repo/b'
    )
    const repeated = send.mock.calls.find(
      (call) => call[0] === 'agent:stream' && call[1]?.type === 'plan.ready'
    )
    expect(repeated).toBeUndefined()
  })

  test('non-plan agent turn does NOT synthesize plan.ready', async () => {
    const send = vi.fn()
    openCodeService.setMainWindow({
      isDestroyed: () => false,
      isFocused: () => true,
      webContents: { send }
    } as never)

    const instance = createInstance()
    ;(openCodeService as never as { instance: unknown }).instance = instance

    await invokeHandleEvent(
      instance,
      {
        data: {
          type: 'message.part.updated',
          properties: {
            sessionID: 'opc-session-1',
            part: {
              type: 'text',
              id: 'prt-build-text-1',
              messageID: 'msg-build-1',
              text: 'Done.'
            }
          }
        }
      },
      '/repo/b'
    )

    await invokeHandleEvent(
      instance,
      {
        data: {
          type: 'message.updated',
          properties: {
            sessionID: 'opc-session-1',
            info: {
              id: 'msg-build-1',
              sessionID: 'opc-session-1',
              role: 'assistant',
              agent: 'build',
              mode: 'build',
              finish: 'stop',
              time: { created: 1000, completed: 2000 }
            }
          }
        }
      },
      '/repo/b'
    )

    const planReadyCall = send.mock.calls.find(
      (call) => call[0] === 'agent:stream' && call[1]?.type === 'plan.ready'
    )
    expect(planReadyCall).toBeUndefined()
  })
})
