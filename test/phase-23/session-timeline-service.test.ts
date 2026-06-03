import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock the database module before importing the service
// ---------------------------------------------------------------------------
const mockGetSession = vi.fn()
const mockGetSessionMessages = vi.fn()
const mockGetSessionActivities = vi.fn()

vi.mock('../../src/main/db', () => ({
  getDatabase: () => ({
    getSession: mockGetSession,
    getSessionMessages: mockGetSessionMessages,
    getSessionActivities: mockGetSessionActivities
  })
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { getSessionTimeline } from '../../src/main/services/session-timeline-service'
import type { TimelineResult } from '../../src/shared/lib/timeline-types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    worktree_id: 'wt-1',
    project_id: 'proj-1',
    connection_id: null,
    name: 'Test Session',
    status: 'active',
    opencode_session_id: null,
    agent_sdk: 'opencode',
    mode: 'build',
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    completed_at: null,
    ...overrides
  }
}

function makeMessageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    session_id: 'sess-1',
    role: 'assistant',
    content: 'Hello',
    opencode_message_id: null,
    opencode_message_json: null,
    opencode_parts_json: null,
    opencode_timeline_json: null,
    created_at: '2024-01-01T00:00:01.000Z',
    ...overrides
  }
}

function makeActivityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'act-1',
    session_id: 'sess-1',
    agent_session_id: null,
    thread_id: null,
    turn_id: 'turn-1',
    item_id: 'item-1',
    request_id: null,
    kind: 'tool.completed',
    tone: 'tool',
    summary: 'Ran tool',
    payload_json: JSON.stringify({
      item: { toolName: 'read_file', input: { path: '/foo.ts' }, output: 'file content' }
    }),
    sequence: 1,
    created_at: '2024-01-01T00:00:02.000Z',
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGetSession.mockReset()
  mockGetSessionMessages.mockReset()
  mockGetSessionActivities.mockReset()
})

