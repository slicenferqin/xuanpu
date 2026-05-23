import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../../src/main/db/database'
import type { FieldEpisodeBlockRecord } from '../../src/main/field/episode-block-repository'
import type { FieldContextPackageCreate } from '../../src/main/field/context-package-repository'

interface PackageCapable {
  createContextPackage(
    session: unknown,
    userText: string,
    modelRef: { providerID: string; modelID: string },
    priorMessages: unknown[]
  ): Promise<{
    retrievedEpisodes: FieldEpisodeBlockRecord[]
  } | null>
}

const repositoryMocks = vi.hoisted(() => ({
  listFieldEpisodeBlocks: vi.fn(() => []),
  createFieldContextPackage: vi.fn((data: FieldContextPackageCreate) => ({
    ...data,
    id: 'context-package-1',
    createdAt: 1000,
    renderedMarkdownStored: Boolean(data.renderedMarkdown)
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

vi.mock('../../src/main/field/context-builder', () => ({
  buildFieldContextSnapshot: vi.fn(async () => null)
}))

vi.mock('../../src/main/field/context-formatter', () => ({
  formatFieldContext: vi.fn()
}))

vi.mock('../../src/main/field/context-package-repository', () => ({
  createFieldContextPackage: repositoryMocks.createFieldContextPackage
}))

vi.mock('../../src/main/field/episode-block-repository', () => ({
  listFieldEpisodeBlocks: repositoryMocks.listFieldEpisodeBlocks,
  createRuleBasedEpisodeFromTurns: vi.fn()
}))

function episode(id: string, overrides: Partial<FieldEpisodeBlockRecord>): FieldEpisodeBlockRecord {
  return {
    id,
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    createdAt: 1000,
    kind: 'turns',
    title: id,
    summaryMarkdown: `summary ${id}`,
    keyFacts: [],
    constraints: [],
    files: [],
    commands: [],
    failures: [],
    rawRefs: [{ type: 'session_message', id: `${id}-message` }],
    tokenEstimate: 100,
    confidence: 'medium',
    ...overrides
  }
}

describe('XuanpuAgentImplementer gated retrieval context package', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    repositoryMocks.listFieldEpisodeBlocks.mockReturnValue([])
  })

  it('records available episodes separately from retrieved episodes', async () => {
    repositoryMocks.listFieldEpisodeBlocks.mockReturnValue([
      episode('match', {
        files: ['src/main/services/xuanpu-agent/runtime.ts'],
        tokenEstimate: 120
      }),
      episode('other', {
        files: ['src/main/services/codex-implementer.ts'],
        tokenEstimate: 90
      })
    ])

    const { XuanpuAgentImplementer } =
      await import('../../src/main/services/xuanpu-agent-implementer')
    const implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      getWorktreeByPath: vi.fn(() => ({ id: 'worktree-1' }))
    } as unknown as DatabaseService)

    const result = await (implementer as unknown as PackageCapable).createContextPackage(
      {
        sessionId: 'agent-session-1',
        hiveSessionId: 'session-1',
        worktreePath: '/repo',
        status: 'ready',
        abortController: null,
        piSession: null
      },
      'please inspect src/main/services/xuanpu-agent/runtime.ts',
      { providerID: 'anthropic', modelID: 'claude-haiku-4-5' },
      []
    )

    expect(repositoryMocks.listFieldEpisodeBlocks).toHaveBeenCalledWith({
      worktreeId: 'worktree-1',
      limit: 25
    })
    expect(result?.retrievedEpisodes.map((item) => item.id)).toEqual(['match'])

    const created = repositoryMocks.createFieldContextPackage.mock.calls[0]?.[0]
    expect(created?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'frozen-episodes-available',
          kind: 'frozen_episodes',
          included: false,
          metadata: expect.objectContaining({ count: 2 })
        }),
        expect.objectContaining({
          id: 'retrieved-episodes',
          kind: 'retrieved_episodes',
          included: true,
          approxTokens: 120,
          metadata: expect.objectContaining({
            ids: ['match'],
            triggers: expect.arrayContaining(['file_path'])
          })
        })
      ])
    )
    expect(created?.decisions).toMatchObject({
      frozenEpisodeCandidateCount: 2,
      retrievedEpisodeCount: 1,
      retrievedEpisodeTokens: 120,
      episodeRetrieval: {
        policy: 'deterministic-gated-episode-retrieval',
        includedIds: ['match']
      }
    })
  })
})
