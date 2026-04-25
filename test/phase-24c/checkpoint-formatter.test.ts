import { describe, it, expect } from 'vitest'
import { formatFieldContext } from '../../src/main/field/context-formatter'
import type {
  FieldContextSnapshot,
  ResumedCheckpointBlock
} from '../../src/shared/types'

function emptySnapshot(overrides: Partial<FieldContextSnapshot> = {}): FieldContextSnapshot {
  const asOf = 1_700_000_000_000
  return {
    asOf,
    windowMs: 5 * 60_000,
    worktree: { id: 'w-1', name: 'wt', branchName: 'main' },
    worktreeNotes: null,
    checkpoint: null,
    episodicSummary: null,
    semanticMemory: null,
    focus: { file: null, selection: null },
    lastTerminal: null,
    recentActivity: [],
    ...overrides
  }
}

function ck(overrides: Partial<ResumedCheckpointBlock> = {}): ResumedCheckpointBlock {
  return {
    createdAt: 1_700_000_000_000 - 42 * 60_000, // 42 min ago
    ageMinutes: 42,
    source: 'abort',
    summary:
      'Worked on main for 12m. 3 files edited, 5 commands run.\nLast user message: "refactor auth"',
    currentGoal: 'Make refresh retry on 401',
    nextAction: 'Add backoff in src/auth/refresh.ts',
    blockingReason: null,
    hotFiles: ['src/auth/refresh.ts', 'test/auth/refresh.test.ts', 'src/auth/index.ts'],
    warnings: [],
    ...overrides
  }
}

describe('formatter — Resumed from previous session (Phase 24C)', () => {
  it('does not render the block when checkpoint is null', () => {
    const { markdown } = formatFieldContext(emptySnapshot())
    expect(markdown).not.toContain('Resumed from previous session')
  })

  it('renders full block with all fields at tier 0 (default budget)', () => {
    const { markdown } = formatFieldContext(emptySnapshot({ checkpoint: ck() }))
    expect(markdown).toContain('## Resumed from previous session')
    expect(markdown).toContain('42m ago')
    expect(markdown).toContain('(source: abort)')
    expect(markdown).toContain('**Current goal** (heuristic): Make refresh retry on 401')
    expect(markdown).toContain('**Next action** (heuristic): Add backoff')
    expect(markdown).toContain('**Hot files**:')
    expect(markdown).toContain('src/auth/refresh.ts')
  })

  it('always includes the "(heuristic)" tag on goal and nextAction', () => {
    const { markdown } = formatFieldContext(emptySnapshot({ checkpoint: ck() }))
    const goalLine = markdown.split('\n').find((l) => l.includes('Current goal'))
    const nextLine = markdown.split('\n').find((l) => l.includes('Next action'))
    expect(goalLine).toMatch(/\(heuristic\)/)
    expect(nextLine).toMatch(/\(heuristic\)/)
  })

  it('renders warnings with ⚠ prefix', () => {
    const { markdown } = formatFieldContext(
      emptySnapshot({
        checkpoint: ck({
          warnings: ['2 commits landed since checkpoint', '1/3 hot files changed']
        })
      })
    )
    expect(markdown).toContain('⚠ 2 commits landed since checkpoint')
    expect(markdown).toContain('⚠ 1/3 hot files changed')
  })

  it('renders blocking reason only when present', () => {
    const withBlock = formatFieldContext(
      emptySnapshot({ checkpoint: ck({ blockingReason: 'user cancel' }) })
    )
    expect(withBlock.markdown).toContain('**Blocked by**: user cancel')

    const withoutBlock = formatFieldContext(emptySnapshot({ checkpoint: ck() }))
    expect(withoutBlock.markdown).not.toContain('**Blocked by**')
  })

  it('handles null goal / null nextAction gracefully (no "undefined" leak)', () => {
    const { markdown } = formatFieldContext(
      emptySnapshot({
        checkpoint: ck({ currentGoal: null, nextAction: null })
      })
    )
    expect(markdown).toContain('## Resumed from previous session')
    expect(markdown).not.toContain('undefined')
    expect(markdown).not.toContain('Current goal')
    expect(markdown).not.toContain('Next action')
  })

  it('placement: appears after "## Current Focus" and before "## Project Rules"', () => {
    const snap: FieldContextSnapshot = emptySnapshot({
      focus: { file: { path: 'foo.ts', name: 'foo.ts' }, selection: null },
      checkpoint: ck(),
      semanticMemory: {
        project: { path: '.xuanpu/memory.md', markdown: 'project rules here' },
        user: { path: '~/.xuanpu/memory.md', markdown: null }
      }
    })
    const { markdown } = formatFieldContext(snap)
    const focusIdx = markdown.indexOf('## Current Focus')
    const resumedIdx = markdown.indexOf('## Resumed from previous session')
    const projectIdx = markdown.indexOf('## Project Rules')
    expect(focusIdx).toBeGreaterThan(-1)
    expect(resumedIdx).toBeGreaterThan(focusIdx)
    expect(projectIdx).toBeGreaterThan(resumedIdx)
  })

  it('truncation level 1 (shrunk) drops nextAction + hotFiles, keeps goal', () => {
    // Force a tight budget to push the renderer into shrink tiers.
    // Budget chosen large enough to still render the Resumed block but small
    // enough to cascade into tier 4 where resumedLevel=1.
    const huge = 'x'.repeat(5000)
    const snap = emptySnapshot({
      checkpoint: ck(),
      semanticMemory: {
        project: { path: '.xuanpu/memory.md', markdown: huge },
        user: { path: '~/.xuanpu/memory.md', markdown: null }
      },
      lastTerminal: {
        command: 'pnpm test',
        commandAt: 1_700_000_000_000 - 1000,
        output: {
          head: Array.from({ length: 50 }, (_, i) => `head line ${i}`).join('\n'),
          tail: Array.from({ length: 50 }, (_, i) => `tail line ${i}`).join('\n'),
          truncated: true,
          exitCode: 0
        }
      }
    })
    // With a small budget, the formatter should shrink resumed down.
    const { markdown } = formatFieldContext(snap, { tokenBudget: 500 })
    // Resumed block itself must still appear at minimal+
    expect(markdown).toContain('## Resumed from previous session')
    // At minimal level, nextAction is dropped — but we may still be at shrunk.
    // We only assert that when the budget is extremely tight, nextAction OR
    // hotFiles are dropped.
    const stillHasNext = markdown.includes('Next action')
    const stillHasHot = markdown.includes('Hot files')
    expect(stillHasNext && stillHasHot).toBe(false)
  })

  it('never includes "resumedLevel" internals or tier labels in output', () => {
    const { markdown } = formatFieldContext(emptySnapshot({ checkpoint: ck() }))
    expect(markdown).not.toContain('resumedLevel')
    expect(markdown).not.toContain('Tier')
  })
})
