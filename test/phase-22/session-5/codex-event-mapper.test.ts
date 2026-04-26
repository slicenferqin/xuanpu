/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for codex-event-mapper. Complements the fixture-driven tests in
 * codex-event-mapper-fixtures.test.ts: this file exercises individual code
 * paths in isolation; the fixture file covers end-to-end real-traffic shapes.
 */
import { describe, it, expect } from 'vitest'
import {
  mapCodexEventToStreamEvents,
  contentStreamKindFromMethod,
  createCodexMapperState,
  normalizeCodexPlanUpdateTodos,
  buildCodexUpdatePlanCallId
} from '../../../src/main/services/codex-event-mapper'
import type { CodexManagerEvent } from '../../../src/main/services/codex-app-server-manager'

function makeEvent(overrides: Partial<CodexManagerEvent>): CodexManagerEvent {
  return {
    id: 'evt-1',
    kind: 'notification',
    provider: 'codex',
    threadId: 'thread-1',
    createdAt: new Date().toISOString(),
    method: '',
    ...overrides
  }
}

const HIVE = 'hive-test'

// ────────────────────────────────────────────────────────────────────
// contentStreamKindFromMethod
// ────────────────────────────────────────────────────────────────────
describe('contentStreamKindFromMethod', () => {
  it('classifies item/agentMessage/delta as assistant', () => {
    expect(contentStreamKindFromMethod('item/agentMessage/delta')).toBe('assistant')
  })
  it('classifies item/reasoning/textDelta as reasoning', () => {
    expect(contentStreamKindFromMethod('item/reasoning/textDelta')).toBe('reasoning')
  })
  it('classifies item/reasoning/summaryTextDelta as reasoning_summary', () => {
    expect(contentStreamKindFromMethod('item/reasoning/summaryTextDelta')).toBe('reasoning_summary')
  })
  it('does NOT classify command/file output deltas (they go to tool parts)', () => {
    expect(contentStreamKindFromMethod('item/commandExecution/outputDelta')).toBeNull()
    expect(contentStreamKindFromMethod('item/fileChange/outputDelta')).toBeNull()
  })
  it('returns null for unknown methods', () => {
    expect(contentStreamKindFromMethod('content.delta')).toBeNull()
    expect(contentStreamKindFromMethod('turn/started')).toBeNull()
  })
})

// ────────────────────────────────────────────────────────────────────
// content streaming deltas
// ────────────────────────────────────────────────────────────────────
describe('content streaming deltas', () => {
  it('maps agentMessage delta (textDelta on event) to text part', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({ method: 'item/agentMessage/delta', textDelta: 'Hello' }),
      HIVE
    )
    expect(result).toHaveLength(1)
    expect((result[0].data as any).part).toEqual({ type: 'text', text: 'Hello' })
  })

  it('maps agentMessage delta (string in payload.delta) to text part', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({ method: 'item/agentMessage/delta', payload: { delta: 'World' } }),
      HIVE
    )
    expect((result[0].data as any).part.text).toBe('World')
  })

  it('returns empty for delta with no text', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({ method: 'item/agentMessage/delta', payload: {} }),
      HIVE
    )
    expect(result).toEqual([])
  })

  it('maps reasoning/summaryTextDelta to reasoning part', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({ method: 'item/reasoning/summaryTextDelta', payload: { delta: 'thinking…' } }),
      HIVE
    )
    expect((result[0].data as any).part).toEqual({ type: 'reasoning', text: 'thinking…' })
  })
})

// ────────────────────────────────────────────────────────────────────
// turn lifecycle
// ────────────────────────────────────────────────────────────────────
describe('turn lifecycle', () => {
  it('turn/started → busy', () => {
    const result = mapCodexEventToStreamEvents(makeEvent({ method: 'turn/started' }), HIVE)
    expect(result[0].type).toBe('session.status')
    expect(result[0].statusPayload?.type).toBe('busy')
  })

  it('turn/completed (success) → idle', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({ method: 'turn/completed', payload: { turn: { status: 'completed' } } }),
      HIVE
    )
    const last = result[result.length - 1]
    expect(last.type).toBe('session.status')
    expect(last.statusPayload?.type).toBe('idle')
  })

  it('turn/completed (failed) → session.error + idle', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'turn/completed',
        payload: { turn: { status: 'failed', error: 'boom' } }
      }),
      HIVE
    )
    expect(result.some((e) => e.type === 'session.error')).toBe(true)
    expect(result[result.length - 1].statusPayload?.type).toBe('idle')
  })

  it('turn/completed with usage → message.updated', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'turn/completed',
        payload: { turn: { status: 'completed', usage: { totalTokens: 100 } } }
      }),
      HIVE
    )
    const upd = result.find((e) => e.type === 'message.updated')
    expect(upd).toBeDefined()
    expect((upd!.data as any).usage).toEqual({ totalTokens: 100 })
  })
})

