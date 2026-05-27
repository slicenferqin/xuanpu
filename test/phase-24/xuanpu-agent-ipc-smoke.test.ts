import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { DatabaseService } from '../../src/main/db/database'
import type { SessionMessage, Worktree } from '../../src/main/db/types'
import type { FieldContextPackageCreate } from '../../src/main/field/context-package-repository'

type IpcCallback = (event: unknown, ...args: unknown[]) => unknown

interface FakeTextPart {
  type: 'text'
  text: string
}

interface FakeAssistantMessage {
  role: 'assistant'
  content: FakeTextPart[]
  provider: string
  model: string
  usage: Record<string, unknown>
}

interface FakeAgentEvent {
  type: 'message_update' | 'message_end' | 'agent_end'
  message?: FakeAssistantMessage
  messages?: FakeAssistantMessage[]
}

type FakeAgentListener = (event: FakeAgentEvent) => void

const handlers = new Map<string, IpcCallback>()
const repositoryMocks = vi.hoisted(() => ({
  createFieldContextPackage: vi.fn((data: FieldContextPackageCreate) => ({
    ...data,
    id: 'context-package-1',
    createdAt: 1000,
    renderedMarkdownStored: Boolean(data.renderedMarkdown)
  })),
  listFieldEpisodeBlocks: vi.fn(() => []),
  createRuleBasedEpisodeFromTurns: vi.fn()
}))
const fieldEventMocks = vi.hoisted(() => ({
  emitFieldEvent: vi.fn()
}))
const checkpointMocks = vi.hoisted(() => ({
  verifyCheckpoint: vi.fn(async () => null)
}))
const fakeRuntime = vi.hoisted(() => {
  const prompts: unknown[] = []
  const setToolsCalls: unknown[][] = []

  class FakeAgent {
    readonly state: { messages: FakeAssistantMessage[]; error?: string } = { messages: [] }
    private readonly listeners = new Set<FakeAgentListener>()
    private model: Record<string, unknown> | null = null

    constructor(readonly options?: Record<string, unknown>) {}

    setModel(model: unknown): void {
      this.model = model && typeof model === 'object' ? (model as Record<string, unknown>) : null
    }

    setSystemPrompt(): void {}

    setTools(tools: unknown[]): void {
      setToolsCalls.push(tools)
    }

    subscribe(listener: FakeAgentListener): () => void {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    }

    async prompt(input: unknown): Promise<void> {
      prompts.push(input)
      const text =
        typeof this.model?.responseText === 'string' ? this.model.responseText : 'mock ok'
      const firstChunk = text.slice(0, Math.max(1, Math.floor(text.length / 2)))
      const message: FakeAssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text }],
        provider: 'xuanpu-agent',
        model: 'xuanpu-agent-mock',
        usage: { input: 1, output: 2 }
      }

      this.emit({
        type: 'message_update',
        message: { ...message, content: [{ type: 'text', text: firstChunk }] }
      })
      this.emit({ type: 'message_update', message })
      this.emit({ type: 'message_end', message })
      this.state.messages.push(message)
      this.emit({ type: 'agent_end', messages: this.state.messages })
    }

    abort(): void {}

    private emit(event: FakeAgentEvent): void {
      for (const listener of this.listeners) listener(event)
    }
  }

  return {
    prompts,
    setToolsCalls,
    FakeAgent,
    reset: () => {
      prompts.length = 0
      setToolsCalls.length = 0
    }
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, cb: IpcCallback) => handlers.set(channel, cb)
  },
  app: {
    getPath: vi.fn(() => '/tmp')
  }
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('../../src/main/services/telemetry-service', () => ({
  telemetryService: {
    track: vi.fn()
  }
}))

vi.mock('../../src/main/services/opencode-service', () => ({
  openCodeService: {
    setMainWindow: vi.fn()
  }
}))

vi.mock('../../src/main/field/privacy', () => ({
  isFieldCollectionEnabled: vi.fn(() => true)
}))

vi.mock('../../src/main/field/context-builder', () => ({
  buildFieldContextSnapshot: vi.fn(async () => null)
}))

vi.mock('../../src/main/field/context-formatter', () => ({
  formatFieldContext: vi.fn()
}))

vi.mock('../../src/main/field/last-injection-cache', () => ({
  cacheLastInjection: vi.fn()
}))

vi.mock('../../src/main/field/checkpoint-hooks', () => ({
  recordCheckpointOnAbort: vi.fn()
}))

vi.mock('../../src/main/field/checkpoint-verifier', () => ({
  verifyCheckpoint: checkpointMocks.verifyCheckpoint
}))

vi.mock('../../src/main/field/emit', () => ({
  emitFieldEvent: fieldEventMocks.emitFieldEvent
}))

