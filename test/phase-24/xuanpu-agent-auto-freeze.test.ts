import { describe, expect, it, vi, beforeEach } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import type { DatabaseService } from '../../src/main/db/database'

const episodeMocks = vi.hoisted(() => ({
  listFieldEpisodeBlocks: vi.fn(() => []),
  buildRuleBasedEpisodeFromTurns: vi.fn(() => ({
    id: 'episode-new',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    createdAt: 1,
    kind: 'turns',
    title: 'Frozen Conversation Turns',
    summaryMarkdown: 'summary',
    keyFacts: [],
    constraints: [],
    files: [],
    commands: [],
    failures: [],
    rawRefs: [],
    tokenEstimate: 1,
    confidence: 'medium',
    metadata: {}
  })),
  createFieldEpisodeBlock: vi.fn((data) => ({ ...data, id: 'episode-new', createdAt: Date.now() }))
}))

const summarizerMocks = vi.hoisted(() => ({
  summarizeEpisode: vi.fn(async (input) => {
    // Delegate to rule-based mock for assertion compatibility
    const ruleResult = episodeMocks.buildRuleBasedEpisodeFromTurns({
      worktreeId: input.worktreeId,
      sessionId: input.sessionId,
      title: input.title,
      turns: input.turns,
      confidence: 'medium'
    })
    return ruleResult
  })
}))

const compactionModelMocks = vi.hoisted(() => ({
  resolveCompactionModel: vi.fn(async () => ({
    kind: 'rule-based',
    source: 'fallback'
  }))
}))

vi.mock('electron', () => ({
  app: undefined
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('../../src/main/field/episode-block-repository', () => ({
  listFieldEpisodeBlocks: episodeMocks.listFieldEpisodeBlocks,
  buildRuleBasedEpisodeFromTurns: episodeMocks.buildRuleBasedEpisodeFromTurns,
  createFieldEpisodeBlock: episodeMocks.createFieldEpisodeBlock
}))

vi.mock('../../src/main/services/xuanpu-agent/context/episode-summarizer', () => ({
  summarizeEpisode: summarizerMocks.summarizeEpisode
}))

vi.mock('../../src/main/services/xuanpu-agent/context/compaction-model', () => ({
  resolveCompactionModel: compactionModelMocks.resolveCompactionModel
}))

function makeMessages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `db-${index + 1}`,
    session_id: 'session-1',
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index + 1}`,
    opencode_message_id: `m-${index + 1}`,
    opencode_message_json: null,
    opencode_parts_json: null,
    opencode_timeline_json: null,
    created_at: new Date(index).toISOString()
  }))
}

describe('XuanpuAgentImplementer automatic episode freezing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    episodeMocks.listFieldEpisodeBlocks.mockReturnValue([])
    compactionModelMocks.resolveCompactionModel.mockResolvedValue({
      kind: 'rule-based',
      source: 'fallback'
    })
  })

  it('freezes old visible turns after enough messages accumulate', async () => {
    const { IdeFieldProvider } =
      await import('../../src/main/services/xuanpu-agent/field/ide-field-provider')
    const provider = new IdeFieldProvider({
      getSessionMessages: vi.fn(() => makeMessages(10)),
      getSetting: vi.fn(() => null)
    } as unknown as DatabaseService)
    ;(
      provider as unknown as { resolveCompactionResolution: () => Promise<unknown> }
    ).resolveCompactionResolution = vi.fn(async () => ({
      kind: 'rule-based',
      source: 'fallback'
    }))
    await provider.freezeEpisodes('worktree-1', 'session-1')

    expect(episodeMocks.listFieldEpisodeBlocks).toHaveBeenCalledWith({
      worktreeId: 'worktree-1',
      sessionId: 'session-1',
      limit: 200
    })
    expect(summarizerMocks.summarizeEpisode).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'worktree-1',
        sessionId: 'session-1',
        title: 'Frozen Conversation Turns',
        turns: expect.arrayContaining([expect.objectContaining({ messageId: 'm-1' })])
      })
    )
  })

  it('does not freeze when only the recent working set exists', async () => {
    const { IdeFieldProvider } =
      await import('../../src/main/services/xuanpu-agent/field/ide-field-provider')
    const provider = new IdeFieldProvider({
      getSessionMessages: vi.fn(() => makeMessages(6)),
      getSetting: vi.fn(() => null)
    } as unknown as DatabaseService)
    ;(
      provider as unknown as { resolveCompactionResolution: () => Promise<unknown> }
    ).resolveCompactionResolution = vi.fn(async () => ({
      kind: 'rule-based',
      source: 'fallback'
    }))
    await provider.freezeEpisodes('worktree-1', 'session-1')

    expect(summarizerMocks.summarizeEpisode).not.toHaveBeenCalled()
  })

  it('archives OpenAI remote compact preserveData when compaction model supports it', async () => {
    compactionModelMocks.resolveCompactionModel.mockResolvedValue({
      kind: 'model',
      source: 'provider-default',
      modelRef: { providerID: 'openai', modelID: 'gpt-test' },
      model: { id: 'gpt-test', provider: 'openai', baseUrl: 'https://api.test/v1' },
      resolvedApiKey: 'test-key'
    })
    let capturedBody: { input?: unknown[] } | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body))
        return new Response(
          JSON.stringify({
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }]
              },
              { type: 'compaction', encrypted_content: 'secret-provider-state' }
            ]
          }),
          { status: 200, statusText: 'OK' }
        )
      })
    )

    const { IdeFieldProvider } =
      await import('../../src/main/services/xuanpu-agent/field/ide-field-provider')
    const provider = new IdeFieldProvider({
      getSessionMessages: vi.fn(() => makeMessages(10)),
      getSetting: vi.fn(() => null)
    } as unknown as DatabaseService)
    ;(
      provider as unknown as { resolveCompactionResolution: () => Promise<unknown> }
    ).resolveCompactionResolution = vi.fn(async () => ({
      kind: 'model',
      source: 'provider-default',
      modelRef: { providerID: 'openai', modelID: 'gpt-test' },
      model: { id: 'gpt-test', provider: 'openai', baseUrl: 'https://api.test/v1' },
      resolvedApiKey: 'test-key'
    }))
    await provider.freezeEpisodes('worktree-1', 'session-1')

    expect(capturedBody?.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'message 1' }] },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'message 2', annotations: [] }],
        status: 'completed',
        id: 'm-2'
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'message 3' }] },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'message 4', annotations: [] }],
        status: 'completed',
        id: 'm-4'
      }
    ])
    const created = episodeMocks.createFieldEpisodeBlock.mock.calls.at(-1)?.[0]
    const providerNative = created?.metadata?.segmentCompaction?.providerNative
    expect(providerNative).toMatchObject({
      provider: 'openai',
      firstKeptEntryId: 'm-5',
      replacementHistoryCount: 2,
      compactionItemType: 'compaction',
      replayable: true
    })
    expect(JSON.stringify(created?.metadata)).not.toContain('secret-provider-state')
    expect(providerNative.preserveDataPath).toBeTruthy()
    expect(existsSync(providerNative.preserveDataPath)).toBe(true)
    expect(readFileSync(providerNative.preserveDataPath, 'utf-8')).toContain(
      'secret-provider-state'
    )
    rmSync(providerNative.preserveDataPath, { force: true })
  })
})
