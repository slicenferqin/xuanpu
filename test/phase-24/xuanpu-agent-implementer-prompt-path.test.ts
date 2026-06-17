import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { DatabaseService } from '../../src/main/db/database'

// ── Mocks ──

const packContextMock = vi.hoisted(() => vi.fn())
const emitAgentEventMock = vi.hoisted(() => vi.fn())
const capturedEmittedEvents = vi.hoisted(
  () => [] as Array<{ type: string; sessionId: string; data: unknown }>
)
const capturedUsageEntries = vi.hoisted(() => [] as Array<Record<string, unknown>>)
const capturedActivities = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('electron', () => ({ app: undefined }))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('@shared/lib/normalize-agent-event', () => ({
  emitAgentEvent: (...args: unknown[]) => {
    emitAgentEventMock(...args)
    const event = args[1] as { type: string; sessionId: string; data: unknown }
    capturedEmittedEvents.push(event)
  },
  beginSessionRun: vi.fn()
}))

vi.mock('@shared/usage/pricing', () => ({
  calculateUsageCost: vi.fn(() => 0.005),
  resolvePricingModelKey: vi.fn((model: string) => model)
}))

vi.mock('../../src/main/services/xuanpu-agent/context/context-packer', () => ({
  packContext: packContextMock
}))

const turnRepoMock = vi.hoisted(() => ({
  createAgentTurn: vi.fn(() => ({ id: 'turn-test-1' })),
  updateAgentTurnStatus: vi.fn(),
  createAgentTurnContextSnapshot: vi.fn(),
  createAgentTurnUsageEvent: vi.fn()
}))

vi.mock('../../src/main/db/turn-repository', () => turnRepoMock)

const taskRunRepoMock = vi.hoisted(() => ({
  createTaskRun: vi.fn(() => ({
    id: 'task-run-test-1',
    sessionId: 'session-1',
    worktreeId: 'w-1',
    projectId: 'p-1',
    originMessageId: 'origin-1',
    status: 'running',
    objective: 'test objective',
    leaseExpiresAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    epochCount: 0,
    startedAt: '2026-06-09T00:00:00.000Z',
    completedAt: null,
    errorMessage: null
  })),
  getTaskRun: vi.fn(() => null),
  getActiveTaskRun: vi.fn(() => null),
  listTaskRunsForSession: vi.fn(() => []),
  createUserRound: vi.fn(() => ({
    id: 'round-test-1',
    taskRunId: 'task-run-test-1',
    sessionId: 'session-1',
    ordinal: 0,
    origin: 'user-originated',
    status: 'running',
    userMessageId: 'msg-user-1',
    promptText: 'test objective',
    providerRequestCount: 0,
    contextSegmentCount: 0,
    startedAt: '2026-06-09T00:00:00.000Z',
    completedAt: null,
    errorMessage: null
  })),
  appendContextSegment: vi.fn(() => ({
    id: 'epoch-test-1',
    taskRunId: 'task-run-test-1',
    sessionId: 'session-1',
    userRoundId: 'round-test-1',
    ordinal: 0,
    status: 'running',
    checkpointId: null,
    providerCallCount: 0,
    startFillRatio: null,
    endFillRatio: null,
    closeReason: null,
    startedAt: '2026-06-09T00:00:00.000Z',
    closedAt: null
  })),
  updateEpochStartFillRatio: vi.fn(),
  incrementEpochProviderCallCount: vi.fn(),
  closeEpoch: vi.fn(),
  updateUserRoundStatus: vi.fn(),
  updateTaskRunStatus: vi.fn(),
  accumulateUsage: vi.fn(),
  renewLease: vi.fn(),
  incrementUserRoundProviderRequestCount: vi.fn()
}))

vi.mock('../../src/main/db/task-run-repository', () => taskRunRepoMock)

const taskStateManagerMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  buildContextSummary: vi.fn(() => '## Task Objective\ntest objective'),
  updateFromTurn: vi.fn()
}))

const taskStateManagerCtorMock = vi.hoisted(() => vi.fn(() => taskStateManagerMock))

vi.mock('../../src/main/services/xuanpu-agent/task-state-manager', () => ({
  TaskStateManager: taskStateManagerCtorMock
}))

const checkpointRuntimeMocks = vi.hoisted(() => ({
  generateCheckpoint: vi.fn(async () => null),
  insertCheckpoint: vi.fn(() => true)
}))

vi.mock('../../src/main/field/checkpoint-generator', () => ({
  generateCheckpoint: checkpointRuntimeMocks.generateCheckpoint
}))

vi.mock('../../src/main/field/checkpoint-repository', () => ({
  insertCheckpoint: checkpointRuntimeMocks.insertCheckpoint
}))

vi.mock('../../src/main/field/episode-block-repository', () => ({
  listFieldEpisodeBlocks: vi.fn(() => [])
}))

vi.mock('../../src/main/services/xuanpu-agent/context/episode-summarizer', () => ({
  summarizeEpisode: vi.fn(async () => ({
    worktreeId: 'w-1',
    kind: 'turns',
    title: 'Frozen',
    summaryMarkdown: 'summary',
    keyFacts: [],
    constraints: [],
    files: [],
    commands: [],
    failures: [],
    rawRefs: [],
    confidence: 'medium'
  }))
}))

vi.mock('../../src/main/services/xuanpu-agent/context/compaction-model', () => ({
  resolveCompactionModel: vi.fn(async () => ({ kind: 'rule-based', source: 'fallback' }))
}))

// Mock IdeFieldProvider to return controlled data
const mockFieldProvider = {
  getWorktree: vi.fn(() => ({
    id: 'w-1',
    name: 'test',
    path: '/repo',
    context: 'test project',
    projectId: 'p-1'
  })),
  getSession: vi.fn(() => ({ id: 'session-1', projectId: 'p-1' })),
  getPriorTurns: vi.fn(() => [
    { messageId: 'msg-1', role: 'user' as const, content: 'first question', createdAt: 1000 },
    { messageId: 'msg-2', role: 'assistant' as const, content: 'first answer', createdAt: 2000 },
    { messageId: 'msg-3', role: 'user' as const, content: 'second question', createdAt: 3000 }
  ]),
  persistMessage: vi.fn(),
  buildFieldSnapshot: vi.fn(async () => ({
    markdown: '## Current Field\n\nfile: src/main.ts',
    approxTokens: 50,
    wasTruncated: false,
    capturedAt: Date.now()
  })),
  getEpisodeCandidates: vi.fn(() => []),
  retrieveEpisodes: vi.fn(() => ({
    included: [],
    dropped: 0,
    triggers: []
  })),
  freezeEpisodes: vi.fn(async () => {}),
  beginRun: vi.fn(),
  persistContextPackage: vi.fn()
}

vi.mock('../../src/main/services/xuanpu-agent/field/ide-field-provider', () => ({
  IdeFieldProvider: vi.fn(() => mockFieldProvider)
}))

