import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { SessionShell } from '../../src/renderer/src/components/session-hq/SessionShell'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'
import { useWorktreeStore } from '../../src/renderer/src/stores/useWorktreeStore'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'
import { useSessionRuntimeStore } from '../../src/renderer/src/stores/useSessionRuntimeStore'
import { useWorktreeStatusStore } from '../../src/renderer/src/stores/useWorktreeStatusStore'
import { useContextStore } from '../../src/renderer/src/stores/useContextStore'

vi.mock('../../src/renderer/src/components/session-hq/AgentTimeline', () => ({
  AgentTimeline: ({
    timelineMessages,
    streamingContent
  }: {
    timelineMessages: Array<{ id: string; role: string; content: string }>
    streamingContent: string
  }) => (
    <div data-testid="agent-timeline">
      {timelineMessages.map((message) => (
        <div key={message.id} data-testid={`timeline-${message.role}`}>
          {message.content}
        </div>
      ))}
      {streamingContent ? <div data-testid="timeline-streaming">{streamingContent}</div> : null}
    </div>
  )
}))

vi.mock('../../src/renderer/src/components/sessions/MemoryPanel', () => ({
  MemoryPanel: () => null
}))

vi.mock('../../src/renderer/src/components/sessions/FieldContextDebug', () => ({
  FieldContextDebug: () => null
}))

function createSessionRecord() {
  return {
    id: 'hive-session-xuanpu',
    worktree_id: 'worktree-xuanpu',
    project_id: 'project-xuanpu',
    connection_id: null,
    name: 'Xuanpu Agent Dogfood',
    status: 'active' as const,
    opencode_session_id: null,
    agent_sdk: 'xuanpu-agent' as const,
    mode: 'build' as const,
    model_provider_id: 'anthropic',
    model_id: 'claude-haiku-4-5',
    model_variant: null,
    first_message_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null
  }
}

function createWorktreeRecord() {
  return {
    id: 'worktree-xuanpu',
    project_id: 'project-xuanpu',
    name: 'Xuanpu Agent Worktree',
    branch_name: 'feat/xuanpu-agent-oh-my-pi',
    path: '/tmp/xuanpu-agent-worktree',
    status: 'active' as const,
    is_default: false,
    branch_renamed: 1,
    last_message_at: null,
    session_titles: '[]',
    last_model_provider_id: null,
    last_model_id: null,
    last_model_variant: null,
    created_at: new Date().toISOString(),
    last_accessed_at: new Date().toISOString(),
    github_pr_number: null,
    github_pr_url: null
  }
}

function runtimeStatus(): XuanpuAgentRuntimeStatus {
  return {
    enabled: true,
    status: 'mock-ready',
    runtimeGateEnv: 'XUANPU_AGENT_RUNTIME',
    mockMode: true,
    providerReady: true,
    providerID: 'anthropic',
    modelID: 'claude-haiku-4-5',
    credential: {
      providerID: 'anthropic',
      required: true,
      present: true,
      envKeys: ['ANTHROPIC_API_KEY']
    },
    toolSurface: {
      status: 'blocked',
      toolsEnabled: false,
      nativeProcessControlEnabled: false,
      unmetGateIds: ['permission-policy']
    }
  }
}

function renderShell(): void {
  render(
    <TooltipProvider>
      <SessionShell sessionId="hive-session-xuanpu" />
    </TooltipProvider>
  )
}

