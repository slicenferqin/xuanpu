import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

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

function createCodexSessionRecord(
  overrides: Partial<{
    id: string
    worktree_id: string | null
    project_id: string
    connection_id: string | null
    name: string | null
    status: 'active' | 'completed' | 'error'
    opencode_session_id: string | null
    agent_sdk: 'opencode' | 'claude-code' | 'codex' | 'terminal'
    mode: 'build' | 'plan'
    model_provider_id: string | null
    model_id: string | null
    model_variant: string | null
    created_at: string
    updated_at: string
    completed_at: string | null
  }> = {}
) {
  return {
    id: 'test-session-1',
    worktree_id: 'wt-1',
    project_id: 'proj-1',
    connection_id: null,
    name: 'Test Codex Session',
    status: 'active' as const,
    opencode_session_id: 'opc-session-1',
    agent_sdk: 'codex' as const,
    mode: 'build' as const,
    model_provider_id: null,
    model_id: null,
    model_variant: null,
    created_at: '2026-03-31T09:00:00.000Z',
    updated_at: '2026-03-31T09:00:00.000Z',
    completed_at: null,
    ...overrides
  }
}

function createDurableCanonicalRows(assistantText = 'Canonical durable answer'): SessionMessage[] {
  return [
    {
      id: 'db-user-1',
      session_id: 'test-session-1',
      role: 'user',
      content: 'Inspect the repo',
      opencode_message_id: 'turn-1:user',
      opencode_message_json: null,
      opencode_parts_json: JSON.stringify([
        { type: 'text', text: 'Inspect the repo', timestamp: '2026-03-31T09:00:00.000Z' }
      ]),
      opencode_timeline_json: null,
      created_at: '2026-03-31T09:00:00.000Z'
    },
    {
      id: 'db-assistant-1',
      session_id: 'test-session-1',
      role: 'assistant',
      content: assistantText,
      opencode_message_id: 'turn-1:assistant',
      opencode_message_json: null,
      opencode_parts_json: JSON.stringify([
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-1',
            name: 'Read',
            input: { filePath: 'src/index.ts' },
            status: 'success',
            startTime: Date.parse('2026-03-31T09:00:05.000Z'),
            output: 'ok'
          }
        },
        {
          type: 'text',
          text: assistantText,
          timestamp: '2026-03-31T09:00:10.000Z'
        }
      ]),
      opencode_timeline_json: null,
      created_at: '2026-03-31T09:00:10.000Z'
    }
  ]
}

function createToolActivity(): SessionActivity[] {
  return [
    {
      id: 'activity-tool-1',
      session_id: 'test-session-1',
      agent_session_id: 'thread-1',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      item_id: 'tool-1',
      request_id: null,
      kind: 'tool.completed',
      tone: 'tool',
      summary: 'Read',
      payload_json: JSON.stringify({
        item: {
          toolName: 'Read',
          input: { filePath: 'src/index.ts' },
          output: 'ok'
        }
      }),
      sequence: null,
      created_at: '2026-03-31T09:00:05.000Z'
    }
  ]
}

function createLiveCodexTranscript(assistantText: string, options?: { includeTool?: boolean }) {
  const assistantParts = [
    ...(options?.includeTool === false
      ? []
      : [
          {
            type: 'tool',
            callID: 'tool-1',
            tool: 'Read',
            state: {
              status: 'completed',
              input: { filePath: 'src/index.ts' },
              output: 'ok'
            }
          }
        ]),
    { type: 'text', text: assistantText }
  ]

  return [
    {
      info: {
        id: 'turn-1:user',
        role: 'user',
        time: { created: Date.parse('2026-03-31T09:00:00.000Z') }
      },
      parts: [{ type: 'text', text: 'Inspect the repo' }]
    },
    {
      info: {
        id: 'turn-1:assistant',
        role: 'assistant',
        time: { created: Date.parse('2026-03-31T09:00:10.000Z') }
      },
      parts: assistantParts
    }
  ]
}

beforeEach(() => {
  vi.clearAllMocks()

  const sessionRecord = createCodexSessionRecord()

  useSessionStore.setState({
    sessionsByWorktree: new Map([['wt-1', [sessionRecord]]]),
    tabOrderByWorktree: new Map([['wt-1', ['test-session-1']]]),
    modeBySession: new Map([['test-session-1', 'build']]),
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
          path: '/tmp/worktree-codex-loading',
          status: 'active',
          is_default: true,
          created_at: '2026-03-31T08:59:00.000Z',
          last_accessed_at: '2026-03-31T08:59:00.000Z'
        }),
        update: vi.fn().mockResolvedValue(null)
      },
      sessionMessage: {
        list: vi.fn().mockResolvedValue([])
      },
      sessionActivity: {
        list: vi.fn().mockResolvedValue([])
      }
    },
    writable: true,
    configurable: true
  })

  Object.defineProperty(window, 'opencodeOps', {
    value: {
      connect: vi.fn().mockResolvedValue({ success: false }),
      reconnect: vi.fn().mockResolvedValue({ success: true }),
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
      onStream: vi.fn().mockImplementation(() => () => {})
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

describe('Codex SessionView loading', () => {
  it('uses durable canonical Codex messages as the primary source when they already exist', async () => {
    ;(window.db.sessionMessage.list as ReturnType<typeof vi.fn>).mockResolvedValue(
      createDurableCanonicalRows('Canonical durable answer')
    )
    ;(window.db.sessionActivity.list as ReturnType<typeof vi.fn>).mockResolvedValue(
      createToolActivity()
    )

    render(<SessionView sessionId="test-session-1" />)

    await waitFor(() => {
      expect(screen.getByText('Canonical durable answer')).toBeInTheDocument()
    })

    expect(screen.getAllByTestId('message-assistant')).toHaveLength(1)
    expect(window.opencodeOps.getMessages).not.toHaveBeenCalled()
  })

  it('does not replace a canonical durable Codex transcript with duplicate live rows while busy', async () => {
    useWorktreeStatusStore.getState().setSessionStatus('test-session-1', 'working')
    ;(window.db.sessionMessage.list as ReturnType<typeof vi.fn>).mockResolvedValue(
      createDurableCanonicalRows('Canonical durable answer')
    )
    ;(window.db.sessionActivity.list as ReturnType<typeof vi.fn>).mockResolvedValue(
      createToolActivity()
    )
    ;(window.opencodeOps.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      messages: createLiveCodexTranscript('Duplicate tool row')
    })

    render(<SessionView sessionId="test-session-1" />)

    await waitFor(() => {
      expect(screen.getByText('Canonical durable answer')).toBeInTheDocument()
    })

    expect(screen.queryByText(/duplicate tool row/i)).toBeNull()
    expect(window.opencodeOps.getMessages).not.toHaveBeenCalled()
  })

  it('falls back to live Codex messages when the durable transcript is empty and the session is busy', async () => {
    useWorktreeStatusStore.getState().setSessionStatus('test-session-1', 'working')
    ;(window.db.sessionMessage.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(window.db.sessionActivity.list as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(window.opencodeOps.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      messages: createLiveCodexTranscript('Live busy reply', { includeTool: false })
    })

    render(<SessionView sessionId="test-session-1" />)

    await waitFor(() => {
      expect(screen.getByText('Live busy reply')).toBeInTheDocument()
    })
  })
})
