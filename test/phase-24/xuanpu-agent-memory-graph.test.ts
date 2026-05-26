import { describe, expect, it } from 'vitest'

import { extractMemoryProposalDrafts } from '../../src/main/services/xuanpu-agent/memory/memory-extractor'
import { selectRetrievedMemoryForContext } from '../../src/main/services/xuanpu-agent/memory/memory-retrieval'
import { detectFrequentTraceCandidates } from '../../src/main/services/xuanpu-agent/memory/trace-materialization'
import type { FieldMemoryPageRecord } from '../../src/shared/types/field-memory'

describe('xuanpu-agent M5 memory graph', () => {
  it('extracts conservative ref-backed memory proposals from explicit durable signals', () => {
    const drafts = extractMemoryProposalDrafts({
      scope: 'worktree',
      scopeId: 'worktree-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      sessionId: 'session-1',
      turns: [
        {
          messageId: 'msg-1',
          role: 'user',
          content:
            '记住：这个项目必须使用 pnpm。\n决定采用 src/main/services/xuanpu-agent/runtime.ts 里的 runtime adapter。',
          createdAt: 1000
        }
      ]
    })

    expect(drafts.map((draft) => draft.kind)).toEqual(['constraint', 'decision'])
    expect(drafts[0].rawRefs).toEqual([
      expect.objectContaining({ type: 'session_message', id: 'msg-1' })
    ])
    expect(drafts[1].entities).toEqual(
      expect.arrayContaining([{ type: 'file', value: 'src/main/services/xuanpu-agent/runtime.ts' }])
    )
  })

  it('retrieves accepted memory with explicit retrieval reasons', () => {
    const pages = [
      memoryPage('memory-1', {
        kind: 'constraint',
        title: 'Use pnpm',
        bodyMarkdown: 'This worktree must use pnpm and never npm.',
        entities: [{ type: 'command', value: 'pnpm vitest run test/foo.test.ts' }],
        retrievalHints: ['pnpm', 'constraint']
      }),
      memoryPage('memory-2', {
        kind: 'decision',
        title: 'Runtime adapter path',
        bodyMarkdown: 'The runtime adapter lives in src/main/services/xuanpu-agent/runtime.ts.',
        entities: [{ type: 'file', value: 'src/main/services/xuanpu-agent/runtime.ts' }],
        retrievalHints: ['runtime adapter']
      })
    ]

    const result = selectRetrievedMemoryForContext({
      userText: '继续修 src/main/services/xuanpu-agent/runtime.ts，注意之前的约束',
      pages,
      currentSessionId: 'session-1'
    })

    expect(result.included.map((item) => item.page.id)).toEqual(['memory-2', 'memory-1'])
    expect(result.included.every((item) => item.retrievalReason.length > 0)).toBe(true)
    expect(result.decisions.scores[0].retrievalReason).toContain('path match')
  })

  it('detects high-frequency command traces as materialization candidates', () => {
    const candidates = detectFrequentTraceCandidates([
      trace('trace-1', 'pnpm vitest run test/phase-24/a.test.ts'),
      trace('trace-2', 'pnpm vitest run test/phase-24/b.test.ts'),
      trace('trace-3', 'pnpm vitest run test/phase-24/c.test.ts'),
      trace('trace-4', 'pnpm lint')
    ])

    expect(candidates).toEqual([
      expect.objectContaining({
        occurrenceCount: 3,
        traceIds: ['trace-1', 'trace-2', 'trace-3']
      })
    ])
    expect(candidates[0].signature).toContain('{path}')
  })
})

function memoryPage(id: string, overrides: Partial<FieldMemoryPageRecord>): FieldMemoryPageRecord {
  return {
    id,
    scope: 'worktree',
    scopeId: 'worktree-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    episodeId: null,
    commandTraceId: null,
    kind: 'fact',
    status: 'accepted',
    title: id,
    bodyMarkdown: id,
    entities: [],
    rawRefs: [{ type: 'session_message', id: `${id}-message` }],
    retrievalHints: [],
    source: 'test',
    proposedBy: 'test',
    proposalReason: null,
    createdAt: 1000,
    updatedAt: 1000,
    acceptedAt: 1000,
    rejectedAt: null,
    archivedAt: null,
    ...overrides
  }
}

function trace(id: string, command: string) {
  return {
    id,
    sessionId: 'session-1',
    worktreeId: 'worktree-1',
    command,
    exitCode: 0,
    category: 'test',
    createdAt: 1000
  }
}