// ────────────────────────────────────────────────────────────────────
// item lifecycle — tool parts
// ────────────────────────────────────────────────────────────────────
describe('item lifecycle → tool parts', () => {
  it('item/started commandExecution (no actions) → Bash tool part', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'item/started',
        payload: {
          item: {
            type: 'commandExecution',
            id: 'call-1',
            command: 'git status',
            cwd: '/tmp',
            status: 'inProgress'
          }
        }
      }),
      HIVE
    )
    const part = (result[0].data as any).part
    expect(part).toMatchObject({
      type: 'tool',
      callID: 'call-1',
      tool: 'Bash'
    })
    expect(part.state.status).toBe('running')
    expect(part.state.input.command).toBe('git status')
  })

  it('item/started commandExecution with single read action → Read', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'item/started',
        payload: {
          item: {
            type: 'commandExecution',
            id: 'call-2',
            command: 'cat README.md',
            commandActions: [
              { type: 'read', name: 'README.md', path: '/abs/README.md' }
            ],
            status: 'inProgress'
          }
        }
      }),
      HIVE
    )
    const part = (result[0].data as any).part
    expect(part.tool).toBe('Read')
    expect(part.state.input).toEqual({
      file_path: '/abs/README.md',
      displayName: 'README.md'
    })
  })

  it('item/started commandExecution with single search action → Grep', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'item/started',
        payload: {
          item: {
            type: 'commandExecution',
            id: 'call-3',
            command: "rg foo",
            commandActions: [{ type: 'search', query: 'foo', path: '/abs' }],
            status: 'inProgress'
          }
        }
      }),
      HIVE
    )
    const part = (result[0].data as any).part
    expect(part.tool).toBe('Grep')
    expect(part.state.input).toEqual({ pattern: 'foo', path: '/abs' })
  })

  it('item/started commandExecution with multi-action → stays Bash', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'item/started',
        payload: {
          item: {
            type: 'commandExecution',
            id: 'call-4',
            command: 'rg pat && cat f',
            commandActions: [
              { type: 'search', query: 'pat' },
              { type: 'read', path: 'f' }
            ],
            status: 'inProgress'
          }
        }
      }),
      HIVE
    )
    expect((result[0].data as any).part.tool).toBe('Bash')
  })

  it('item/completed commandExecution → completed status with output', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'item/completed',
        payload: {
          item: {
            type: 'commandExecution',
            id: 'call-5',
            command: 'echo hi',
            status: 'completed',
            aggregatedOutput: 'hi\n',
            exitCode: 0
          }
        }
      }),
      HIVE
    )
    const part = (result[0].data as any).part
    expect(part.state.status).toBe('completed')
    expect(part.state.output).toBe('hi\n')
    expect(part.state.metadata.exitCode).toBe(0)
  })

  it('item/started fileChange → Edit with changes[]', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'item/started',
        payload: {
          item: {
            type: 'fileChange',
            id: 'call-6',
            changes: [
              { path: '/p/README.md', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' }
            ],
            status: 'inProgress'
          }
        }
      }),
      HIVE
    )
    const part = (result[0].data as any).part
    expect(part.tool).toBe('Edit')
    expect(part.state.input.changes).toHaveLength(1)
    expect(part.state.input.file_path).toBe('/p/README.md')
    expect(part.state.input.diff).toContain('-a')
  })

  it('item/started agentMessage / reasoning / userMessage → no tool part', () => {
    for (const itemType of ['agentMessage', 'reasoning', 'userMessage']) {
      const result = mapCodexEventToStreamEvents(
        makeEvent({
          method: 'item/started',
          payload: { item: { type: itemType, id: 'x' } }
        }),
        HIVE
      )
      expect(result).toEqual([])
    }
  })

  it('item/started unknown type → Unknown tool part (visibility)', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'item/started',
        payload: { item: { type: 'futureThing', id: 'fut-1' } }
      }),
      HIVE
    )
    const part = (result[0].data as any).part
    expect(part.tool).toBe('Unknown')
    expect(part.toolDisplay).toBe('futureThing')
  })

  it('item/started mcpToolCall → McpTool with mcpServer + toolDisplay', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'item/started',
        payload: {
          item: {
            type: 'mcpToolCall',
            id: 'mcp-1',
            server: 'codex',
            tool: 'list_resources',
            arguments: { foo: 'bar' },
            status: 'inProgress'
          }
        }
      }),
      HIVE
    )
    const part = (result[0].data as any).part
    expect(part.tool).toBe('McpTool')
    expect(part.mcpServer).toBe('codex')
    expect(part.toolDisplay).toBe('list_resources')
    expect(part.state.input).toEqual({ arguments: { foo: 'bar' } })
  })
})