vi.mock('../../src/main/field/context-package-repository', () => ({
  createFieldContextPackage: repositoryMocks.createFieldContextPackage
}))

vi.mock('../../src/main/field/episode-block-repository', () => ({
  listFieldEpisodeBlocks: repositoryMocks.listFieldEpisodeBlocks,
  createRuleBasedEpisodeFromTurns: repositoryMocks.createRuleBasedEpisodeFromTurns
}))

vi.mock('../../src/main/services/xuanpu-agent/pi-agent-core-loader', () => ({
  loadPiAgentCoreModule: vi.fn(async () => ({ Agent: fakeRuntime.FakeAgent })),
  loadPiAiModule: vi.fn(async () => ({
    createMockModel: vi.fn(
      (options: { id: string; provider: string; handler?: { content?: string[] } }) => ({
        model: {
          id: options.id,
          provider: options.provider,
          responseText: options.handler?.content?.join('') ?? 'mock ok'
        },
        stream: vi.fn()
      })
    )
  }))
}))

import { registerAgentHandlers } from '../../src/main/ipc/agent-handlers'
import { AgentRuntimeManager } from '../../src/main/services/agent-runtime-manager'
import { XuanpuAgentImplementer } from '../../src/main/services/xuanpu-agent-implementer'

class FakeDatabaseService {
  readonly messages: SessionMessage[] = []
  readonly worktrees: Worktree[]
  runtimeSessionId: string | null = null

  constructor(options: { worktrees?: Worktree[] } = {}) {
    this.worktrees = options.worktrees ?? [createFakeWorktree()]
  }

  getSession(id: string): { id: string; agent_sdk: 'xuanpu-agent' } | null {
    return id === 'hive-session-1' ? { id, agent_sdk: 'xuanpu-agent' } : null
  }

  getSessionByOpenCodeSessionId(id: string): { id: string; agent_sdk: 'xuanpu-agent' } | null {
    return id === this.runtimeSessionId ? { id: 'hive-session-1', agent_sdk: 'xuanpu-agent' } : null
  }

  updateSession(id: string, data: { opencode_session_id?: string; name?: string }): void {
    if (id === 'hive-session-1' && data.opencode_session_id) {
      this.runtimeSessionId = data.opencode_session_id
    }
  }

  getRuntimeIdForSession(sessionId: string): 'xuanpu-agent' | null {
    return sessionId === this.runtimeSessionId || sessionId === 'hive-session-1'
      ? 'xuanpu-agent'
      : null
  }

  getWorktreeByPath(path: string): Worktree | null {
    return (
      this.worktrees.find((worktree) => worktree.path === path && worktree.status === 'active') ??
      null
    )
  }

  getWorktreesByProject(projectId: string): Worktree[] {
    return this.worktrees.filter((worktree) => worktree.project_id === projectId)
  }

  getActiveWorktreesByProject(projectId: string): Worktree[] {
    return this.worktrees.filter(
      (worktree) => worktree.project_id === projectId && worktree.status === 'active'
    )
  }

  getSessionMessages(sessionId: string): SessionMessage[] {
    return this.messages.filter((message) => message.session_id === sessionId)
  }

  createSessionMessage(data: {
    session_id: string
    role: 'user' | 'assistant' | 'system'
    content: string
    opencode_message_id?: string
    opencode_message_json?: string | null
    opencode_parts_json?: string | null
    opencode_timeline_json?: string | null
    created_at?: string
  }): SessionMessage {
    const record = {
      id: `db-message-${this.messages.length + 1}`,
      session_id: data.session_id,
      role: data.role,
      content: data.content,
      opencode_message_id: data.opencode_message_id ?? null,
      opencode_message_json: data.opencode_message_json ?? null,
      opencode_parts_json: data.opencode_parts_json ?? null,
      opencode_timeline_json: data.opencode_timeline_json ?? null,
      created_at: data.created_at ?? new Date().toISOString()
    } as SessionMessage
    this.messages.push(record)
    return record
  }
}

function createFakeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'worktree-1',
    project_id: 'project-1',
    name: 'xuanpu--siberian-husky',
    branch_name: 'feat/xuanpu-agent-oh-my-pi',
    path: '/repo',
    status: 'active',
    is_default: false,
    branch_renamed: 1,
    last_message_at: null,
    session_titles: '[]',
    last_model_provider_id: null,
    last_model_id: null,
    last_model_variant: null,
    last_agent_sdk: 'xuanpu-agent',
    attachments: '[]',
    pinned: 0,
    context: null,
    github_pr_number: null,
    github_pr_url: null,
    created_at: '2026-05-27T00:00:00.000Z',
    last_accessed_at: '2026-05-27T00:00:00.000Z',
    ...overrides
  }
}

