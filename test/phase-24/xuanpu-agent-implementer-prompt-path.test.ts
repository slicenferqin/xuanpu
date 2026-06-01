import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { DatabaseService } from '../../src/main/db/database'

// ── Mocks ──

const packContextMock = vi.hoisted(() => vi.fn())
const emitAgentEventMock = vi.hoisted(() => vi.fn())
const capturedEmittedEvents = vi.hoisted(() => [] as Array<{ type: string; sessionId: string; data: unknown }>)
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
  recordBudgetSections: vi.fn(),
  configureCompression: vi.fn(),
  abort: vi.fn(),
  setPlanModeTools: vi.fn(),
  setBuildModeTools: vi.fn(),
  prompt: vi.fn(async (messages: unknown[]) => {
    capturedPromptMessages = messages as unknown[]
    return {
      messageId: 'resp-1',
      text: 'mock response',
      modelRef: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
      usage: { inputTokens: 100, outputTokens: 50 },
      rawMessage: null,
      harnessMetrics: null
    }
  }),
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

describe('XuanpuAgentImplementer prompt path uses Context Packer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedPromptMessages = []
    capturedEmittedEvents.length = 0
    capturedUsageEntries.length = 0
    capturedActivities.length = 0
    packContextMock.mockReturnValue({
      providerContextMessages: [
        {
          role: 'user',
          content: [{ type: 'text', text: '<xuanpu-context-anchor>packed anchor</xuanpu-context-anchor>' }],
          timestamp: 1
        }
      ],
      providerPromptMessage: {
        role: 'user',
        content: [{ type: 'text', text: 'current request' }],
        timestamp: 2
      },
      includedRetrievedEpisodes: [],
      decisions: {
        contextTransform: 'm7-context-packer',
        zones: {
          retrievedEpisodes: { tokens: 0, count: 0, dropped: 0, reasons: [], includedIds: [] },
          workingSet: { tokens: 50, count: 2, dedupedCount: 0, includedMessageIds: ['msg-1', 'msg-2'], droppedMessageIds: [] }
        },
        totalTokens: 100,
        fillRatio: 0.01,
        prefixHash: 'abc123'
      }
    })
  })

  it('calls packContext with XFP packet anchor, episodes, working set, and current request', async () => {
    const { XuanpuAgentImplementer } = await import(
      '../../src/main/services/xuanpu-agent-implementer'
    )
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn((entry: Record<string, unknown>) => { capturedUsageEntries.push(entry) }),
      upsertSessionActivity: vi.fn((activity: Record<string, unknown>) => { capturedActivities.push(activity) })
    } as unknown as DatabaseService)

    const { listFieldEpisodeBlocks } = await import(
      '../../src/main/field/episode-block-repository'
    )
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

    // Verify packContext was called
    expect(packContextMock).toHaveBeenCalled()
    const packInput = packContextMock.mock.calls[0][0]

    // Verify anchor contains XFP packet
    expect(packInput.anchor).toContain('<xuanpu-xfp-packet')
    expect(packInput.anchor).toContain('test-packet')

    // Verify working set has prior turns (after freeze re-read)
    expect(packInput.workingSet).toBeDefined()
    expect(packInput.workingSet.length).toBe(3)
    expect(packInput.workingSet[0].messageId).toBe('msg-1')

    // Verify frozen episodes are passed
    expect(packInput.frozenEpisodes).toBeDefined()
    expect(packInput.frozenEpisodes.length).toBe(1)
    expect(packInput.frozenEpisodes[0].id).toBe('ep-1')

    // Verify current request
    expect(packInput.currentRequest).toBe('fix the bug')

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
  })

  it('re-reads prior turns after freeze (not using stale data)', async () => {
    const { XuanpuAgentImplementer } = await import(
      '../../src/main/services/xuanpu-agent-implementer'
    )
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null)
    } as unknown as DatabaseService)

    // First call returns 10 turns, second call (after freeze) returns 8
    mockFieldProvider.getPriorTurns
      .mockReturnValueOnce([
        ...Array.from({ length: 10 }, (_, i) => ({
          messageId: `msg-${i}`,
          role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
          content: `turn ${i}`,
          createdAt: i * 1000
        }))
      ])
      .mockReturnValueOnce([
        ...Array.from({ length: 8 }, (_, i) => ({
          messageId: `msg-${i}`,
          role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
          content: `turn ${i}`,
          createdAt: i * 1000
        }))
      ])

    const { sessionId } = await implementer.connect('/repo', 'session-1')
    await implementer.prompt('/repo', sessionId, 'continue')

    // packContext should receive the re-read turns (8), not the stale ones (10)
    const packInput = packContextMock.mock.calls[0][0]
    expect(packInput.workingSet.length).toBe(8)

    // getPriorTurns should be called twice: once before freeze, once after
    expect(mockFieldProvider.getPriorTurns).toHaveBeenCalledTimes(2)
  })

  it('prefixSeed is stable across turns despite different packetId and capturedAt', async () => {
    // Make compiler return different packetId/capturedAt on each call
    let compileCallCount = 0
    const { XfpPacketCompiler } = await import(
      '../../src/main/services/xuanpu-agent/harness/compiler'
    )
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

    const { XuanpuAgentImplementer } = await import(
      '../../src/main/services/xuanpu-agent-implementer'
    )
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null)
    } as unknown as DatabaseService)

    const { sessionId } = await implementer.connect('/repo', 'session-1')

    // First turn
    await implementer.prompt('/repo', sessionId, 'first request')
    const firstPrefixSeed = packContextMock.mock.calls[0][0].prefixSeed

    // Second turn — different packetId and capturedAt
    await implementer.prompt('/repo', sessionId, 'second request')
    const secondPrefixSeed = packContextMock.mock.calls[1][0].prefixSeed

    // prefixSeed must be identical despite different packetId/capturedAt
    expect(firstPrefixSeed).toBe(secondPrefixSeed)
    // prefixSeed must NOT contain the packetId
    expect(firstPrefixSeed).not.toContain('test-packet-')
    // prefixSeed should still contain version
    expect(firstPrefixSeed).toContain('version="1.0"')
  })

  it('emits session.context_usage after prompt with packer breakdown', async () => {
    const { XuanpuAgentImplementer } = await import(
      '../../src/main/services/xuanpu-agent-implementer'
    )
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
    const { XuanpuAgentImplementer } = await import(
      '../../src/main/services/xuanpu-agent-implementer'
    )
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn((entry: Record<string, unknown>) => { capturedUsageEntries.push(entry) })
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

    const { XuanpuAgentImplementer } = await import(
      '../../src/main/services/xuanpu-agent-implementer'
    )
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'w-1', projectId: 'p-1' })),
      getSetting: vi.fn(() => null),
      getSession: vi.fn(() => ({ id: 's-1', project_id: 'p-1', worktree_id: 'w-1' })),
      upsertUsageEntry: vi.fn(),
      upsertSessionActivity: vi.fn((activity: Record<string, unknown>) => { capturedActivities.push(activity) })
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
    const { XuanpuAgentImplementer } = await import(
      '../../src/main/services/xuanpu-agent-implementer'
    )
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
})