// ────────────────────────────────────────────────────────────────────
// commandExecution outputDelta — buffered into tool part state.output
// ────────────────────────────────────────────────────────────────────
describe('commandExecution outputDelta', () => {
  it('emits a tool part with accumulated output', () => {
    const state = createCodexMapperState()
    // First start the command so state is tracked
    mapCodexEventToStreamEvents(
      makeEvent({
        method: 'item/started',
        payload: {
          item: { type: 'commandExecution', id: 'c-1', command: 'x', status: 'inProgress' }
        }
      }),
      HIVE,
      state
    )
    const r1 = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'item/commandExecution/outputDelta',
        itemId: 'c-1',
        payload: { itemId: 'c-1', delta: 'hello ' }
      }),
      HIVE,
      state
    )
    expect((r1[0].data as any).part.state.output).toBe('hello ')

    const r2 = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'item/commandExecution/outputDelta',
        itemId: 'c-1',
        payload: { itemId: 'c-1', delta: 'world' }
      }),
      HIVE,
      state
    )
    // Buffer accumulated, not just current delta
    expect((r2[0].data as any).part.state.output).toBe('hello world')
  })

  it('drops delta with no callID or no payload', () => {
    expect(
      mapCodexEventToStreamEvents(
        makeEvent({ method: 'item/commandExecution/outputDelta', payload: {} }),
        HIVE
      )
    ).toEqual([])
  })
})

// ────────────────────────────────────────────────────────────────────
// fileChange outputDelta — dropped (just "Success." text)
// ────────────────────────────────────────────────────────────────────
describe('fileChange outputDelta', () => {
  it('drops fileChange outputDelta entirely', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'item/fileChange/outputDelta',
        payload: { delta: 'Success.\n' }
      }),
      HIVE
    )
    expect(result).toEqual([])
  })
})

// ────────────────────────────────────────────────────────────────────
// turn/plan/updated → TodoWrite synthesis
// ────────────────────────────────────────────────────────────────────
describe('turn/plan/updated', () => {
  it('synthesizes a TodoWrite tool part with stable callID', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'turn/plan/updated',
        turnId: 'turn-1',
        payload: {
          turnId: 'turn-1',
          plan: [
            { step: 'first', status: 'inProgress' },
            { step: 'second', status: 'pending' }
          ]
        }
      }),
      HIVE
    )
    const part = (result[0].data as any).part
    expect(part.tool).toBe('TodoWrite')
    expect(part.callID).toBe('update_plan-turn-1')
    expect(part.state.status).toBe('completed')
    expect(part.state.input.todos).toHaveLength(2)
    expect(part.state.input.todos[0].step).toBe('first')
    expect(part.state.input.todos[0].status).toBe('in_progress')
  })

  it('preserves explanation when present', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'turn/plan/updated',
        turnId: 't-2',
        payload: { turnId: 't-2', plan: [], explanation: 'reason' }
      }),
      HIVE
    )
    expect((result[0].data as any).part.state.input.explanation).toBe('reason')
  })
})

// ────────────────────────────────────────────────────────────────────
// turn/diff/updated → session.turn_diff
// ────────────────────────────────────────────────────────────────────
describe('turn/diff/updated', () => {
  it('emits session.turn_diff with diff text', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'turn/diff/updated',
        payload: { turnId: 't-3', diff: 'diff --git a/x b/x\n' }
      }),
      HIVE
    )
    expect(result[0].type).toBe('session.turn_diff')
    expect((result[0].data as any).turnId).toBe('t-3')
    expect((result[0].data as any).diff).toContain('diff --git')
  })

  it('drops if diff or turnId missing', () => {
    expect(
      mapCodexEventToStreamEvents(
        makeEvent({ method: 'turn/diff/updated', payload: {} }),
        HIVE
      )
    ).toEqual([])
  })
})

// ────────────────────────────────────────────────────────────────────
// thread/tokenUsage/updated → session.context_usage
// ────────────────────────────────────────────────────────────────────
describe('thread/tokenUsage/updated', () => {
  it('emits session.context_usage with totals + contextWindow', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'thread/tokenUsage/updated',
        payload: {
          tokenUsage: {
            total: {
              totalTokens: 1000,
              inputTokens: 800,
              outputTokens: 200,
              cachedInputTokens: 100,
              reasoningOutputTokens: 50
            },
            modelContextWindow: 475000
          }
        }
      }),
      HIVE
    )
    expect(result[0].type).toBe('session.context_usage')
    const data = result[0].data as any
    expect(data.tokens).toEqual({
      input: 800,
      output: 200,
      cacheRead: 100,
      reasoning: 50
    })
    expect(data.contextWindow).toBe(475000)
  })

  it('drops if tokenUsage missing', () => {
    expect(
      mapCodexEventToStreamEvents(
        makeEvent({ method: 'thread/tokenUsage/updated', payload: {} }),
        HIVE
      )
    ).toEqual([])
  })
})

