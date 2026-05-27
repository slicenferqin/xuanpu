import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { DatabaseService } from '../../src/main/db/database'

interface AutoFreezeCapable {
  freezeOldConversationTurns(session: unknown): Promise<void>
}

const episodeMocks = vi.hoisted(() => ({
  listFieldEpisodeBlocks: vi.fn(() => []),
  createRuleBasedEpisodeFromTurns: vi.fn(() => ({
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
    const ruleResult = episodeMocks.createRuleBasedEpisodeFromTurns({
      worktreeId: input.worktreeId,
      sessionId: input.sessionId,
      title: input.title,
      turns: input.turns,
      confidence: 'medium'
    })
    return ruleResult
  })
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
  createRuleBasedEpisodeFromTurns: episodeMocks.createRuleBasedEpisodeFromTurns,
  createFieldEpisodeBlock: episodeMocks.createFieldEpisodeBlock
}))

vi.mock('../../src/main/services/xuanpu-agent/context/episode-summarizer', () => ({
  summarizeEpisode: summarizerMocks.summarizeEpisode
}))

vi.mock('../../src/main/services/xuanpu-agent/context/compaction-model', () => ({
  resolveCompactionModel: vi.fn(async () => ({
    kind: 'rule-based',
    source: 'fallback'
  }))
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
    episodeMocks.listFieldEpisodeBlocks.mockReturnValue([])
  })

  it('freezes old visible turns after enough messages accumulate', async () => {
    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'worktree-1' })),
      getSessionMessages: vi.fn(() => makeMessages(10)),
      getSetting: vi.fn(() => null)
    } as unknown as DatabaseService)
    await (implementer as unknown as AutoFreezeCapable).freezeOldConversationTurns({
      sessionId: 'agent-session-1',
      hiveSessionId: 'session-1',
      worktreePath: '/repo',
      status: 'ready',
      abortController: null,
      piSession: null
    })

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
        turns: expect.arrayContaining([
          expect.objectContaining({ messageId: 'm-1' })
        ])
      })
    )
  })

  it('does not freeze when only the recent working set exists', async () => {
    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'worktree-1' })),
      getSessionMessages: vi.fn(() => makeMessages(6)),
      getSetting: vi.fn(() => null)
    } as unknown as DatabaseService)
    await (implementer as unknown as AutoFreezeCapable).freezeOldConversationTurns({
      sessionId: 'agent-session-1',
      hiveSessionId: 'session-1',
      worktreePath: '/repo',
      status: 'ready',
      abortController: null,
      piSession: null
    })

    expect(summarizerMocks.summarizeEpisode).not.toHaveBeenCalled()
  })
})