describe('getSessionTimeline', () => {
  describe('session not found', () => {
    it('returns empty result when session does not exist', () => {
      mockGetSession.mockReturnValue(null)

      const result = getSessionTimeline('nonexistent')
      expect(result).toEqual({
        messages: [],
        compactionMarkers: [],
        revertBoundary: null
      })
    })
  })

  describe('opencode / claude-code sessions', () => {
    it('maps DB rows when no timeline JSON is available', () => {
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'opencode' }))
      mockGetSessionMessages.mockReturnValue([
        makeMessageRow({ id: 'msg-1', role: 'user', content: 'hi' }),
        makeMessageRow({ id: 'msg-2', role: 'assistant', content: 'hello' })
      ])

      const result = getSessionTimeline('sess-1')
      expect(result.messages).toHaveLength(2)
      expect(result.messages[0].role).toBe('user')
      expect(result.messages[0].content).toBe('hi')
      expect(result.messages[1].role).toBe('assistant')
      expect(result.messages[1].content).toBe('hello')
      expect(result.compactionMarkers).toEqual([])
      expect(result.revertBoundary).toBeNull()
    })

    it('uses raw timeline JSON when available', () => {
      const rawTimeline = [
        {
          info: { id: 'raw-1', role: 'user', createdAt: '2024-01-01T00:00:00.000Z' },
          parts: [{ type: 'text', text: 'question' }]
        },
        {
          info: { id: 'raw-2', role: 'assistant', createdAt: '2024-01-01T00:00:01.000Z' },
          parts: [{ type: 'text', text: 'answer' }]
        }
      ]

      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'claude-code' }))
      mockGetSessionMessages.mockReturnValue([
        makeMessageRow({
          id: 'msg-1',
          opencode_timeline_json: JSON.stringify(rawTimeline)
        })
      ])

      const result = getSessionTimeline('sess-1')
      expect(result.messages).toHaveLength(2)
      expect(result.messages[0].id).toBe('raw-1')
      expect(result.messages[0].content).toBe('question')
      expect(result.messages[1].id).toBe('raw-2')
      expect(result.messages[1].content).toBe('answer')
    })

    it('falls back to DB rows when timeline JSON is corrupt', () => {
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'opencode' }))
      mockGetSessionMessages.mockReturnValue([
        makeMessageRow({
          id: 'msg-1',
          role: 'user',
          content: 'test message',
          opencode_timeline_json: 'not valid json{{'
        })
      ])

      const result = getSessionTimeline('sess-1')
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].content).toBe('test message')
    })

    it('falls back to DB rows when timeline JSON is empty array', () => {
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'opencode' }))
      mockGetSessionMessages.mockReturnValue([
        makeMessageRow({
          id: 'msg-1',
          role: 'user',
          content: 'fallback content',
          opencode_timeline_json: '[]'
        })
      ])

      const result = getSessionTimeline('sess-1')
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].content).toBe('fallback content')
    })

    it('preserves parts from opencode_parts_json in DB row mapper', () => {
      const parts = [
        { type: 'text', text: 'Hello world' },
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-1',
            name: 'read_file',
            input: { path: '/foo.ts' },
            status: 'success',
            startTime: 1704067200000
          }
        }
      ]
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'opencode' }))
      mockGetSessionMessages.mockReturnValue([
        makeMessageRow({
          id: 'msg-1',
          role: 'assistant',
          content: 'response',
          opencode_parts_json: JSON.stringify(parts)
        })
      ])

      const result = getSessionTimeline('sess-1')
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].parts).toHaveLength(2)
      expect(result.messages[0].parts![0].type).toBe('text')
      expect(result.messages[0].parts![1].type).toBe('tool_use')
      expect(result.messages[0].parts![1].toolUse?.name).toBe('read_file')
    })

    it('extracts compaction markers from timeline', () => {
      const rawTimeline = [
        {
          info: { id: 'msg-1', role: 'assistant', createdAt: '2024-01-01T00:00:00.000Z' },
          parts: [{ type: 'text', text: 'Before compaction' }]
        },
        {
          info: { id: 'msg-2', role: 'assistant', createdAt: '2024-01-01T00:01:00.000Z' },
          parts: [{ type: 'compaction', auto: true }]
        },
        {
          info: { id: 'msg-3', role: 'assistant', createdAt: '2024-01-01T00:02:00.000Z' },
          parts: [{ type: 'text', text: 'After compaction' }]
        }
      ]

      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'claude-code' }))
      mockGetSessionMessages.mockReturnValue([
        makeMessageRow({ opencode_timeline_json: JSON.stringify(rawTimeline) })
      ])

      const result = getSessionTimeline('sess-1')
      expect(result.compactionMarkers).toHaveLength(1)
      expect(result.compactionMarkers[0]).toBe('msg-2')
    })

    it('attaches plan.ready activity as ExitPlanMode tool_use part on matching opencode message', () => {
      const rawTimeline = [
        {
          info: { id: 'msg-plan-1', role: 'assistant', createdAt: '2024-01-01T00:00:00.000Z' },
          parts: [{ type: 'text', text: '## Plan\n- step 1' }]
        }
      ]
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'opencode' }))
      mockGetSessionMessages.mockReturnValue([
        makeMessageRow({
          opencode_timeline_json: JSON.stringify(rawTimeline)
        })
      ])
      mockGetSessionActivities.mockReturnValue([
        {
          id: 'opencode-plan:sess-1:msg-plan-1',
          session_id: 'sess-1',
          agent_session_id: 'opc-1',
          thread_id: null,
          turn_id: null,
          item_id: 'msg-plan-1',
          request_id: 'opencode-plan:sess-1:msg-plan-1',
          kind: 'plan.ready',
          tone: 'info',
          summary: 'Plan ready',
          payload_json: JSON.stringify({
            plan: '## Plan\n- step 1',
            toolUseID: 'msg-plan-1',
            requestId: 'opencode-plan:sess-1:msg-plan-1'
          }),
          sequence: null,
          created_at: '2024-01-01T00:00:01.000Z'
        }
      ])

      const result = getSessionTimeline('sess-1')
      expect(result.messages).toHaveLength(1)
      const parts = result.messages[0].parts
      expect(parts).toBeDefined()
      // text part stays + ExitPlanMode tool part appended
      const planPart = parts!.find(
        (p) => p.type === 'tool_use' && p.toolUse?.name === 'ExitPlanMode'
      )
      expect(planPart).toBeDefined()
      expect(planPart?.toolUse?.input).toMatchObject({ plan: '## Plan\n- step 1' })
      // Pending status because no plan.resolved row yet
      expect(planPart?.toolUse?.status).toBe('pending')
    })

    it('marks plan card as resolved when matching plan.resolved activity exists', () => {
      const rawTimeline = [
        {
          info: { id: 'msg-plan-1', role: 'assistant', createdAt: '2024-01-01T00:00:00.000Z' },
          parts: [{ type: 'text', text: '## Plan' }]
        }
      ]
      const reqId = 'opencode-plan:sess-1:msg-plan-1'
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'opencode' }))
      mockGetSessionMessages.mockReturnValue([
        makeMessageRow({
          opencode_timeline_json: JSON.stringify(rawTimeline)
        })
      ])
      mockGetSessionActivities.mockReturnValue([
        {
          id: reqId,
          session_id: 'sess-1',
          agent_session_id: 'opc-1',
          thread_id: null,
          turn_id: null,
          item_id: 'msg-plan-1',
          request_id: reqId,
          kind: 'plan.ready',
          tone: 'info',
          summary: 'Plan ready',
          payload_json: JSON.stringify({ plan: '## Plan', toolUseID: 'msg-plan-1' }),
          sequence: null,
          created_at: '2024-01-01T00:00:01.000Z'
        },
        {
          id: `${reqId}:resolved`,
          session_id: 'sess-1',
          agent_session_id: 'opc-1',
          thread_id: null,
          turn_id: null,
          item_id: null,
          request_id: reqId,
          kind: 'plan.resolved',
          tone: 'info',
          summary: 'Plan rejected by user',
          payload_json: JSON.stringify({ resolution: 'rejected' }),
          sequence: null,
          created_at: '2024-01-01T00:00:02.000Z'
        }
      ])

      const result = getSessionTimeline('sess-1')
      const planPart = result.messages[0].parts?.find(
        (p) => p.type === 'tool_use' && p.toolUse?.name === 'ExitPlanMode'
      )
      // Bug 3 fix: plan.resolved payload with resolution='rejected' must
      // surface a 'rejected' verdict on reload so PlanCard renders the
      // rejected state (greyed out) instead of mis-rendering as approved.
      expect(planPart?.toolUse?.status).toBe('rejected')
    })

    it('strips text part whose content matches the plan to avoid double-rendering', () => {
      // Symptom (2026-05-02 test): user saw the plan markdown twice — once as
      // an assistant text bubble and once as the "Proposed Execution Plan"
      // approval card. The merge now drops the assistant text part when its
      // content is fully contained in the plan we're rendering.
      const planText = '## My Plan\n- step 1\n- step 2'
      const rawTimeline = [
        {
          info: { id: 'msg-plan-2', role: 'assistant', createdAt: '2024-01-01T00:00:00.000Z' },
          parts: [{ type: 'text', text: planText }]
        }
      ]
      const reqId = 'opencode-plan:sess-1:msg-plan-2'
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'opencode' }))
      mockGetSessionMessages.mockReturnValue([
        makeMessageRow({ opencode_timeline_json: JSON.stringify(rawTimeline) })
      ])
      mockGetSessionActivities.mockReturnValue([
        {
          id: reqId,
          session_id: 'sess-1',
          agent_session_id: 'opc-1',
          thread_id: null,
          turn_id: null,
          item_id: 'msg-plan-2',
          request_id: reqId,
          kind: 'plan.ready',
          tone: 'info',
          summary: 'Plan ready',
          payload_json: JSON.stringify({ plan: planText, toolUseID: 'msg-plan-2' }),
          sequence: null,
          created_at: '2024-01-01T00:00:01.000Z'
        }
      ])

      const result = getSessionTimeline('sess-1')
      const parts = result.messages[0].parts ?? []
      // No more `text` part — it was duplicated by the plan card and got stripped
      const textParts = parts.filter((p) => p.type === 'text')
      expect(textParts).toHaveLength(0)
      // Plan card is still there
      const planPart = parts.find(
        (p) => p.type === 'tool_use' && p.toolUse?.name === 'ExitPlanMode'
      )
      expect(planPart?.toolUse?.input).toMatchObject({ plan: planText })
    })

    it('keeps text part if it does NOT match the plan content (e.g. preamble)', () => {
      // Defensive: only strip when content is duplicated. A legitimate
      // pre-plan preamble like "Here is my analysis..." must survive.
      const planText = '## Plan\n- step 1'
      const preamble = 'Here is my analysis based on the codebase.'
      const rawTimeline = [
        {
          info: { id: 'msg-plan-3', role: 'assistant', createdAt: '2024-01-01T00:00:00.000Z' },
          parts: [{ type: 'text', text: preamble }]
        }
      ]
      const reqId = 'opencode-plan:sess-1:msg-plan-3'
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'opencode' }))
      mockGetSessionMessages.mockReturnValue([
        makeMessageRow({ opencode_timeline_json: JSON.stringify(rawTimeline) })
      ])
      mockGetSessionActivities.mockReturnValue([
        {
          id: reqId,
          session_id: 'sess-1',
          agent_session_id: 'opc-1',
          thread_id: null,
          turn_id: null,
          item_id: 'msg-plan-3',
          request_id: reqId,
          kind: 'plan.ready',
          tone: 'info',
          summary: 'Plan ready',
          payload_json: JSON.stringify({ plan: planText, toolUseID: 'msg-plan-3' }),
          sequence: null,
          created_at: '2024-01-01T00:00:01.000Z'
        }
      ])

      const result = getSessionTimeline('sess-1')
      const parts = result.messages[0].parts ?? []
      const textParts = parts.filter((p) => p.type === 'text')
      // Preamble survives
      expect(textParts).toHaveLength(1)
      expect(textParts[0].text).toBe(preamble)
      // Plan card still present
      const planPart = parts.find(
        (p) => p.type === 'tool_use' && p.toolUse?.name === 'ExitPlanMode'
      )
      expect(planPart).toBeDefined()
    })
  })

  describe('codex sessions', () => {
    it('produces timeline from messages + activities', () => {
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'codex' }))
      mockGetSessionMessages.mockReturnValue([
        makeMessageRow({
          id: 'msg-1',
          role: 'user',
          content: 'Do something',
          opencode_message_id: 'turn-1:user'
        }),
        makeMessageRow({
          id: 'msg-2',
          role: 'assistant',
          content: 'Done',
          opencode_message_id: 'turn-1:assistant'
        })
      ])
      mockGetSessionActivities.mockReturnValue([
        makeActivityRow({
          id: 'act-1',
          turn_id: 'turn-1',
          kind: 'tool.completed',
          payload_json: JSON.stringify({
            item: { toolName: 'write_file', input: { path: '/bar.ts' }, output: 'ok' }
          })
        })
      ])

      const result = getSessionTimeline('sess-1')
      // Should have user + synthetic tool message + assistant
      expect(result.messages.length).toBeGreaterThanOrEqual(2)

      // Find the tool message
      const toolMsg = result.messages.find((m) => m.parts?.some((p) => p.type === 'tool_use'))
      expect(toolMsg).toBeDefined()
      expect(toolMsg?.parts?.[0].toolUse?.name).toBe('write_file')
    })

    it('fetches activities from DB for codex sessions', () => {
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'codex' }))
      mockGetSessionMessages.mockReturnValue([])
      mockGetSessionActivities.mockReturnValue([])

      getSessionTimeline('sess-1')

      expect(mockGetSessionActivities).toHaveBeenCalledWith('sess-1')
    })

    it('orders same-timestamp codex activities by persisted sequence', () => {
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'codex' }))
      mockGetSessionMessages.mockReturnValue([
        makeMessageRow({
          id: 'msg-user-1',
          role: 'user',
          content: 'Run both tools',
          opencode_message_id: 'turn-1:user',
          sequence: 1,
          created_at: '2024-01-01T00:00:00.000Z'
        }),
        makeMessageRow({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: 'Done',
          opencode_message_id: 'turn-1:assistant',
          sequence: 2,
          created_at: '2024-01-01T00:00:05.000Z'
        })
      ])
      mockGetSessionActivities.mockReturnValue([
        makeActivityRow({
          id: 'activity-a-lexically-first',
          turn_id: 'turn-1',
          item_id: 'tool-second',
          summary: 'Second',
          payload_json: JSON.stringify({
            item: { toolName: 'write_file', input: { path: '/second.ts' }, output: 'second' }
          }),
          sequence: 2,
          created_at: '2024-01-01T00:00:03.000Z'
        }),
        makeActivityRow({
          id: 'activity-z-lexically-last',
          turn_id: 'turn-1',
          item_id: 'tool-first',
          summary: 'First',
          payload_json: JSON.stringify({
            item: { toolName: 'read_file', input: { path: '/first.ts' }, output: 'first' }
          }),
          sequence: 1,
          created_at: '2024-01-01T00:00:03.000Z'
        })
      ])

      const result = getSessionTimeline('sess-1')

      expect(result.messages.map((message) => message.id)).toEqual([
        'turn-1:user',
        'turn-1:tool:tool-first',
        'turn-1:tool:tool-second',
        'turn-1:assistant'
      ])
    })

    it('does NOT fetch activities for claude-code sessions', () => {
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'claude-code' }))
      mockGetSessionMessages.mockReturnValue([])

      getSessionTimeline('sess-1')

      expect(mockGetSessionActivities).not.toHaveBeenCalled()
    })

    it('fetches activities for opencode sessions (plan-card merge, Phase 1.4.8)', () => {
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'opencode' }))
      mockGetSessionMessages.mockReturnValue([])
      mockGetSessionActivities.mockReturnValue([])

      getSessionTimeline('sess-1')

      expect(mockGetSessionActivities).toHaveBeenCalledWith('sess-1')
    })
  })

  describe('terminal sessions', () => {
    it('maps terminal messages from DB rows', () => {
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'terminal' }))
      mockGetSessionMessages.mockReturnValue([
        makeMessageRow({ id: 'msg-1', role: 'user', content: 'ls -la' }),
        makeMessageRow({ id: 'msg-2', role: 'assistant', content: 'total 42\n...' })
      ])

      const result = getSessionTimeline('sess-1')
      expect(result.messages).toHaveLength(2)
      expect(result.messages[0].role).toBe('user')
      expect(result.messages[1].role).toBe('assistant')
    })
  })

  describe('xuanpu-agent sessions', () => {
    it('merges plan.ready activity with item_id to produce single PlanCard on reload', () => {
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'xuanpu-agent' }))
      mockGetSessionMessages.mockReturnValue([
        makeMessageRow({
          id: 'msg-plan-1',
          role: 'assistant',
          content: '<proposed_plan>\n## Steps\n1. Fix auth\n2. Add tests\n</proposed_plan>'
        })
      ])
      mockGetSessionActivities.mockReturnValue([
        {
          id: 'xuanpu-agent-plan:sess-1:1000',
          session_id: 'sess-1',
          agent_session_id: 'sess-1',
          thread_id: 'sess-1',
          turn_id: 'msg-plan-1',
          item_id: 'msg-plan-1',
          request_id: 'xuanpu-agent-plan:sess-1:1000',
          kind: 'plan.ready',
          tone: 'info',
          summary: 'Plan ready',
          payload_json: JSON.stringify({
            plan: '## Steps\n1. Fix auth\n2. Add tests',
            toolUseID: 'msg-plan-1',
            requestId: 'xuanpu-agent-plan:sess-1:1000'
          }),
          sequence: null,
          created_at: '2024-01-01T00:00:01.000Z'
        }
      ])

      const result = getSessionTimeline('sess-1')
      expect(result.messages).toHaveLength(1)

      const parts = result.messages[0].parts ?? []
      // Plan card should be present
      const planPart = parts.find(
        (p) => p.type === 'tool_use' && p.toolUse?.name === 'ExitPlanMode'
      )
      expect(planPart).toBeDefined()
      expect(planPart?.toolUse?.input).toMatchObject({
        plan: '## Steps\n1. Fix auth\n2. Add tests'
      })
      expect(planPart?.toolUse?.status).toBe('pending')

      // No bare <proposed_plan> text should remain
      const textParts = parts.filter((p) => p.type === 'text')
      const hasRawPlan = textParts.some(
        (p) => p.text?.includes('<proposed_plan>') || p.text?.includes('</proposed_plan>')
      )
      expect(hasRawPlan).toBe(false)
    })

    it('fetches activities for xuanpu-agent sessions', () => {
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'xuanpu-agent' }))
      mockGetSessionMessages.mockReturnValue([])
      mockGetSessionActivities.mockReturnValue([])

      getSessionTimeline('sess-1')

      expect(mockGetSessionActivities).toHaveBeenCalledWith('sess-1')
    })

    it('renders xuanpu-agent tool activities before the final assistant text after reload', () => {
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'xuanpu-agent' }))
      mockGetSessionMessages.mockReturnValue([
        makeMessageRow({
          id: 'msg-user-1',
          role: 'user',
          content: '展示工具调用能力',
          opencode_message_id: 'xuanpu-agent-user-1',
          sequence: 1,
          created_at: '2024-01-01T00:00:00.000Z'
        }),
        makeMessageRow({
          id: 'msg-assistant-1',
          role: 'assistant',
          content: '可以，刚才我已经实际调用了一轮工具。',
          opencode_message_id: 'xuanpu-agent-response-1',
          sequence: 2,
          created_at: '2024-01-01T00:00:10.000Z'
        })
      ])
      mockGetSessionActivities.mockReturnValue([
        makeActivityRow({
          id: 'xuanpu-agent-tool:sess-1:turn-1:call-git-status:started',
          turn_id: 'turn-1',
          item_id: 'call-git-status',
          kind: 'tool.started',
          summary: 'git_status',
          payload_json: JSON.stringify({
            item: {
              toolName: 'git_status',
              input: {},
              status: 'running',
              time: { start: 1704067202000 }
            }
          }),
          sequence: 1,
          created_at: '2024-01-01T00:00:02.000Z'
        }),
        makeActivityRow({
          id: 'xuanpu-agent-tool:sess-1:turn-1:call-git-status:completed',
          turn_id: 'turn-1',
          item_id: 'call-git-status',
          kind: 'tool.completed',
          summary: 'git_status',
          payload_json: JSON.stringify({
            item: {
              toolName: 'git_status',
              input: {},
              output: 'On branch master',
              status: 'completed',
              time: { start: 1704067202000, end: 1704067204000 }
            }
          }),
          sequence: 2,
          created_at: '2024-01-01T00:00:04.000Z'
        })
      ])

      const result = getSessionTimeline('sess-1')

      expect(result.messages.map((message) => message.id)).toEqual([
        'xuanpu-agent-user-1',
        'turn-1:tool:call-git-status',
        'xuanpu-agent-response-1'
      ])
      const toolMessage = result.messages[1]
      const toolPart = toolMessage.parts?.find((part) => part.type === 'tool_use')
      expect(toolPart?.toolUse?.id).toBe('call-git-status')
      expect(toolPart?.toolUse?.name).toBe('git_status')
      expect(toolPart?.toolUse?.status).toBe('success')
      expect(toolPart?.toolUse?.output).toBe('On branch master')
    })

    it('marks xuanpu-agent plan as approved when plan.resolved has resolution=approved', () => {
      const reqId = 'xuanpu-agent-plan:sess-1:2000'
      mockGetSession.mockReturnValue(makeSession({ agent_sdk: 'xuanpu-agent' }))
      mockGetSessionMessages.mockReturnValue([
        makeMessageRow({
          id: 'msg-plan-2',
          role: 'assistant',
          content: '## My Plan\n- step 1'
        })
      ])
      mockGetSessionActivities.mockReturnValue([
        {
          id: reqId,
          session_id: 'sess-1',
          agent_session_id: 'sess-1',
          thread_id: 'sess-1',
          turn_id: 'msg-plan-2',
          item_id: 'msg-plan-2',
          request_id: reqId,
          kind: 'plan.ready',
          tone: 'info',
          summary: 'Plan ready',
          payload_json: JSON.stringify({
            plan: '## My Plan\n- step 1',
            toolUseID: 'msg-plan-2',
            requestId: reqId
          }),
          sequence: null,
          created_at: '2024-01-01T00:00:01.000Z'
        },
        {
          id: `${reqId}:resolved`,
          session_id: 'sess-1',
          agent_session_id: 'sess-1',
          thread_id: 'sess-1',
          turn_id: null,
          item_id: null,
          request_id: reqId,
          kind: 'plan.resolved',
          tone: 'info',
          summary: 'Plan approved by user',
          payload_json: JSON.stringify({ resolution: 'approved', requestId: reqId }),
          sequence: null,
          created_at: '2024-01-01T00:00:02.000Z'
        }
      ])

      const result = getSessionTimeline('sess-1')
      const planPart = result.messages[0].parts?.find(
        (p) => p.type === 'tool_use' && p.toolUse?.name === 'ExitPlanMode'
      )
      // Timeline mapper uses 'success' for approved plans (not 'approved')
      expect(planPart?.toolUse?.status).toBe('success')
    })
  })

  describe('result shape', () => {
    it('always returns TimelineResult shape', () => {
      mockGetSession.mockReturnValue(makeSession())
      mockGetSessionMessages.mockReturnValue([])

      const result: TimelineResult = getSessionTimeline('sess-1')
      expect(result).toHaveProperty('messages')
      expect(result).toHaveProperty('compactionMarkers')
      expect(result).toHaveProperty('revertBoundary')
      expect(Array.isArray(result.messages)).toBe(true)
      expect(Array.isArray(result.compactionMarkers)).toBe(true)
    })

    it('returns empty messages array for session with no messages', () => {
      mockGetSession.mockReturnValue(makeSession())
      mockGetSessionMessages.mockReturnValue([])

      const result = getSessionTimeline('sess-1')
      expect(result.messages).toEqual([])
    })

    it('revertBoundary is null by default', () => {
      mockGetSession.mockReturnValue(makeSession())
      mockGetSessionMessages.mockReturnValue([])

      const result = getSessionTimeline('sess-1')
      expect(result.revertBoundary).toBeNull()
    })
  })
})