const previousMockResponse = process.env.XUANPU_AGENT_MOCK_RESPONSE

describe('xuanpu-agent IPC smoke', () => {
  beforeEach(() => {
    handlers.clear()
    fakeRuntime.reset()
    vi.clearAllMocks()
    repositoryMocks.listFieldEpisodeBlocks.mockReturnValue([])
    checkpointMocks.verifyCheckpoint.mockResolvedValue(null)
    process.env.XUANPU_AGENT_MOCK_RESPONSE = 'ipc mock response'
  })

  afterEach(() => {
    if (previousMockResponse === undefined) {
      delete process.env.XUANPU_AGENT_MOCK_RESPONSE
    } else {
      process.env.XUANPU_AGENT_MOCK_RESPONSE = previousMockResponse
    }
  })

  it('connects and prompts through agent IPC without prefixing visible user text', async () => {
    const dbService = new FakeDatabaseService()
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService(dbService as unknown as DatabaseService)
    const runtimeManager = new AgentRuntimeManager([implementer])
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    } as unknown as BrowserWindow

    registerAgentHandlers(mainWindow, runtimeManager, dbService as unknown as DatabaseService)

    const connect = handlers.get('agent:connect')!
    const connectResult = await connect({}, '/repo', 'hive-session-1')
    expect(connectResult).toMatchObject({ success: true })
    expect(dbService.runtimeSessionId).toMatch(/^xuanpu-agent-/)

    const prompt = handlers.get('agent:prompt')!
    const modelOverride = { providerID: 'openai', modelID: 'gpt-4.1' }
    const promptResult = await prompt(
      {},
      '/repo',
      dbService.runtimeSessionId,
      'hello from hq',
      modelOverride
    )
    expect(promptResult).toEqual({ success: true })

    const persisted = dbService.getSessionMessages('hive-session-1')
    expect(persisted.map((message) => [message.role, message.content])).toEqual([
      ['user', 'hello from hq'],
      ['assistant', 'ipc mock response']
    ])
    expect(repositoryMocks.createFieldContextPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'hive-session-1',
        runtimeId: 'xuanpu-agent',
        modelProviderId: 'openai',
        modelId: 'gpt-4.1',
        decisions: expect.objectContaining({
          providerExecution: 'enabled',
          visibleTranscriptPolicy: 'persist-user-authored-message-only',
          harnessMetrics: expect.objectContaining({
            cache: expect.objectContaining({
              inputTokens: 1,
              source: 'provider-usage'
            }),
            parallelTools: expect.objectContaining({
              totalToolCalls: 0
            })
          })
        }),
        sections: expect.arrayContaining([
          expect.objectContaining({
            kind: 'harness_metrics',
            title: 'Harness Metrics',
            included: true
          })
        ])
      })
    )
    expect(fieldEventMocks.emitFieldEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.message',
        payload: expect.objectContaining({
          agentSdk: 'xuanpu-agent',
          text: 'hello from hq',
          modelOverride
        })
      })
    )

    const piPrompt = fakeRuntime.prompts[0]
    expect(Array.isArray(piPrompt)).toBe(true)
    const piMessages = piPrompt as Array<{ content: FakeTextPart[] }>
    expect(piMessages.at(-1)?.content[0]?.text).toBe('hello from hq')
    expect(piMessages.map((message) => message.content[0]?.text).join('\n')).not.toContain(
      '[User Message]'
    )
    expect(
      fakeRuntime.setToolsCalls.map((tools) => tools.map((tool) => (tool as { name: string }).name))
    ).toEqual([
      [
        'git_status',
        'read_file',
        'rg_search',
        'list_files',
        'git_log',
        'git_diff',
        'apply_patch',
        'write_file',
        'edit_file',
        'run_test',
        'format_file',
        'xfp_get_current_focus',
        'xfp_get_last_terminal_activity',
        'xfp_get_recent_activity',
        'xfp_get_worktree_summary',
        'xfp_get_pinned_facts',
        'xfp_delegate_subtask'
      ]
    ])
  })

  it('injects multi-worktree and PR review context into the compiled XFP packet', async () => {
    const dbService = new FakeDatabaseService({
      worktrees: [
        createFakeWorktree({
          branch_name: 'feat/pr-review-context',
          last_message_at: 1760000000000,
          github_pr_number: 77,
          github_pr_url: 'https://github.com/acme/xuanpu/pull/77'
        }),
        createFakeWorktree({
          id: 'worktree-peer',
          name: 'xuanpu--main',
          branch_name: 'main',
          path: '/repo-main',
          last_message_at: 1759990000000,
          github_pr_number: null,
          github_pr_url: null
        })
      ]
    })
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService(dbService as unknown as DatabaseService)
    const runtimeManager = new AgentRuntimeManager([implementer])
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    } as unknown as BrowserWindow

    registerAgentHandlers(mainWindow, runtimeManager, dbService as unknown as DatabaseService)

    const connect = handlers.get('agent:connect')!
    await connect({}, '/repo', 'hive-session-1')

    const prompt = handlers.get('agent:prompt')!
    await prompt({}, '/repo', dbService.runtimeSessionId, 'review this PR', {
      providerID: 'openai',
      modelID: 'gpt-4.1'
    })

    const piPrompt = fakeRuntime.prompts[0] as Array<{ content: FakeTextPart[] }>
    const packetText = piPrompt[0].content[0].text
    expect(packetText).toContain('"multiWorktree"')
    expect(packetText).toContain('"worktreeId": "worktree-peer"')
    expect(packetText).toContain('"reviewContext"')
    expect(packetText).toContain('"attachedPullRequest"')
    expect(packetText).toContain('"number": 77')
    expect(packetText).toContain('"url": "https://github.com/acme/xuanpu/pull/77"')
    expect(repositoryMocks.createFieldContextPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        sections: expect.arrayContaining([
          expect.objectContaining({
            title: 'multiWorktree',
            included: true,
            metadata: expect.objectContaining({ rawRefCount: 2 })
          }),
          expect.objectContaining({
            title: 'reviewContext',
            included: true,
            metadata: expect.objectContaining({ rawRefCount: 2 })
          })
        ])
      })
    )
  })

  it('injects a correction turn for unverifiable assistant file-path claims', async () => {
    const dbService = new FakeDatabaseService()
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService(dbService as unknown as DatabaseService)
    const runtimeManager = new AgentRuntimeManager([implementer])
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    } as unknown as BrowserWindow

    process.env.XUANPU_AGENT_MOCK_RESPONSE = 'Updated src/missing/file.ts.'
    registerAgentHandlers(mainWindow, runtimeManager, dbService as unknown as DatabaseService)

    const connect = handlers.get('agent:connect')!
    await connect({}, '/repo', 'hive-session-1')

    const prompt = handlers.get('agent:prompt')!
    await prompt({}, '/repo', dbService.runtimeSessionId, 'claim check', {
      providerID: 'openai',
      modelID: 'gpt-4.1'
    })

    const persisted = dbService.getSessionMessages('hive-session-1')
    expect(persisted.map((message) => [message.role, message.content])).toEqual([
      ['user', 'claim check'],
      ['assistant', 'Updated src/missing/file.ts.'],
      [
        'assistant',
        expect.stringContaining(
          'Post-response claim verifier detected unverified file-path claims.'
        )
      ]
    ])
    expect(repositoryMocks.createFieldContextPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: expect.objectContaining({
          postResponseClaimVerification: expect.objectContaining({
            passed: false,
            unverifiedClaims: [
              expect.objectContaining({
                kind: 'file-path',
                value: 'src/missing/file.ts'
              })
            ]
          })
        })
      })
    )
  })

  it('injects a verified checkpoint into the compiled XFP packet on resume turns', async () => {
    const dbService = new FakeDatabaseService()
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService(dbService as unknown as DatabaseService)
    const runtimeManager = new AgentRuntimeManager([implementer])
    const mainWindow = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() }
    } as unknown as BrowserWindow

    checkpointMocks.verifyCheckpoint.mockResolvedValue({
      createdAt: 1760000000000,
      ageMinutes: 5,
      source: 'abort',
      summary: 'Stopped while editing runtime.',
      currentGoal: 'Finish checkpoint-aware prompt compile.',
      nextAction: 'Run the focused M6 tests.',
      blockingReason: null,
      hotFiles: ['src/main/services/xuanpu-agent-implementer.ts'],
      warnings: []
    })

    registerAgentHandlers(mainWindow, runtimeManager, dbService as unknown as DatabaseService)
    const connect = handlers.get('agent:connect')!
    await connect({}, '/repo', 'hive-session-1')

    const prompt = handlers.get('agent:prompt')!
    await prompt({}, '/repo', dbService.runtimeSessionId, '继续', {
      providerID: 'openai',
      modelID: 'gpt-4.1'
    })

    const piPrompt = fakeRuntime.prompts[0] as Array<{ content: FakeTextPart[] }>
    const packetText = piPrompt[0].content[0].text
    expect(packetText).toContain('Resumed Checkpoint')
    expect(packetText).toContain('"source": "checkpoint"')
    expect(packetText).toContain('Finish checkpoint-aware prompt compile.')
    expect(repositoryMocks.createFieldContextPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: expect.objectContaining({
          checkpointResume: expect.objectContaining({
            source: 'abort',
            hotFiles: ['src/main/services/xuanpu-agent-implementer.ts']
          })
        })
      })
    )
  })
})