vi.mock('../../src/main/services/xuanpu-agent/harness/compiler', () => ({
  XfpPacketCompiler: vi.fn(() => ({
    compile: vi.fn(() => ({
      packet: {
        version: '1.0',
        identity: { packetId: 'test-packet', capturedAt: Date.now(), worktreeId: 'w-1' },
        budget: { profile: 'balanced', fillRatio: 0 },
        worktree: { id: 'w-1', name: 'test', path: '/repo', branch: 'main', context: null },
        git: { branch: 'main', ahead: 0, behind: 0, dirty: false, stashes: 0 },
        session: { id: 's-1', turnCount: 0 },
        field: { currentFile: null, recentCommands: [], recentEvents: [] },
        checkpoints: [],
        memory: null
      },
      decisions: { includedSections: [], omittedSections: [] }
    }))
  }))
}))

vi.mock('../../src/main/services/xuanpu-agent/model-config', () => ({
  resolveXuanpuAgentModelRef: vi.fn(() => ({
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-6'
  }))
}))

vi.mock('../../src/main/services/xuanpu-agent/media-offloader', () => ({
  buildImageObservationRefFromBase64: vi.fn(() => ({
    path: '/tmp/xuanpu-agent-media/mock-image.png',
    mediaRef: 'image-sha256:mock-image',
    sha256: 'mock-image',
    bytes: 2,
    mimeType: 'image/png',
    filename: 'screen.png'
  })),
  formatImageObservationRef: vi.fn(() =>
    [
      '<ImageObservationRef raw="omitted-after-first-vision-request">',
      'sha256: mock-image',
      'path: /tmp/xuanpu-agent-media/mock-image.png',
      '</ImageObservationRef>'
    ].join('\n')
  ),
  MediaOffloadStore: vi.fn(() => ({
    writeImage: vi.fn(async () => ({
      path: '/tmp/xuanpu-agent-media/mock-image.png',
      mediaRef: 'image-sha256:mock-image',
      sha256: 'mock-image',
      bytes: 2,
      mimeType: 'image/png',
      extension: 'png',
      filename: 'screen.png'
    }))
  }))
}))

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    status: vi.fn(async () => ({ current: 'main', isClean: () => true })),
    log: vi.fn(async () => ({ latest: { hash: 'abc' } })),
    raw: vi.fn(async () => '')
  }))
}))

// Capture what piSession.prompt() receives
let capturedPromptMessages: unknown[] = []

const mockPiSession = {
  setWorktreePath: vi.fn(),
  setBudgetProfile: vi.fn(),
  setMaxContextTokens: vi.fn(),
  recordBudgetSections: vi.fn(),
  configureCompression: vi.fn(),
  setOnBeforeYield: vi.fn(),
  setFollowUpMode: vi.fn(),
  followUp: vi.fn(() => true),
  hasQueuedMessages: vi.fn(() => false),
  abort: vi.fn(),
  setPlanModeTools: vi.fn(),
  setBuildModeTools: vi.fn(),
  prompt: vi.fn(
    async (messages: unknown[], _modelRef: unknown, _handlers?: Record<string, unknown>) => {
      capturedPromptMessages = messages as unknown[]
      return {
        messageId: 'resp-1',
        text: 'mock response',
        modelRef: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
        usage: { inputTokens: 100, outputTokens: 50 },
        rawMessage: null,
        harnessMetrics: null
      }
    }
  ),
  getBudgetState: vi.fn(() => null),
  budgetManager: {
    recordPackerFillRatio: vi.fn(),
    recordCompression: vi.fn(),
    state: { fillRatio: 0, estimatedTokens: 0, maxTokens: 150_000 }
  }
}

vi.mock('../../src/main/services/xuanpu-agent/runtime', () => ({
  XuanpuPiAgentSession: vi.fn(() => mockPiSession)
}))

function makePackerDecisions(
  overrides: Partial<Record<string, unknown>> & {
    zones?: Record<string, unknown>
  } = {}
): Record<string, unknown> {
  return {
    contextTransform: 'm7-context-packer',
    zones: {
      anchor: { tokens: 10 },
      taskState: { tokens: 0, included: false },
      currentField: { tokens: 0, included: false },
      frozenEpisodes: { tokens: 0, count: 0, dropped: 0 },
      retrievedEpisodes: { tokens: 0, count: 0, dropped: 0, reasons: [], includedIds: [] },
      workingSet: {
        tokens: 50,
        count: 2,
        dedupedCount: 0,
        includedMessageIds: ['msg-1', 'msg-2'],
        droppedMessageIds: []
      },
      currentRequest: { tokens: 10 },
      ...(overrides.zones ?? {})
    },
    totalTokens: 100,
    fillRatio: 0.01,
    prefixHash: 'abc123',
    actualPrefixHash: 'abc123',
    prefixChangeReason: 'none',
    ...overrides
  }
}

