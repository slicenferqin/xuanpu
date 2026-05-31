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

function createSessionRecord(
  overrides: Partial<{
    model_provider_id: string
    model_id: string
    opencode_session_id: string | null
  }> = {}
) {
  return {
    id: 'hive-session-xuanpu',
    worktree_id: 'worktree-xuanpu',
    project_id: 'project-xuanpu',
    connection_id: null,
    name: 'Xuanpu Agent Dogfood',
    status: 'active' as const,
    opencode_session_id: overrides.opencode_session_id ?? null,
    agent_sdk: 'xuanpu-agent' as const,
    mode: 'build' as const,
    model_provider_id: overrides.model_provider_id ?? 'anthropic',
    model_id: overrides.model_id ?? 'claude-haiku-4-5',
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

function runtimeStatus(
  overrides: Partial<XuanpuAgentRuntimeStatus> = {}
): XuanpuAgentRuntimeStatus {
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
    },
    ...overrides
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

    Object.defineProperty(window, 'voiceOps', {
      configurable: true,
      writable: true,
      value: {
        onRuntimeProgress: vi.fn(() => vi.fn()),
        onTranscript: vi.fn(() => vi.fn()),
        onVoiceError: vi.fn(() => vi.fn()),
        disconnectTranscription: vi.fn().mockResolvedValue(undefined),
        finishUtterance: vi.fn().mockResolvedValue(undefined),
        ensureRuntime: vi.fn(),
        detectRuntime: vi.fn(),
        startTranscription: vi.fn(),
        sendAudioChunk: vi.fn()
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

  const realProviderIt = process.env.XUANPU_AGENT_SESSION_SHELL_REAL_PROVIDER === '1' ? it : it.skip

  realProviderIt(
    'dogfoods Session HQ with a real OpenAI-compatible provider path',
    async () => {
      const previousRuntimeGate = process.env.XUANPU_AGENT_RUNTIME
      const previousMockResponse = process.env.XUANPU_AGENT_MOCK_RESPONSE
      const previousBaseUrl = process.env.XUANPU_AGENT_OPENAI_BASE_URL
      const session = createSessionRecord({
        model_provider_id: 'openai',
        model_id: 'gpt-5.4'
      })
      const worktree = createWorktreeRecord()
      let capturedAssistant = ''
      let piSession: { dispose(): void } | null = null

      if (!process.env.OPENAI_API_KEY?.trim()) {
        throw new Error('Set OPENAI_API_KEY before running Session HQ real-provider dogfood.')
      }
      if (
        !process.env.XUANPU_AGENT_OPENAI_BASE_URL?.trim() &&
        !process.env.OPENAI_BASE_URL?.trim()
      ) {
        throw new Error(
          'Set XUANPU_AGENT_OPENAI_BASE_URL or OPENAI_BASE_URL before running Session HQ real-provider dogfood.'
        )
      }

      process.env.XUANPU_AGENT_RUNTIME = '1'
      delete process.env.XUANPU_AGENT_MOCK_RESPONSE

      try {
        useSessionStore.setState({
          sessionsByWorktree: new Map([[worktree.id, [session]]]),
          tabOrderByWorktree: new Map([[worktree.id, [session.id]]]),
          activeSessionId: session.id,
          activeWorktreeId: worktree.id,
          activeSessionByWorktree: { [worktree.id]: session.id }
        })

        window.db.session.get = vi.fn().mockResolvedValue(session)
        window.db.session.update = vi
          .fn()
          .mockResolvedValue({ ...session, opencode_session_id: 'runtime-xuanpu-real' })
        window.agentOps.connect = vi
          .fn()
          .mockResolvedValue({ success: true, sessionId: 'runtime-xuanpu-real' })
        window.agentOps.reconnect = vi.fn().mockResolvedValue({ success: true })
        window.agentOps.listModels = vi.fn().mockResolvedValue({
          success: true,
          providers: [
            {
              id: 'openai',
              name: 'OpenAI',
              models: {
                'gpt-5.4': {
                  id: 'gpt-5.4',
                  name: 'gpt-5.4'
                }
              }
            }
          ]
        })
        window.systemOps.getXuanpuAgentRuntimeStatus = vi.fn().mockResolvedValue(
          runtimeStatus({
            status: 'ready',
            mockMode: false,
            providerReady: true,
            providerID: 'openai',
            modelID: 'gpt-5.4',
            credential: {
              providerID: 'openai',
              required: true,
              present: true,
              envKeys: ['OPENAI_API_KEY']
            }
          })
        )
        window.fieldOps.listContextPackages = vi
          .fn()
          .mockImplementation(async (query: { sessionId?: string }) =>
            query.sessionId === 'runtime-xuanpu-real'
              ? [
                  {
                    id: 'pkg-xuanpu-real',
                    sessionId: 'runtime-xuanpu-real',
                    worktreeId: worktree.id,
                    runtimeId: 'xuanpu-agent',
                    modelProviderId: 'openai',
                    modelId: 'gpt-5.4',
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
          )

        const { XuanpuPiAgentSession } =
          await import('../../src/main/services/xuanpu-agent/runtime')
        const realPiSession = new XuanpuPiAgentSession('session-shell-real-provider-dogfood')
        piSession = realPiSession
        window.agentOps.prompt = vi.fn(
          async (
            _worktreePath: string,
            _runtimeSessionId: string,
            content: string,
            modelOverride?: { providerID: string; modelID: string }
          ) => {
            const result = await realPiSession.prompt(String(content), {
              providerID: modelOverride?.providerID ?? 'openai',
              modelID: modelOverride?.modelID ?? 'gpt-5.4'
            })
            capturedAssistant = result.text
            return { success: true }
          }
        )

        renderShell()

        await waitFor(() => {
          expect(window.agentOps.connect).toHaveBeenCalledWith(
            '/tmp/xuanpu-agent-worktree',
            'hive-session-xuanpu'
          )
        })
        const input = await screen.findByPlaceholderText('Type a message...')
        await userEvent.type(
          input,
          'Reply with exactly this sentence and nothing else: Session HQ real provider dogfood ok'
        )
        await userEvent.click(screen.getByTestId('composer-primary-action'))

        await waitFor(
          () => {
            expect(window.agentOps.prompt).toHaveBeenCalledWith(
              '/tmp/xuanpu-agent-worktree',
              'runtime-xuanpu-real',
              'Reply with exactly this sentence and nothing else: Session HQ real provider dogfood ok',
              {
                providerID: 'openai',
                modelID: 'gpt-5.4'
              },
              undefined
            )
          },
          { timeout: 120000 }
        )
        await waitFor(
          () => {
            expect(capturedAssistant).toContain('Session HQ real provider dogfood ok')
          },
          { timeout: 120000 }
        )

        fireEvent.click(screen.getByText('Context Budget'))
        await waitFor(() => {
          expect(window.fieldOps.listContextPackages).toHaveBeenCalledWith({
            worktreeId: 'worktree-xuanpu',
            sessionId: 'runtime-xuanpu-real',
            runtimeId: 'xuanpu-agent',
            includeRenderedMarkdown: false,
            limit: 5
          })
        })
      } finally {
        piSession?.dispose()
        if (previousRuntimeGate === undefined) {
          delete process.env.XUANPU_AGENT_RUNTIME
        } else {
          process.env.XUANPU_AGENT_RUNTIME = previousRuntimeGate
        }
        if (previousMockResponse === undefined) {
          delete process.env.XUANPU_AGENT_MOCK_RESPONSE
        } else {
          process.env.XUANPU_AGENT_MOCK_RESPONSE = previousMockResponse
        }
        if (previousBaseUrl === undefined) {
          delete process.env.XUANPU_AGENT_OPENAI_BASE_URL
        } else {
          process.env.XUANPU_AGENT_OPENAI_BASE_URL = previousBaseUrl
        }
      }
    },
    120000
  )
})
