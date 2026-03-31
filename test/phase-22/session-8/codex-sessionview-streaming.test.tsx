import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

import { SessionView } from '../../../src/renderer/src/components/sessions/SessionView'
import { useSessionStore } from '../../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStatusStore } from '../../../src/renderer/src/stores/useWorktreeStatusStore'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('react-syntax-highlighter', () => ({
  Prism: ({ children }: { children: unknown }) => <pre>{children as string}</pre>
}))

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
  oneDark: {}
}))

function createCodexPlanSessionRecord() {
  return {
    id: 'test-session-1',
    worktree_id: 'wt-1',
    project_id: 'proj-1',
    connection_id: null,
    name: 'Test Codex Plan Session',
    status: 'active' as const,
    opencode_session_id: 'opc-session-1',
    agent_sdk: 'codex' as const,
    mode: 'plan' as const,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: '2026-03-31T09:00:00.000Z',
    updated_at: '2026-03-31T09:00:00.000Z',
    completed_at: null
  }
}

function createCanonicalPlanRows(): SessionMessage[] {
  return [
    {
      id: 'db-user-1',
      session_id: 'test-session-1',
      role: 'user',
      content: 'Plan this change',
      opencode_message_id: 'turn-1:user',
      opencode_message_json: null,
      opencode_parts_json: JSON.stringify([
        { type: 'text', text: 'Plan this change', timestamp: '2026-03-31T09:00:00.000Z' }
      ]),
      opencode_timeline_json: null,
      created_at: '2026-03-31T09:00:00.000Z'
    },
    {
      id: 'db-assistant-1',
      session_id: 'test-session-1',
      role: 'assistant',
      content: 'Canonical plan reply',
      opencode_message_id: 'turn-1:assistant',
      opencode_message_json: null,
      opencode_parts_json: JSON.stringify([
        {
          type: 'tool_use',
          toolUse: {
            id: 'plan-tool-1',
            name: 'ExitPlanMode',
            input: { plan: 'Plan\n\n1. Add tests' },
            status: 'success',
            startTime: Date.parse('2026-03-31T09:00:05.000Z')
          }
        },
        {
          type: 'text',
          text: 'Canonical plan reply',
          timestamp: '2026-03-31T09:00:10.000Z'
        }
      ]),
      opencode_timeline_json: null,
      created_at: '2026-03-31T09:00:10.000Z'
    }
  ]
}

let streamCallback: ((event: Record<string, unknown>) => void) | null = null
let durableMessageRows: SessionMessage[] = []
let durableActivityRows: SessionActivity[] = []

