import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockCompleteSimple = vi.fn()

vi.mock('../../src/main/services/xuanpu-agent/pi-agent-core-loader', () => ({
  loadPiAiModule: async () => ({
    completeSimple: mockCompleteSimple
  })
}))

vi.mock('../../src/main/field/episode-block-repository', () => ({
  buildRuleBasedEpisodeFromTurns: vi.fn((input) => ({
    worktreeId: input.worktreeId,
    sessionId: input.sessionId ?? null,
    kind: 'turns',
    title: input.title ?? 'Conversation Episode',
    summaryMarkdown: 'rule-based summary',
    keyFacts: [],
    constraints: [],
    files: [],
    commands: [],
    failures: [],
    rawRefs: input.turns.map((t) => ({ type: 'session_message', id: t.messageId, role: t.role })),
    confidence: 'medium'
  }))
}))

import { summarizeEpisode } from '../../src/main/services/xuanpu-agent/context/episode-summarizer'
import { buildRuleBasedEpisodeFromTurns } from '../../src/main/field/episode-block-repository'

const MODEL_RESOLUTION = {
  kind: 'model' as const,
  source: 'provider-default' as const,
  modelRef: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' },
  model: { id: 'test-model' }
}

const RULE_RESOLUTION = {
  kind: 'rule-based' as const,
  source: 'fallback' as const
}

const TURNS = [
  { messageId: 'msg-1', role: 'user' as const, content: 'Fix the auth bug', createdAt: 1000 },
  { messageId: 'msg-2', role: 'assistant' as const, content: 'I found the issue in auth.ts', createdAt: 2000 },
  { messageId: 'msg-3', role: 'user' as const, content: 'Run the tests', createdAt: 3000 },
  { messageId: 'msg-4', role: 'assistant' as const, content: 'All tests passed', createdAt: 4000 }
]

describe('summarizeEpisode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('falls back to rule-based when resolution is rule-based', async () => {
    const result = await summarizeEpisode({
      worktreeId: 'w-1',
      sessionId: 's-1',
      turns: TURNS,
      resolution: RULE_RESOLUTION
    })

    expect(result.summaryMarkdown).toBe('rule-based summary')
    expect(buildRuleBasedEpisodeFromTurns).toHaveBeenCalled()
    expect(mockCompleteSimple).not.toHaveBeenCalled()
    // Provenance metadata
    expect(result.metadata).toMatchObject({
      compactorKind: 'rule-based',
      fallbackReason: 'no-model-configured'
    })
  })

  it('calls completeSimple with model resolution', async () => {
    mockCompleteSimple.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            summary: 'Fixed auth bug and ran tests successfully',
            keyFacts: ['Bug was in auth.ts'],
            constraints: [],
            files: ['auth.ts'],
            commands: ['pnpm test'],
            failures: []
          })
        }
      ]
    })

    const result = await summarizeEpisode({
      worktreeId: 'w-1',
      sessionId: 's-1',
      turns: TURNS,
      resolution: MODEL_RESOLUTION
    })

    expect(mockCompleteSimple).toHaveBeenCalled()
    expect(result.summaryMarkdown).toContain('Fixed auth bug')
    expect(result.keyFacts).toContain('Bug was in auth.ts')
    expect(result.files).toContain('auth.ts')
    expect(result.confidence).toBe('high')
    // Provenance metadata for model success
    expect(result.metadata).toMatchObject({
      compactorKind: 'model',
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5',
      promptVersion: 'v1'
    })
  })

  it('falls back to rule-based when model returns unparseable output', async () => {
    mockCompleteSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'This is not JSON' }]
    })

    const result = await summarizeEpisode({
      worktreeId: 'w-1',
      sessionId: 's-1',
      turns: TURNS,
      resolution: MODEL_RESOLUTION
    })

    expect(result.summaryMarkdown).toBe('rule-based summary')
    // Provenance metadata for unparseable fallback
    expect(result.metadata).toMatchObject({
      compactorKind: 'rule-based',
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5',
      fallbackReason: 'model-output-unparseable'
    })
  })

  it('falls back to rule-based when model throws', async () => {
    mockCompleteSimple.mockRejectedValue(new Error('API error'))

    const result = await summarizeEpisode({
      worktreeId: 'w-1',
      sessionId: 's-1',
      turns: TURNS,
      resolution: MODEL_RESOLUTION
    })

    expect(result.summaryMarkdown).toBe('rule-based summary')
    // Provenance metadata for error fallback
    expect(result.metadata).toMatchObject({
      compactorKind: 'rule-based',
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5',
      fallbackReason: 'model-call-error'
    })
  })

  it('parses JSON from markdown code fence', async () => {
    mockCompleteSimple.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: '```json\n' + JSON.stringify({
            summary: 'Test summary',
            keyFacts: ['fact 1'],
            constraints: ['constraint 1'],
            files: ['test.ts'],
            commands: ['npm test'],
            failures: ['error 1']
          }) + '\n```'
        }
      ]
    })

    const result = await summarizeEpisode({
      worktreeId: 'w-1',
      turns: TURNS,
      resolution: MODEL_RESOLUTION
    })

    expect(result.summaryMarkdown).toContain('Test summary')
    expect(result.constraints).toContain('constraint 1')
    expect(result.failures).toContain('error 1')
  })

  it('sets rawRefs from input turns', async () => {
    mockCompleteSimple.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ summary: 'Summary', keyFacts: [], constraints: [], files: [], commands: [], failures: [] })
        }
      ]
    })

    const result = await summarizeEpisode({
      worktreeId: 'w-1',
      turns: TURNS,
      resolution: MODEL_RESOLUTION
    })

    expect(result.rawRefs).toHaveLength(4)
    expect(result.rawRefs[0]).toEqual({
      type: 'session_message',
      id: 'msg-1',
      role: 'user',
      at: 1000
    })
  })

  it('sets sourceMessageIdStart and sourceMessageIdEnd from turns', async () => {
    mockCompleteSimple.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ summary: 'S', keyFacts: [], constraints: [], files: [], commands: [], failures: [] })
        }
      ]
    })

    const result = await summarizeEpisode({
      worktreeId: 'w-1',
      turns: TURNS,
      resolution: MODEL_RESOLUTION
    })

    expect(result.sourceMessageIdStart).toBe('msg-1')
    expect(result.sourceMessageIdEnd).toBe('msg-4')
  })
})