describe('XuanpuAgentImplementer prompt path uses Context Packer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedPromptMessages = []
    capturedEmittedEvents.length = 0
    capturedUsageEntries.length = 0
    capturedActivities.length = 0
    taskStateManagerMock.initialize.mockClear()
    taskStateManagerMock.buildContextSummary.mockClear()
    taskStateManagerMock.buildContextSummary.mockReturnValue('## Task Objective\ntest objective')
    taskStateManagerMock.updateFromTurn.mockClear()
    taskStateManagerCtorMock.mockClear()
    mockPiSession.hasQueuedMessages.mockReturnValue(false)
    mockPiSession.followUp.mockReturnValue(true)
    taskRunRepoMock.getTaskRun.mockReturnValue(null)
    taskRunRepoMock.getActiveTaskRun.mockReturnValue(null)
    taskRunRepoMock.listTaskRunsForSession.mockReturnValue([])
    taskRunRepoMock.createTaskRun.mockReturnValue({
      id: 'task-run-test-1',
      sessionId: 'session-1',
      worktreeId: 'w-1',
      projectId: 'p-1',
      originMessageId: 'origin-1',
      status: 'running',
      objective: 'test objective',
      leaseExpiresAt: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      epochCount: 0,
      startedAt: '2026-06-09T00:00:00.000Z',
      completedAt: null,
      errorMessage: null
    })
    taskRunRepoMock.createUserRound.mockReturnValue({
      id: 'round-test-1',
      taskRunId: 'task-run-test-1',
      sessionId: 'session-1',
      ordinal: 0,
      origin: 'user-originated',
      status: 'running',
      userMessageId: 'msg-user-1',
      promptText: 'test objective',
      providerRequestCount: 0,
      contextSegmentCount: 0,
      startedAt: '2026-06-09T00:00:00.000Z',
      completedAt: null,
      errorMessage: null
    })
    taskRunRepoMock.appendContextSegment.mockReturnValue({
      id: 'epoch-test-1',
      taskRunId: 'task-run-test-1',
      sessionId: 'session-1',
      userRoundId: 'round-test-1',
      ordinal: 0,
      status: 'running',
      checkpointId: null,
      providerCallCount: 0,
      startFillRatio: null,
      endFillRatio: null,
      closeReason: null,
      startedAt: '2026-06-09T00:00:00.000Z',
      closedAt: null
    })
    checkpointRuntimeMocks.generateCheckpoint.mockResolvedValue(null)
    checkpointRuntimeMocks.insertCheckpoint.mockReturnValue(true)
    packContextMock.mockReturnValue({
      providerContextMessages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '<xuanpu-context-anchor>packed anchor</xuanpu-context-anchor>' }
          ],
          timestamp: 1
        }
      ],
      providerPromptMessage: {
        role: 'user',
        content: [{ type: 'text', text: 'current request' }],
        timestamp: 2
      },
      includedRetrievedEpisodes: [],
      decisions: makePackerDecisions()
    })
  })

  it('calls packContext with XFP packet anchor, episodes, working set, and current request', async () => {
    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn((entry: Record<string, unknown>) => {
        capturedUsageEntries.push(entry)
      }),
      upsertSessionActivity: vi.fn((activity: Record<string, unknown>) => {
        capturedActivities.push(activity)
      })
    } as unknown as DatabaseService)

    const { listFieldEpisodeBlocks } = await import('../../src/main/field/episode-block-repository')
    vi.mocked(listFieldEpisodeBlocks).mockReturnValue([
      {
        id: 'ep-1',
        worktreeId: 'w-1',
        sessionId: 's-1',
        createdAt: 1000,
        kind: 'turns',
        title: 'Frozen Turns',
        summaryMarkdown: 'Previously discussed auth bug',
        keyFacts: [],
        constraints: [],
        files: [],
        commands: [],
        failures: [],
        rawRefs: [{ type: 'session_message', id: 'msg-1', role: 'user' }],
        tokenEstimate: 50,
        confidence: 'medium',
        metadata: {}
      }
    ])

    // Connect a session so requireSession() works
    const { sessionId } = await implementer.connect('/repo', 'session-1')

    await implementer.prompt('/repo', sessionId, 'fix the bug')

    const { XuanpuPiAgentSession } = await import('../../src/main/services/xuanpu-agent/runtime')
    expect(vi.mocked(XuanpuPiAgentSession).mock.calls[0]?.[0]).toBe('session-1')

    // Verify packContext was called
    expect(packContextMock).toHaveBeenCalled()
    const packInput = packContextMock.mock.calls[0][0]

    // Verify stable anchor excludes volatile packet body.
    expect(packInput.anchor).toContain('<xuanpu-xfp-anchor')
    expect(packInput.anchor).not.toContain('test-packet')

    // Verify working set has prior turns (after freeze re-read)
    expect(packInput.workingSet).toBeDefined()
    expect(packInput.workingSet.length).toBe(3)
    expect(packInput.workingSet[0].messageId).toBe('msg-1')

    // Verify frozen episodes are passed
    expect(packInput.frozenEpisodes).toBeDefined()
    expect(packInput.frozenEpisodes.length).toBe(1)
    expect(packInput.frozenEpisodes[0].id).toBe('ep-1')

    // Verify current request and task state summary
    expect(packInput.currentRequest).toBe('fix the bug')
    expect(taskStateManagerMock.initialize).toHaveBeenCalledWith('test objective')
    expect(taskStateManagerMock.buildContextSummary).toHaveBeenCalled()
    expect(packInput.taskStateSummary).toContain('test objective')

    // Verify field context markdown is passed
    expect(packInput.fieldContextMarkdown).toContain('src/main.ts')

    // Verify piSession.prompt() receives packer output
    expect(capturedPromptMessages.length).toBe(2)
    const allText = capturedPromptMessages
      .flatMap((m: Record<string, unknown>) =>
        ((m.content as Array<Record<string, unknown>> | undefined) ?? []).map(
          (c: Record<string, unknown>) => (c.text as string) ?? ''
        )
      )
      .join('\n')
    expect(allText).toContain('<xuanpu-context-anchor>')
    expect(mockPiSession.prompt.mock.calls[0]?.[8]).toMatchObject({
      taskRunId: 'task-run-test-1',
      userRoundId: 'round-test-1',
      contextSegmentId: 'epoch-test-1',
      contextSegmentOrdinal: 0
    })
  })

  it('caps packer and snapshot budgets at the gateway policy when provider context is 1M', async () => {
    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    ;(implementer as unknown as { agentConfig: unknown }).agentConfig = {
      enabled: true,
      mainModel: { providerID: 'openai', modelID: 'gpt-5.5' },
      context: { contextWindow: 1_000_000 }
    }
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn()
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, 'stay under gateway policy')

    const packInput = packContextMock.mock.calls[0][0]
    expect(packInput.totalBudgetTokens).toBe(150_000)
    expect(mockPiSession.setMaxContextTokens).toHaveBeenCalledWith(250_000)

    const snapshotBudget = mockPiSession.prompt.mock.calls[0]?.[5] as Record<string, unknown>
    expect(snapshotBudget).toMatchObject({
      profile: 'focused',
      managedApproxTokens: 100,
      maxContextTokens: 250_000
    })
    expect(snapshotBudget.gateway).toMatchObject({
      action: 'continue',
      hardTokenLimit: 250_000,
      providerContextWindowTokens: 1_000_000
    })
  })

  it('pauses before calling the provider when the gateway hard limit is reached', async () => {
    const oversizedPack = {
      providerContextMessages: [
        { role: 'user', content: [{ type: 'text', text: '<oversized />' }], timestamp: 1 }
      ],
      providerPromptMessage: {
        role: 'user',
        content: [{ type: 'text', text: 'current request' }],
        timestamp: 2
      },
      includedRetrievedEpisodes: [],
      decisions: makePackerDecisions({
        totalTokens: 260_000,
        fillRatio: 1.3,
        prefixHash: 'too-large',
        actualPrefixHash: 'too-large',
        prefixChangeReason: 'none'
      })
    }
    packContextMock.mockReset()
    packContextMock.mockReturnValue(oversizedPack)

    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn()
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, 'this request is too large')

    expect(mockPiSession.prompt).not.toHaveBeenCalled()
    expect(turnRepoMock.createAgentTurnContextSnapshot).toHaveBeenCalled()
    const snapshot = turnRepoMock.createAgentTurnContextSnapshot.mock.calls[0][0]
    expect(JSON.parse(snapshot.decisionsJson).gateway).toMatchObject({
      action: 'pause',
      hardTokenLimit: 250_000
    })
    expect(taskRunRepoMock.updateTaskRunStatus).toHaveBeenCalledWith(
      'task-run-test-1',
      'paused',
      expect.objectContaining({
        errorMessage: expect.stringContaining('gateway paused before provider call')
      }),
      expect.anything()
    )
  })

  it('passes current-turn images to the provider prompt while keeping history text-only', async () => {
    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn()
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, [
      {
        type: 'file',
        mime: 'image/png',
        url: 'data:image/png;base64,abc',
        filename: 'screen.png'
      },
      { type: 'text', text: 'explain this screenshot' }
    ])

    const packInput = packContextMock.mock.calls[0][0]
    expect(packInput.currentRequest).toContain('<attached_files content="metadata-only">')
    expect(packInput.currentRequest).toContain('screen.png')
    expect(packInput.currentRequest).toContain('explain this screenshot')
    expect(packInput.currentRequest).not.toContain('data:image')
    expect(packInput.currentRequest).not.toContain('base64,abc')

    const persistedUserCall = mockFieldProvider.persistMessage.mock.calls.find(
      (call) => call[1] === 'user'
    )
    expect(persistedUserCall?.[2]).toBe(packInput.currentRequest)
    expect(String(persistedUserCall?.[2])).not.toContain('data:image')

    const providerPromptMessage = capturedPromptMessages[capturedPromptMessages.length - 1] as {
      content: Array<Record<string, unknown>>
    }
    expect(providerPromptMessage.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('explain this screenshot')
      }),
      {
        type: 'image',
        data: 'abc',
        mimeType: 'image/png'
      }
    ])
  })

  it('does not pre-flight freeze before packing stable prefix when below soft shrink threshold', async () => {
    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' }))
    } as unknown as DatabaseService)

    mockFieldProvider.getPriorTurns.mockReturnValueOnce([
      ...Array.from({ length: 10 }, (_, i) => ({
        messageId: `msg-${i}`,
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `turn ${i}`,
        createdAt: i * 1000
      }))
    ])

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, 'continue')

    const packInput = packContextMock.mock.calls[0][0]
    expect(packInput.workingSet.length).toBe(10)
    expect(mockFieldProvider.freezeEpisodes).not.toHaveBeenCalled()
    expect(mockFieldProvider.getPriorTurns).toHaveBeenCalledTimes(1)
  })

  it('soft-shrinks by freezing and repacking when packer fill ratio crosses threshold', async () => {
    packContextMock
      .mockReturnValueOnce({
        providerContextMessages: [
          { role: 'user', content: [{ type: 'text', text: '<anchor />' }], timestamp: 1 }
        ],
        providerPromptMessage: {
          role: 'user',
          content: [{ type: 'text', text: 'current request' }],
          timestamp: 2
        },
        includedRetrievedEpisodes: [],
        decisions: makePackerDecisions({
          totalTokens: 80_000,
          fillRatio: 0.45,
          prefixHash: 'abc123',
          actualPrefixHash: 'abc123',
          prefixChangeReason: 'none'
        })
      })
      .mockReturnValueOnce({
        providerContextMessages: [
          { role: 'user', content: [{ type: 'text', text: '<repacked />' }], timestamp: 1 }
        ],
        providerPromptMessage: {
          role: 'user',
          content: [{ type: 'text', text: 'current request' }],
          timestamp: 2
        },
        includedRetrievedEpisodes: [],
        decisions: makePackerDecisions({
          totalTokens: 40_000,
          fillRatio: 0.2,
          prefixHash: 'def456',
          actualPrefixHash: 'def456',
          prefixChangeReason: 'episodes'
        })
      })

    mockFieldProvider.getPriorTurns
      .mockReturnValueOnce([
        { messageId: 'msg-before', role: 'user' as const, content: 'before', createdAt: 1000 }
      ])
      .mockReturnValueOnce([
        { messageId: 'msg-after', role: 'user' as const, content: 'after', createdAt: 2000 }
      ])

    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn()
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, 'continue')

    expect(taskRunRepoMock.updateEpochStartFillRatio).toHaveBeenCalledWith(
      'epoch-test-1',
      0.45,
      expect.anything()
    )
    expect(mockFieldProvider.freezeEpisodes).toHaveBeenCalledWith('w-1', 'session-1')
    expect(packContextMock).toHaveBeenCalledTimes(2)
    expect(packContextMock.mock.calls[1][0]).toMatchObject({
      workingSet: [expect.objectContaining({ messageId: 'msg-after' })],
      budgetOverrides: {
        workingSet: 15_000,
        frozenEpisodes: 6_000
      }
    })
  })

  it('stable anchor is unchanged across turns despite different packetId and capturedAt', async () => {
    // Make compiler return different packetId/capturedAt on each call
    let compileCallCount = 0
    const { XfpPacketCompiler } =
      await import('../../src/main/services/xuanpu-agent/harness/compiler')
    vi.mocked(XfpPacketCompiler).mockImplementation(() => ({
      compile: vi.fn(() => {
        compileCallCount++
        return {
          packet: {
            version: '1.0',
            identity: {
              packetId: `test-packet-${compileCallCount}`,
              capturedAt: 1000000 + compileCallCount,
              worktreeId: 'w-1'
            },
            budget: { profile: 'balanced', fillRatio: 0 },
            worktree: { id: 'w-1', name: 'test', path: '/repo', branch: 'main', context: null },
            git: { branch: 'main', ahead: 0, behind: 0, dirty: false, stashes: 0 },
            session: { id: 's-1', turnCount: 0 },
            field: { currentFile: null, recentCommands: [], recentEvents: [] },
            checkpoints: [],
            memory: null
          },
          decisions: { includedSections: [], omittedSections: [] }
        }
      })
    }))

    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' }))
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')

    // First turn
    await implementer.prompt('/repo', sessionId, 'first request')
    const firstAnchor = packContextMock.mock.calls[0][0].anchor

    // Second turn — different packetId and capturedAt
    await implementer.prompt('/repo', sessionId, 'second request')
    const secondAnchor = packContextMock.mock.calls[1][0].anchor

    expect(firstAnchor).toBe(secondAnchor)
    expect(firstAnchor).not.toContain('test-packet-')
    expect(firstAnchor).toContain('version="1.0"')
  })

  it('emits session.context_usage after prompt with packer breakdown', async () => {
    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn()
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, 'test request')

    const contextEvent = capturedEmittedEvents.find((e) => e.type === 'session.context_usage')
    expect(contextEvent).toBeDefined()
    const data = contextEvent!.data as Record<string, unknown>
    expect(data.model).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-6' })
    // Three-layer format: managedContext / providerRequest / providerActual
    const managed = data.managedContext as Record<string, unknown>
    expect(managed.approxTokens).toBe(100)
    const request = data.providerRequest as Record<string, unknown>
    expect(request.providerRequestHash).toBeDefined()
    const actual = data.providerActual as Record<string, unknown>
    expect(actual.source).toBeDefined()
  })

  it('persists usage entry for cost tracking after prompt', async () => {
    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn((entry: Record<string, unknown>) => {
        capturedUsageEntries.push(entry)
      })
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, 'test request')

    expect(capturedUsageEntries.length).toBe(1)
    const entry = capturedUsageEntries[0]
    expect(entry.agent_sdk).toBe('xuanpu-agent')
    expect(entry.source_kind).toBe('xuanpu-agent-message')
    expect(entry.provider_id).toBe('anthropic')
    expect(entry.model_id).toBe('claude-sonnet-4-6')
    expect(entry.input_tokens).toBe(100)
    expect(entry.output_tokens).toBe(50)
  })

  it('emits plan.ready event when sessionMode is plan', async () => {
    mockPiSession.prompt.mockResolvedValueOnce({
      messageId: 'resp-plan',
      text: '<proposed_plan>\n## Steps\n1. Do thing\n2. Verify\n</proposed_plan>',
      modelRef: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
      usage: { inputTokens: 100, outputTokens: 50 },
      rawMessage: null,
      harnessMetrics: null
    })

    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn(),
      upsertSessionActivity: vi.fn((activity: Record<string, unknown>) => {
        capturedActivities.push(activity)
      })
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, 'make a plan', undefined, { mode: 'plan' })

    const planEvent = capturedEmittedEvents.find((e) => e.type === 'plan.ready')
    expect(planEvent).toBeDefined()
    const data = planEvent!.data as Record<string, unknown>
    expect(data.plan).toContain('## Steps')
    expect(data.plan).not.toContain('<proposed_plan>')
    expect(data.requestId).toContain('xuanpu-agent-plan:')

    expect(capturedActivities.length).toBe(1)
    expect(capturedActivities[0].kind).toBe('plan.ready')
  })

  it('does not emit plan.ready when sessionMode is build', async () => {
    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn()
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, 'just build it', undefined, { mode: 'build' })

    const planEvent = capturedEmittedEvents.find((e) => e.type === 'plan.ready')
    expect(planEvent).toBeUndefined()
  })

  it('persists xuanpu-agent tool activities so reload keeps tool cards before final text', async () => {
    mockPiSession.prompt.mockImplementationOnce(
      async (messages: unknown[], _modelRef: unknown, handlers?: Record<string, unknown>) => {
        capturedPromptMessages = messages as unknown[]
        const onToolStart = handlers?.onToolStart as
          | ((event: Record<string, unknown>, meta: Record<string, unknown>) => void)
          | undefined
        const onToolEnd = handlers?.onToolEnd as
          | ((event: Record<string, unknown>, meta: Record<string, unknown>) => void)
          | undefined

        onToolStart?.(
          {
            toolCallId: 'call-git-status',
            toolName: 'git_status',
            args: {},
            startedAt: 1704067202000
          },
          { turnId: 'turn-test-1', eventSequence: 1 }
        )
        onToolEnd?.(
          {
            toolCallId: 'call-git-status',
            toolName: 'git_status',
            args: {},
            result: { content: [{ type: 'text', text: 'On branch main' }] },
            isError: false,
            startedAt: 1704067202000,
            endedAt: 1704067203000
          },
          { turnId: 'turn-test-1', eventSequence: 2 }
        )

        return {
          messageId: 'resp-1',
          text: 'mock response',
          modelRef: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
          usage: { inputTokens: 100, outputTokens: 50 },
          rawMessage: null,
          harnessMetrics: null,
          turnId: 'turn-test-1'
        }
      }
    )

    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn(),
      upsertSessionActivity: vi.fn((activity: Record<string, unknown>) => {
        capturedActivities.push(activity)
      })
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, 'show tools')

    const toolActivities = capturedActivities.filter((activity) =>
      String(activity.kind).startsWith('tool.')
    )
    expect(toolActivities.map((activity) => activity.kind)).toEqual([
      'tool.started',
      'tool.completed'
    ])
    expect(toolActivities[0]).toMatchObject({
      session_id: 'session-1',
      agent_session_id: 'session-1',
      thread_id: 'session-1',
      turn_id: 'turn-test-1',
      item_id: 'call-git-status',
      summary: 'git_status'
    })
    expect(toolActivities[0].created_at).toBe('2024-01-01T00:00:02.000Z')
    expect(toolActivities[1].created_at).toBe('2024-01-01T00:00:03.000Z')

    const completedPayload = JSON.parse(toolActivities[1].payload_json as string)
    expect(completedPayload.item).toMatchObject({
      toolName: 'git_status',
      output: 'On branch main',
      status: 'completed'
    })
    expect(taskStateManagerMock.updateFromTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: 'show tools',
        assistantMessage: 'mock response',
        toolCalls: [
          expect.objectContaining({
            name: 'git_status',
            result: 'On branch main',
            isError: false
          })
        ],
        errors: []
      })
    )
  })

  it('queues an in-epoch follow-up for task runs before yielding', async () => {
    mockPiSession.prompt.mockImplementationOnce(
      async (messages: unknown[], _modelRef: unknown, handlers?: Record<string, unknown>) => {
        capturedPromptMessages = messages as unknown[]
        const onProviderCall = handlers?.onProviderCall as
          | ((event: Record<string, unknown>, meta: Record<string, unknown>) => void)
          | undefined
        onProviderCall?.(
          {
            providerCallSeq: 0,
            usage: { input: 10, output: 5 },
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-6',
            actualPrefixHash: 'abc123',
            cacheReadTokens: 0,
            cacheWriteTokens: 0
          },
          { turnId: 'turn-test-1' }
        )

        const beforeYield = mockPiSession.setOnBeforeYield.mock.calls.at(-1)?.[0] as
          | (() => Promise<void>)
          | undefined
        await beforeYield?.()

        return {
          messageId: 'resp-1',
          text: 'partial progress',
          modelRef: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
          usage: { input: 10, output: 5 },
          rawMessage: null,
          harnessMetrics: null,
          turnId: 'turn-test-1'
        }
      }
    )

    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn()
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, 'continue for a while')

    expect(mockPiSession.setFollowUpMode).toHaveBeenCalledWith('one-at-a-time')
    expect(mockPiSession.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        content: [expect.objectContaining({ text: expect.stringContaining('same-epoch') })]
      })
    )
  })

  it('creates a leased task run without classifying explicit long-task prompt text', async () => {
    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn()
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt(
      '/repo',
      sessionId,
      '请按 long task run 执行一次分阶段审计',
      undefined,
      {
        mode: 'build'
      }
    )

    expect(taskRunRepoMock.createTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseExpiresAt: expect.any(String)
      }),
      expect.anything()
    )
    expect(taskRunRepoMock.createTaskRun.mock.calls.at(-1)?.[0]).not.toHaveProperty('autonomy')
  })

  it('creates a leased task run for realistic multi-document package requests', async () => {
    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn()
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt(
      '/repo',
      sessionId,
      [
        '帮我基于当前仓库代码，整理一套 xuanpu-agent task-run 机制的内部工程文档包。文档要求：',
        '- 先读取相关源码或测试文件，再写文档。',
        '- 文档里要引用实际文件路径，例如 src/main/services/xuanpu-agent/task-run-policy.ts。',
        '- 每份文档要包含：背景、关键流程、相关代码、常见故障、验证方式。',
        '- 写完每份后更新 manifest.json，记录文件路径、主题、估算字符数、状态、引用过的源码文件。',
        '- 如果某份还没写完，manifest.json 里要标记 partial，不要假装完成。',
        '- 完成全部后，生成 README.md 作为入口索引。'
      ].join('\n'),
      undefined,
      {
        mode: 'build'
      }
    )

    expect(taskRunRepoMock.createTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseExpiresAt: expect.any(String)
      }),
      expect.anything()
    )
    expect(taskRunRepoMock.createTaskRun.mock.calls.at(-1)?.[0]).not.toHaveProperty('autonomy')
  })

  it('reuses a paused active task run when the user sends a continuation prompt', async () => {
    taskRunRepoMock.getActiveTaskRun.mockReturnValue({
      id: 'task-run-paused-1',
      sessionId: 'session-1',
      worktreeId: 'w-1',
      projectId: 'p-1',
      originMessageId: 'origin-1',
      status: 'paused',
      objective: 'original long objective',
      leaseExpiresAt: null,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCost: 0.5,
      epochCount: 2,
      startedAt: '2026-06-08T00:00:00.000Z',
      completedAt: null,
      errorMessage: 'no progress'
    })

    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn()
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, '继续跑完剩下的')

    expect(taskRunRepoMock.getActiveTaskRun).toHaveBeenCalledWith('session-1', expect.anything())
    expect(taskRunRepoMock.createTaskRun).not.toHaveBeenCalled()
    expect(taskRunRepoMock.createUserRound).toHaveBeenCalledWith(
      expect.objectContaining({
        taskRunId: 'task-run-paused-1',
        sessionId: 'session-1',
        origin: 'user-originated'
      }),
      expect.anything()
    )
    expect(taskRunRepoMock.appendContextSegment).toHaveBeenCalledWith(
      {
        taskRunId: 'task-run-paused-1',
        sessionId: 'session-1',
        userRoundId: 'round-test-1'
      },
      expect.anything()
    )
    expect(taskRunRepoMock.updateTaskRunStatus).toHaveBeenCalledWith(
      'task-run-paused-1',
      'running',
      expect.objectContaining({
        leaseExpiresAt: expect.any(String)
      }),
      expect.anything()
    )
  })

  it('does not reuse a paused active task run for an unrelated prompt', async () => {
    taskRunRepoMock.getActiveTaskRun.mockReturnValue({
      id: 'task-run-paused-1',
      sessionId: 'session-1',
      worktreeId: 'w-1',
      projectId: 'p-1',
      originMessageId: 'origin-1',
      status: 'paused',
      objective: 'original long objective',
      leaseExpiresAt: null,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCost: 0.5,
      epochCount: 2,
      startedAt: '2026-06-08T00:00:00.000Z',
      completedAt: null,
      errorMessage: 'no progress'
    })

    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn()
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, '解释一下当前架构')

    expect(taskRunRepoMock.getActiveTaskRun).not.toHaveBeenCalled()
    expect(taskRunRepoMock.createTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        objective: '解释一下当前架构'
      }),
      expect.anything()
    )
    expect(taskRunRepoMock.createTaskRun.mock.calls.at(-1)?.[0]).not.toHaveProperty('autonomy')
  })

  it('renews an expired task-run lease across multiple yield boundaries', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-09T00:21:00.000Z'))
    taskRunRepoMock.getTaskRun.mockReturnValue({
      id: 'task-run-expired-1',
      sessionId: 'session-1',
      worktreeId: 'w-1',
      projectId: 'p-1',
      originMessageId: 'origin-1',
      status: 'running',
      objective: 'original long objective',
      leaseExpiresAt: '2026-06-09T00:20:00.000Z',
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCost: 0.5,
      epochCount: 2,
      startedAt: '2026-06-09T00:00:00.000Z',
      completedAt: null,
      errorMessage: null
    })
    mockPiSession.prompt.mockImplementationOnce(
      async (messages: unknown[], _modelRef: unknown, _handlers?: Record<string, unknown>) => {
        capturedPromptMessages = messages as unknown[]
        const beforeYield = mockPiSession.setOnBeforeYield.mock.calls.at(-1)?.[0] as
          | (() => Promise<void>)
          | undefined

        await beforeYield?.()
        vi.setSystemTime(new Date('2026-06-09T00:42:00.000Z'))
        await beforeYield?.()

        return {
          messageId: 'resp-1',
          text: 'still working through the long task',
          modelRef: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
          usage: { input: 10, output: 5 },
          rawMessage: null,
          harnessMetrics: null,
          turnId: 'turn-test-1'
        }
      }
    )

    try {
      const { XuanpuAgentImplementer } =
        await import('../../src/main/services/xuanpu-agent-implementer')
      const implementer = new XuanpuAgentImplementer()
      implementer.setDatabaseService({
        getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
        getSetting: vi.fn(() => null),
        getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
        upsertUsageEntry: vi.fn()
      } as unknown as DatabaseService)

      const { sessionId } = await implementer.connect('/repo', 'session-1')
      await implementer.prompt('/repo', sessionId, 'continue expired lease', undefined, {
        taskRunId: 'task-run-expired-1'
      })

      expect(taskRunRepoMock.createTaskRun).not.toHaveBeenCalled()
      expect(taskRunRepoMock.renewLease).toHaveBeenCalledTimes(2)
      expect(taskRunRepoMock.renewLease).toHaveBeenNthCalledWith(
        1,
        'task-run-expired-1',
        '2026-06-09T00:41:00.000Z',
        expect.anything()
      )
      expect(taskRunRepoMock.renewLease).toHaveBeenNthCalledWith(
        2,
        'task-run-expired-1',
        '2026-06-09T01:02:00.000Z',
        expect.anything()
      )
      expect(
        taskRunRepoMock.updateTaskRunStatus.mock.calls.some(
          (call) => call[0] === 'task-run-expired-1' && call[1] === 'paused'
        )
      ).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes and checkpoints an epoch boundary, then queues the next epoch continuation', async () => {
    const createSessionPendingMessage = vi.fn()
    mockPiSession.prompt.mockImplementationOnce(
      async (messages: unknown[], _modelRef: unknown, handlers?: Record<string, unknown>) => {
        capturedPromptMessages = messages as unknown[]
        const onProviderCall = handlers?.onProviderCall as
          | ((event: Record<string, unknown>, meta: Record<string, unknown>) => void)
          | undefined
        for (let index = 0; index < 12; index++) {
          onProviderCall?.(
            {
              providerCallSeq: index,
              usage: { input: 10, output: 5 },
              providerID: 'anthropic',
              modelID: 'claude-sonnet-4-6',
              actualPrefixHash: 'abc123',
              cacheReadTokens: 0,
              cacheWriteTokens: 0
            },
            { turnId: 'turn-test-1' }
          )
        }

        const beforeYield = mockPiSession.setOnBeforeYield.mock.calls.at(-1)?.[0] as
          | (() => Promise<void>)
          | undefined
        await beforeYield?.()

        return {
          messageId: 'resp-1',
          text: 'checkpoint progress',
          modelRef: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
          usage: { input: 10, output: 5 },
          rawMessage: null,
          harnessMetrics: null,
          turnId: 'turn-test-1'
        }
      }
    )

    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn(),
      createSessionPendingMessage
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, 'long implementation task')

    expect(checkpointRuntimeMocks.insertCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'epoch',
        taskRunId: 'task-run-test-1',
        epochId: 'epoch-test-1',
        checkpointPurpose: 'task-epoch'
      })
    )
    expect(taskRunRepoMock.closeEpoch).toHaveBeenCalledWith(
      'epoch-test-1',
      expect.objectContaining({
        status: 'checkpointed',
        closeReason: 'checkpoint'
      }),
      expect.anything()
    )
    expect(createSessionPendingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'session-1',
        runtime_id: 'xuanpu-agent',
        prompt_options_json: expect.stringContaining('task-run-test-1')
      })
    )
    expect(
      taskRunRepoMock.updateTaskRunStatus.mock.calls.some(
        (call) => call[0] === 'task-run-test-1' && call[1] === 'completed'
      )
    ).toBe(false)
  })

  it('queues a next-turn continuation when a response explicitly says it is incomplete', async () => {
    const createSessionPendingMessage = vi.fn()
    mockPiSession.prompt.mockResolvedValueOnce({
      messageId: 'resp-1',
      text: '由于本次响应预算已到，我只完成到阶段 2 的文件读取开头，尚未完成 15 阶段。',
      modelRef: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
      usage: { input: 10, output: 5 },
      rawMessage: null,
      harnessMetrics: null,
      turnId: 'turn-test-1'
    })

    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn(),
      createSessionPendingMessage
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, 'long staged audit')

    expect(taskRunRepoMock.closeEpoch).toHaveBeenCalledWith(
      'epoch-test-1',
      expect.objectContaining({
        status: 'closed',
        closeReason: 'turn_end'
      }),
      expect.anything()
    )
    expect(createSessionPendingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'session-1',
        runtime_id: 'xuanpu-agent',
        content: expect.stringContaining('incomplete-response'),
        prompt_options_json: expect.stringContaining('"taskRunId":"task-run-test-1"')
      })
    )
    expect(createSessionPendingMessage.mock.calls[0][0].prompt_options_json).not.toContain(
      'taskRunAutonomy'
    )
    expect(
      taskRunRepoMock.updateTaskRunStatus.mock.calls.some(
        (call) => call[0] === 'task-run-test-1' && call[1] === 'completed'
      )
    ).toBe(false)
  })

  it('queues a recovery continuation instead of pausing on the first no-progress window', async () => {
    const createSessionPendingMessage = vi.fn()
    mockPiSession.prompt.mockImplementationOnce(
      async (messages: unknown[], _modelRef: unknown, handlers?: Record<string, unknown>) => {
        capturedPromptMessages = messages as unknown[]
        const onToolStart = handlers?.onToolStart as
          | ((event: Record<string, unknown>, meta: Record<string, unknown>) => void)
          | undefined
        const onToolEnd = handlers?.onToolEnd as
          | ((event: Record<string, unknown>, meta: Record<string, unknown>) => void)
          | undefined

        onToolStart?.(
          {
            toolCallId: 'call-bad-rg',
            toolName: 'rg_search',
            args: { pattern: 'task run', maxResults: 300 },
            startedAt: 1704067202000
          },
          { turnId: 'turn-test-1', eventSequence: 1 }
        )
        onToolEnd?.(
          {
            toolCallId: 'call-bad-rg',
            toolName: 'rg_search',
            args: { pattern: 'task run', maxResults: 300 },
            result: {
              content: [{ type: 'text', text: 'Validation failed: maxResults must be <= 200' }]
            },
            isError: true,
            startedAt: 1704067202000,
            endedAt: 1704067203000
          },
          { turnId: 'turn-test-1', eventSequence: 2 }
        )

        const beforeYield = mockPiSession.setOnBeforeYield.mock.calls.at(-1)?.[0] as
          | (() => Promise<void>)
          | undefined
        for (let index = 0; index < 4; index++) {
          await beforeYield?.()
        }

        return {
          messageId: 'resp-1',
          text: '任务尚未完成；本轮没有新的文件读取或写入。',
          modelRef: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
          usage: { input: 10, output: 5 },
          rawMessage: null,
          harnessMetrics: null,
          turnId: 'turn-test-1'
        }
      }
    )

    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn(),
      createSessionPendingMessage
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, 'long staged audit')

    expect(taskRunRepoMock.closeEpoch).toHaveBeenCalledWith(
      'epoch-test-1',
      expect.objectContaining({
        status: 'checkpointed',
        closeReason: 'watchdog'
      }),
      expect.anything()
    )
    expect(createSessionPendingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'session-1',
        runtime_id: 'xuanpu-agent',
        content: expect.stringContaining('no-progress-recovery'),
        prompt_options_json: expect.stringContaining('"taskRunId":"task-run-test-1"')
      })
    )
    expect(
      taskRunRepoMock.updateTaskRunStatus.mock.calls.some(
        (call) => call[0] === 'task-run-test-1' && call[1] === 'paused'
      )
    ).toBe(false)
    expect(
      taskRunRepoMock.updateTaskRunStatus.mock.calls.some(
        (call) => call[0] === 'task-run-test-1' && call[1] === 'completed'
      )
    ).toBe(false)
  })

  it('defers continuation to the final incomplete response after successful tool progress', async () => {
    const createSessionPendingMessage = vi.fn()
    mockPiSession.prompt.mockImplementationOnce(
      async (messages: unknown[], _modelRef: unknown, handlers?: Record<string, unknown>) => {
        capturedPromptMessages = messages as unknown[]
        const onToolEnd = handlers?.onToolEnd as
          | ((event: Record<string, unknown>, meta: Record<string, unknown>) => void)
          | undefined

        onToolEnd?.(
          {
            toolCallId: 'call-read-manifest',
            toolName: 'read_file',
            args: { path: 'docs/architecture/xuanpu-agent-task-run/manifest.json' },
            result: { content: [{ type: 'text', text: 'manifest content' }] },
            isError: false,
            startedAt: 1704067202000,
            endedAt: 1704067203000
          },
          { turnId: 'turn-test-1', eventSequence: 1 }
        )

        const beforeYield = mockPiSession.setOnBeforeYield.mock.calls.at(-1)?.[0] as
          | (() => Promise<void>)
          | undefined
        for (let index = 0; index < 5; index++) {
          await beforeYield?.()
        }

        return {
          messageId: 'resp-1',
          text: '任务尚未完成；已读取 manifest，下一步继续补齐。',
          modelRef: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
          usage: { input: 10, output: 5 },
          rawMessage: null,
          harnessMetrics: null,
          turnId: 'turn-test-1'
        }
      }
    )

    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn(),
      createSessionPendingMessage
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, 'long staged audit')

    expect(taskRunRepoMock.closeEpoch).toHaveBeenCalledWith(
      'epoch-test-1',
      expect.objectContaining({
        status: 'closed',
        closeReason: 'turn_end'
      }),
      expect.anything()
    )
    expect(createSessionPendingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'session-1',
        runtime_id: 'xuanpu-agent',
        content: expect.stringContaining('incomplete-response'),
        prompt_options_json: expect.stringContaining('"taskRunId":"task-run-test-1"')
      })
    )
    expect(createSessionPendingMessage.mock.calls[0][0].content).not.toContain(
      'no-progress-recovery'
    )
  })

  it('continues a recovery continuation when it made concrete tool progress', async () => {
    const createSessionPendingMessage = vi.fn()
    mockPiSession.prompt.mockImplementationOnce(
      async (messages: unknown[], _modelRef: unknown, handlers?: Record<string, unknown>) => {
        capturedPromptMessages = messages as unknown[]
        const onToolEnd = handlers?.onToolEnd as
          | ((event: Record<string, unknown>, meta: Record<string, unknown>) => void)
          | undefined
        onToolEnd?.(
          {
            toolCallId: 'call-read-manifest',
            toolName: 'read_file',
            args: { path: 'docs/architecture/xuanpu-agent-task-run/manifest.json' },
            result: { content: [{ type: 'text', text: 'manifest content' }] },
            isError: false,
            startedAt: 1704067202000,
            endedAt: 1704067203000
          },
          { turnId: 'turn-test-1', eventSequence: 1 }
        )

        const beforeYield = mockPiSession.setOnBeforeYield.mock.calls.at(-1)?.[0] as
          | (() => Promise<void>)
          | undefined
        for (let index = 0; index < 5; index++) {
          await beforeYield?.()
        }

        return {
          messageId: 'resp-1',
          text: '已读取 manifest，但仍需继续补全文档。',
          modelRef: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
          usage: { input: 10, output: 5 },
          rawMessage: null,
          harnessMetrics: null,
          turnId: 'turn-test-1'
        }
      }
    )

    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn(),
      createSessionPendingMessage
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt(
      '/repo',
      sessionId,
      [
        '继续当前 xuanpu-agent task run。',
        '<xuanpu-task-run-continuation scope="next-epoch" reason="no-progress-recovery">',
        'Objective: long staged audit',
        '</xuanpu-task-run-continuation>'
      ].join('\n'),
      undefined
    )

    expect(taskRunRepoMock.closeEpoch).toHaveBeenCalledWith(
      'epoch-test-1',
      expect.objectContaining({
        status: 'closed',
        closeReason: 'turn_end'
      }),
      expect.anything()
    )
    expect(taskRunRepoMock.updateTaskRunStatus).not.toHaveBeenCalledWith(
      'task-run-test-1',
      'paused',
      expect.anything(),
      expect.anything()
    )
    expect(createSessionPendingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'session-1',
        runtime_id: 'xuanpu-agent',
        content: expect.stringContaining('incomplete-response'),
        prompt_options_json: expect.stringContaining('task-run-test-1')
      })
    )
  })

  it('pauses only after a no-progress recovery continuation also makes no progress', async () => {
    const createSessionPendingMessage = vi.fn()
    mockPiSession.prompt.mockImplementationOnce(
      async (messages: unknown[], _modelRef: unknown, _handlers?: Record<string, unknown>) => {
        capturedPromptMessages = messages as unknown[]
        const beforeYield = mockPiSession.setOnBeforeYield.mock.calls.at(-1)?.[0] as
          | (() => Promise<void>)
          | undefined
        for (let index = 0; index < 4; index++) {
          await beforeYield?.()
        }

        return {
          messageId: 'resp-1',
          text: '任务尚未完成；本轮没有新的文件读取或写入。',
          modelRef: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
          usage: { input: 10, output: 5 },
          rawMessage: null,
          harnessMetrics: null,
          turnId: 'turn-test-1'
        }
      }
    )

    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn(),
      createSessionPendingMessage
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt(
      '/repo',
      sessionId,
      [
        '继续当前 xuanpu-agent task run。',
        '<xuanpu-task-run-continuation scope="next-epoch" reason="no-progress-recovery">',
        'Objective: long staged audit',
        '</xuanpu-task-run-continuation>'
      ].join('\n'),
      undefined
    )

    expect(taskRunRepoMock.closeEpoch).toHaveBeenCalledWith(
      'epoch-test-1',
      expect.objectContaining({
        status: 'failed',
        closeReason: 'watchdog'
      }),
      expect.anything()
    )
    expect(taskRunRepoMock.updateTaskRunStatus).toHaveBeenCalledWith(
      'task-run-test-1',
      'paused',
      { errorMessage: 'no progress after recovery' },
      expect.anything()
    )
    expect(createSessionPendingMessage).not.toHaveBeenCalled()
    expect(
      taskRunRepoMock.updateTaskRunStatus.mock.calls.some(
        (call) => call[0] === 'task-run-test-1' && call[1] === 'completed'
      )
    ).toBe(false)
  })

  it('completes a long task instead of pausing when no-progress yields contain final completion text', async () => {
    const createSessionPendingMessage = vi.fn()
    mockPiSession.prompt.mockImplementationOnce(
      async (messages: unknown[], _modelRef: unknown, handlers?: Record<string, unknown>) => {
        capturedPromptMessages = messages as unknown[]
        const onTextDelta = handlers?.onTextDelta as
          | ((delta: string, meta: { turnId: string; eventSequence: number }) => void)
          | undefined
        onTextDelta?.('任务已完成，不继续新增工作。', {
          turnId: 'turn-test-1',
          eventSequence: 1
        })

        const beforeYield = mockPiSession.setOnBeforeYield.mock.calls.at(-1)?.[0] as
          | (() => Promise<void>)
          | undefined
        for (let index = 0; index < 5; index++) {
          await beforeYield?.()
        }

        return {
          messageId: 'resp-1',
          text: '任务已完成，不继续新增工作。最终简要汇总：已完成审计。',
          modelRef: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
          usage: { input: 10, output: 5 },
          rawMessage: null,
          harnessMetrics: null,
          turnId: 'turn-test-1'
        }
      }
    )

    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn(),
      createSessionPendingMessage
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, 'long staged audit')

    expect(
      taskRunRepoMock.updateTaskRunStatus.mock.calls.some((call) => call[1] === 'paused')
    ).toBe(false)
    expect(taskRunRepoMock.closeEpoch).toHaveBeenCalledWith(
      'epoch-test-1',
      expect.objectContaining({
        status: 'closed',
        closeReason: 'turn_end'
      }),
      expect.anything()
    )
    expect(
      taskRunRepoMock.updateTaskRunStatus.mock.calls.some(
        (call) => call[0] === 'task-run-test-1' && call[1] === 'completed'
      )
    ).toBe(true)
    expect(createSessionPendingMessage).not.toHaveBeenCalled()
  })

  it('treats abort on an already idle xuanpu-agent session as successful', async () => {
    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await expect(implementer.abort('/repo', sessionId)).resolves.toBe(true)

    const idleEvent = capturedEmittedEvents.find((event) => event.type === 'session.status')
    expect(idleEvent).toMatchObject({
      sessionId: 'session-1',
      data: { status: { type: 'idle' } }
    })
  })
})