// ────────────────────────────────────────────────────────────────────
// thread/status/changed → session.status
// ────────────────────────────────────────────────────────────────────
describe('thread/status/changed', () => {
  it('active → busy', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'thread/status/changed',
        payload: { status: { type: 'active' } }
      }),
      HIVE
    )
    expect(result[0].statusPayload?.type).toBe('busy')
  })

  it('idle → idle', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'thread/status/changed',
        payload: { status: { type: 'idle' } }
      }),
      HIVE
    )
    expect(result[0].statusPayload?.type).toBe('idle')
  })
})

// ────────────────────────────────────────────────────────────────────
// thread/name/updated → session.updated
// ────────────────────────────────────────────────────────────────────
describe('thread/name/updated', () => {
  it('emits session.updated with title', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({
        method: 'thread/name/updated',
        payload: { threadName: 'My Thread' }
      }),
      HIVE
    )
    expect(result[0].type).toBe('session.updated')
    expect((result[0].data as any).title).toBe('My Thread')
  })
})

// ────────────────────────────────────────────────────────────────────
// error / drop paths
// ────────────────────────────────────────────────────────────────────
describe('error & drop paths', () => {
  it('process/error → session.error', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({ kind: 'error', method: 'process/error', message: 'boom' }),
      HIVE
    )
    expect(result[0].type).toBe('session.error')
    expect((result[0].data as any).error).toBe('boom')
  })

  it('process/error with no message → "Unknown error"', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({ kind: 'error', method: 'process/error' }),
      HIVE
    )
    expect((result[0].data as any).error).toBe('Unknown error')
  })

  it('non-fatal error events drop', () => {
    expect(
      mapCodexEventToStreamEvents(
        makeEvent({ kind: 'error', method: 'protocol/parseError' }),
        HIVE
      )
    ).toEqual([])
  })

  it('process/stderr drops', () => {
    expect(
      mapCodexEventToStreamEvents(makeEvent({ method: 'process/stderr', message: 'warn' }), HIVE)
    ).toEqual([])
  })

  it('reasoning/summaryPartAdded drops (no UI signal)', () => {
    expect(
      mapCodexEventToStreamEvents(
        makeEvent({ method: 'item/reasoning/summaryPartAdded', payload: {} }),
        HIVE
      )
    ).toEqual([])
  })

  it('mcpServer/startupStatus/updated drops', () => {
    expect(
      mapCodexEventToStreamEvents(
        makeEvent({ method: 'mcpServer/startupStatus/updated', payload: {} }),
        HIVE
      )
    ).toEqual([])
  })

  it('account/rateLimits/updated drops', () => {
    expect(
      mapCodexEventToStreamEvents(
        makeEvent({ method: 'account/rateLimits/updated', payload: {} }),
        HIVE
      )
    ).toEqual([])
  })

  it('completely unknown method drops', () => {
    expect(
      mapCodexEventToStreamEvents(makeEvent({ method: 'something/totally/new' }), HIVE)
    ).toEqual([])
  })
})

// ────────────────────────────────────────────────────────────────────
// hiveSessionId passthrough
// ────────────────────────────────────────────────────────────────────
describe('session ID passthrough', () => {
  it('uses provided hiveSessionId in all events', () => {
    const result = mapCodexEventToStreamEvents(
      makeEvent({ method: 'turn/started' }),
      'hive-XYZ'
    )
    for (const ev of result) {
      expect(ev.sessionId).toBe('hive-XYZ')
    }
  })
})

// ────────────────────────────────────────────────────────────────────
// preserved API: normalizeCodexPlanUpdateTodos / buildCodexUpdatePlanCallId
// ────────────────────────────────────────────────────────────────────
describe('plan helpers (preserved API)', () => {
  it('normalizeCodexPlanUpdateTodos handles nested plan field', () => {
    const todos = normalizeCodexPlanUpdateTodos({
      plan: [
        { step: 'a', status: 'inProgress' },
        { step: 'b', status: 'completed' }
      ]
    })
    expect(todos).toHaveLength(2)
    expect(todos[0].status).toBe('in_progress')
    expect(todos[1].status).toBe('completed')
    expect(todos[0].step).toBe('a')
  })

  it('buildCodexUpdatePlanCallId uses turnId', () => {
    const id = buildCodexUpdatePlanCallId(
      makeEvent({ method: 'turn/plan/updated', turnId: 'T-7' })
    )
    expect(id).toBe('update_plan-T-7')
  })
})