describe('SessionShell xuanpu-agent dogfood path', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSessionRuntimeStore.getState().clearSession('hive-session-xuanpu')

    const session = createSessionRecord()
    const worktree = createWorktreeRecord()

    useSessionStore.setState({
      sessionsByWorktree: new Map([[worktree.id, [session]]]),
      tabOrderByWorktree: new Map([[worktree.id, [session.id]]]),
      modeBySession: new Map([[session.id, 'build']]),
      pendingMessages: new Map(),
      pendingMessageOptions: new Map(),
      pendingPlans: new Map(),
      pendingFollowUpMessages: new Map(),
      isLoading: false,
      error: null,
      activeSessionId: session.id,
      activeWorktreeId: worktree.id,
      activeSessionByWorktree: { [worktree.id]: session.id },
      sessionsByConnection: new Map(),
      tabOrderByConnection: new Map(),
      activeSessionByConnection: {},
      activeConnectionId: null,
      inlineConnectionSessionId: null,
      closedTerminalSessionIds: new Set()
    })

    useWorktreeStore.setState({
      worktreesByProject: new Map([[worktree.project_id, [worktree]]]),
      worktreeOrderByProject: new Map([[worktree.project_id, [worktree.id]]]),
      selectedWorktreeId: worktree.id,
      isLoading: false,
      error: null
    })

    useSettingsStore.setState({
      selectedModel: null,
      selectedModelByProvider: {},
      availableAgentSdks: {
        opencode: true,
        claude: false,
        codex: false,
        xuanpuAgent: true
      },
      defaultAgentSdk: 'opencode',
      skipForkFromMessageConfirm: false
    })

    useWorktreeStatusStore.setState({ sessionStatuses: {}, lastMessageTimeByWorktree: {} })
    useContextStore.setState({
      tokensBySession: {},
      costBySession: {},
      modelLimits: {},
      usageBySession: {}
    })

    Object.defineProperty(window, 'db', {
      configurable: true,
      writable: true,
      value: {
        session: {
          get: vi.fn().mockResolvedValue(session),
          update: vi.fn().mockResolvedValue({ ...session, opencode_session_id: 'runtime-xuanpu' }),
          getDraft: vi.fn().mockResolvedValue(null),
          updateDraft: vi.fn().mockResolvedValue(undefined)
        },
        worktree: {
          update: vi.fn().mockResolvedValue(worktree)
        },
        setting: {
          get: vi.fn().mockResolvedValue(null),
          set: vi.fn().mockResolvedValue(undefined)
        }
      }
    })

    Object.defineProperty(window, 'agentOps', {
      configurable: true,
      writable: true,
      value: {
        connect: vi.fn().mockResolvedValue({ success: true, sessionId: 'runtime-xuanpu' }),
        reconnect: vi.fn().mockResolvedValue({ success: true }),
        prompt: vi.fn().mockResolvedValue({ success: true }),
        steer: vi.fn().mockResolvedValue({ success: true }),
        abort: vi.fn().mockResolvedValue({ success: true }),
        getTimeline: vi.fn().mockResolvedValue({ messages: [] }),
        getMessages: vi.fn().mockResolvedValue({ success: true, messages: [] }),
        commands: vi.fn().mockResolvedValue({ success: true, commands: [] }),
        capabilities: vi.fn().mockResolvedValue({
          success: true,
          capabilities: {
            supportsSteer: false
          }
        }),
        listModels: vi.fn().mockResolvedValue({
          success: true,
          providers: [
            {
              id: 'anthropic',
              name: 'Anthropic',
              models: {
                'claude-haiku-4-5': {
                  id: 'claude-haiku-4-5',
                  name: 'Claude Haiku 4.5'
                }
              }
            }
          ]
        })
      }
    })

    Object.defineProperty(window, 'systemOps', {
      configurable: true,
      writable: true,
      value: {
        getXuanpuAgentRuntimeStatus: vi.fn().mockResolvedValue(runtimeStatus())
      }
    })

    Object.defineProperty(window, 'usageAnalyticsOps', {
      configurable: true,
      writable: true,
      value: {
        fetchSessionSummary: vi.fn().mockResolvedValue({ success: true, data: null })
      }
    })

    Object.defineProperty(window, 'fieldOps', {
      configurable: true,
      writable: true,
      value: {
        listContextPackages: vi.fn().mockImplementation(async (query: { sessionId?: string }) =>
          query.sessionId === 'runtime-xuanpu'
            ? [
                {
                  id: 'pkg-xuanpu',
                  sessionId: 'runtime-xuanpu',
                  worktreeId: worktree.id,
                  runtimeId: 'xuanpu-agent',
                  modelProviderId: 'anthropic',
                  modelId: 'claude-haiku-4-5',
                  createdAt: 1000,
                  budgetProfile: 'balanced',
                  approxTokens: 128,
                  sections: [
                    {
                      id: 'current-field',
                      kind: 'current_field',
                      title: 'Current Field',
                      included: true,
                      approxTokens: 64,
                      source: 'field-context'
                    }
                  ],
                  renderedMarkdown: null,
                  renderedMarkdownStored: false,
                  decisions: {
                    renderedMarkdownPolicy: 'omitted-by-default',
                    visibleTranscriptPolicy: 'persist-user-authored-message-only'
                  }
                }
              ]
            : []
        ),
        listEpisodeBlocks: vi.fn().mockResolvedValue([])
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('connects, prompts, and inspects context packages with the session selected model', async () => {
    renderShell()

    await waitFor(() => {
      expect(window.agentOps.connect).toHaveBeenCalledWith(
        '/tmp/xuanpu-agent-worktree',
        'hive-session-xuanpu'
      )
    })

    await waitFor(() => {
      expect(window.systemOps.getXuanpuAgentRuntimeStatus).toHaveBeenCalledWith({
        providerID: 'anthropic',
        modelID: 'claude-haiku-4-5'
      })
    })

    const input = await screen.findByPlaceholderText('Type a message...')
    await waitFor(() => {
      expect(input).not.toBeDisabled()
    })

    await userEvent.type(input, 'Reply through the xuanpu-agent Session HQ mock path.')
    const sendButton = screen.getByTestId('composer-primary-action')
    await waitFor(() => {
      expect(sendButton).not.toBeDisabled()
    })
    await userEvent.click(sendButton)

    await waitFor(() => {
      expect(window.agentOps.prompt).toHaveBeenCalledWith(
        '/tmp/xuanpu-agent-worktree',
        'runtime-xuanpu',
        'Reply through the xuanpu-agent Session HQ mock path.',
        {
          providerID: 'anthropic',
          modelID: 'claude-haiku-4-5'
        },
        undefined
      )
    })
    expect(
      await screen.findByText('Reply through the xuanpu-agent Session HQ mock path.')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByText('Context Budget'))

    await waitFor(() => {
      expect(window.fieldOps.listContextPackages).toHaveBeenCalledWith({
        worktreeId: 'worktree-xuanpu',
        sessionId: 'runtime-xuanpu',
        runtimeId: 'xuanpu-agent',
        includeRenderedMarkdown: false,
        limit: 5
      })
    })
    expect(await screen.findByText('Current Field')).toBeInTheDocument()
    expect(screen.getByText(/persist-user-authored-message-only/)).toBeInTheDocument()
  })
})