beforeEach(() => {
  vi.clearAllMocks()
  streamCallback = null
  durableMessageRows = []
  durableActivityRows = []

  const sessionRecord = createCodexPlanSessionRecord()

  useSessionStore.setState({
    sessionsByWorktree: new Map([['wt-1', [sessionRecord]]]),
    tabOrderByWorktree: new Map([['wt-1', ['test-session-1']]]),
    modeBySession: new Map([['test-session-1', 'plan']]),
    pendingMessages: new Map(),
    pendingPlans: new Map(),
    pendingFollowUpMessages: new Map(),
    isLoading: false,
    error: null,
    activeSessionId: 'test-session-1',
    activeWorktreeId: 'wt-1',
    activeSessionByWorktree: { 'wt-1': 'test-session-1' },
    sessionsByConnection: new Map(),
    tabOrderByConnection: new Map(),
    activeSessionByConnection: {},
    activeConnectionId: null,
    inlineConnectionSessionId: null,
    closedTerminalSessionIds: new Set()
  })
  useWorktreeStatusStore.setState({ sessionStatuses: {}, lastMessageTimeByWorktree: {} })

  Object.defineProperty(window, 'db', {
    value: {
      session: {
        get: vi.fn().mockResolvedValue(sessionRecord),
        create: vi.fn(),
        getActiveByWorktree: vi.fn().mockResolvedValue([sessionRecord]),
        update: vi.fn().mockResolvedValue(null),
        getDraft: vi.fn().mockResolvedValue(null),
        updateDraft: vi.fn().mockResolvedValue(undefined)
      },
      worktree: {
        get: vi.fn().mockResolvedValue({
          id: 'wt-1',
          project_id: 'proj-1',
          name: 'WT',
          branch_name: 'main',
          path: '/tmp/worktree-codex-streaming',
          status: 'active',
          is_default: true,
          created_at: '2026-03-31T08:59:00.000Z',
          last_accessed_at: '2026-03-31T08:59:00.000Z'
        }),
        update: vi.fn().mockResolvedValue(null)
      },
      sessionMessage: {
        list: vi.fn().mockImplementation(async () => durableMessageRows)
      },
      sessionActivity: {
        list: vi.fn().mockImplementation(async () => durableActivityRows)
      }
    },
    writable: true,
    configurable: true
  })

  Object.defineProperty(window, 'opencodeOps', {
    value: {
      connect: vi.fn().mockResolvedValue({ success: false }),
      reconnect: vi.fn().mockResolvedValue({ success: true, sessionStatus: 'busy' }),
      prompt: vi.fn().mockResolvedValue({ success: true }),
      command: vi.fn().mockResolvedValue({ success: true }),
      fork: vi.fn().mockResolvedValue({ success: true, sessionId: 'opc-fork-1' }),
      sessionInfo: vi
        .fn()
        .mockResolvedValue({ success: true, revertMessageID: null, revertDiff: null }),
      undo: vi.fn().mockResolvedValue({ success: true }),
      redo: vi.fn().mockResolvedValue({ success: true }),
      disconnect: vi.fn().mockResolvedValue({ success: true }),
      abort: vi.fn().mockResolvedValue({ success: true }),
      getMessages: vi.fn().mockResolvedValue({ success: true, messages: [] }),
      listModels: vi.fn().mockResolvedValue({ success: true, providers: [] }),
      setModel: vi.fn().mockResolvedValue({ success: true }),
      modelInfo: vi.fn().mockResolvedValue({ success: true }),
      questionReply: vi.fn().mockResolvedValue({ success: true }),
      questionReject: vi.fn().mockResolvedValue({ success: true }),
      permissionReply: vi.fn().mockResolvedValue({ success: true }),
      permissionList: vi.fn().mockResolvedValue({ success: true, permissions: [] }),
      commands: vi.fn().mockResolvedValue({ success: true, commands: [] }),
      capabilities: vi.fn().mockResolvedValue({
        success: true,
        capabilities: {
          supportsUndo: true,
          supportsRedo: true,
          supportsCommands: true,
          supportsPermissionRequests: true,
          supportsQuestionPrompts: true,
          supportsModelSelection: true,
          supportsReconnect: true,
          supportsPartialStreaming: true
        }
      }),
      onStream: vi.fn().mockImplementation((callback) => {
        streamCallback = callback as (event: Record<string, unknown>) => void
        return () => {}
      })
    },
    writable: true,
    configurable: true
  })

  Object.defineProperty(window, 'systemOps', {
    value: {
      isLogMode: vi.fn().mockResolvedValue(false),
      getLogDir: vi.fn().mockResolvedValue('/tmp/logs'),
      getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
      getAppPaths: vi.fn().mockResolvedValue({ userData: '/tmp', home: '/tmp', logs: '/tmp/logs' })
    },
    writable: true,
    configurable: true
  })

  Object.defineProperty(window, 'loggingOps', {
    value: {
      createResponseLog: vi.fn().mockResolvedValue('/tmp/log.jsonl'),
      appendResponseLog: vi.fn().mockResolvedValue(undefined)
    },
    writable: true,
    configurable: true
  })

  Object.defineProperty(global.navigator, 'clipboard', {
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue('')
    },
    writable: true,
    configurable: true
  })

  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
})

describe('Codex SessionView streaming finalization', () => {
  it('shows a transient plan card while proposed_plan XML is streaming', async () => {
    useWorktreeStatusStore.getState().setSessionStatus('test-session-1', 'planning')

    render(<SessionView sessionId="test-session-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('message-list')).toBeInTheDocument()
    })

    act(() => {
      streamCallback?.({
        sessionId: 'test-session-1',
        type: 'message.part.updated',
        data: {
          part: { type: 'text' },
          delta: 'Preface <proposed_plan>Plan\n\n1. Add tests'
        }
      })
    })

    await waitFor(() => {
      expect(screen.getByTestId('exit-plan-mode-tool-view')).toBeInTheDocument()
      expect(screen.getByText('Add tests')).toBeInTheDocument()
    })
  })

  it('replaces transient Codex plan streaming artifacts with the canonical durable transcript on idle', async () => {
    useWorktreeStatusStore.getState().setSessionStatus('test-session-1', 'planning')

    render(<SessionView sessionId="test-session-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('message-list')).toBeInTheDocument()
    })

    act(() => {
      streamCallback?.({
        sessionId: 'test-session-1',
        type: 'message.part.updated',
        data: {
          part: { type: 'text' },
          delta: 'Preface <proposed_plan>Plan\n\n1. Add tests'
        }
      })
    })

    await waitFor(() => {
      expect(screen.getAllByTestId('exit-plan-mode-tool-view')).toHaveLength(1)
    })

    durableMessageRows = createCanonicalPlanRows()

    act(() => {
      streamCallback?.({
        sessionId: 'test-session-1',
        type: 'plan.ready',
        data: {
          requestId: 'codex-plan:thread-1',
          plan: 'Plan\n\n1. Add tests',
          toolUseID: 'plan-tool-1'
        }
      })
    })

    await waitFor(() => {
      expect(screen.getAllByTestId('exit-plan-mode-tool-view')).toHaveLength(1)
    })

    act(() => {
      streamCallback?.({
        sessionId: 'test-session-1',
        type: 'session.status',
        statusPayload: { type: 'idle' },
        data: { status: { type: 'idle' } }
      })
    })

    await waitFor(() => {
      expect(screen.getByText('Canonical plan reply')).toBeInTheDocument()
    })

    expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
    expect(screen.getAllByTestId('exit-plan-mode-tool-view')).toHaveLength(1)
  })
})
