import { describe, it, expect, vi } from 'vitest'
import { join } from 'path'

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('electron', () => ({
  app: undefined
}))

vi.mock('@shared/app-identity', () => ({
  getActiveAppDatabasePath: (home: string) => join(home, '.xuanpu', 'test.db'),
  APP_BUNDLE_ID: 'test',
  APP_CLI_NAME: 'test',
  APP_PRODUCT_NAME: 'test'
}))

import {
  createXfpProvider,
  XFP_DEFAULT_RECENT_WINDOW_MS,
  XFP_MAX_RECENT_LIMIT,
  XFP_TERMINAL_MAX_CHARS
} from '../../src/main/xfp/provider'
import type { FieldContextSnapshot } from '../../src/shared/types'

type TestBuildOptions = {
  worktreeId: string
  windowMs?: number
  maxActivity?: number
}

type TestBuildSnapshot = (opts: TestBuildOptions) => Promise<FieldContextSnapshot | null>

function snapshot(overrides: Partial<FieldContextSnapshot> = {}): FieldContextSnapshot {
  return {
    asOf: 1_800_000_000_000,
    windowMs: XFP_DEFAULT_RECENT_WINDOW_MS,
    worktree: {
      id: 'w-1',
      name: 'akita',
      branchName: 'feat/xfp'
    },
    worktreeNotes: null,
    pinnedFacts: null,
    checkpoint: null,
    episodicSummary: null,
    semanticMemory: null,
    focus: {
      file: null,
      selection: null
    },
    lastTerminal: null,
    recentActivity: [],
    ...overrides
  }
}

function providerFor(
  value: FieldContextSnapshot | null,
  worktreePath: string | null = '/tmp/worktrees/akita'
) {
  const buildSnapshot = vi.fn<TestBuildSnapshot>(async () => value)
  const provider = createXfpProvider({
    buildSnapshot,
    getWorktreePath: () => worktreePath
  })

  return { provider, buildSnapshot }
}

describe('XfpProvider - Phase 2 provider core', () => {
  it('returns structured current focus without rendering markdown', async () => {
    const { provider, buildSnapshot } = providerFor(
      snapshot({
        focus: {
          file: { path: '/repo/src/main/xfp/provider.ts', name: 'provider.ts' },
          selection: {
            path: '/repo/src/main/xfp/provider.ts',
            fromLine: 10,
            toLine: 18,
            length: 220
          }
        }
      })
    )

    const focus = await provider.getCurrentFocus({ worktreeId: 'w-1' })

    expect(buildSnapshot).toHaveBeenCalledWith({ worktreeId: 'w-1' })
    expect(focus).toEqual({
      disabled: false,
      asOf: 1_800_000_000_000,
      worktree: {
        id: 'w-1',
        name: 'akita',
        branchName: 'feat/xfp',
        path: '/tmp/worktrees/akita'
      },
      file: { path: '/repo/src/main/xfp/provider.ts', name: 'provider.ts' },
      selection: {
        path: '/repo/src/main/xfp/provider.ts',
        fromLine: 10,
        toLine: 18,
        length: 220
      }
    })
  })

  it('defaults terminal output to bounded tail', async () => {
    const { provider } = providerFor(
      snapshot({
        lastTerminal: {
          command: 'pnpm vitest run test/xfp/provider.test.ts',
          commandAt: 1_800_000_000_123,
          output: {
            head: 'first line\nsecond line',
            tail: '0123456789abcdef',
            truncated: false,
            exitCode: 1
          }
        }
      })
    )

    const activity = await provider.getLastTerminalActivity({
      worktreeId: 'w-1',
      maxChars: 6
    })

    expect(activity).toEqual({
      command: 'pnpm vitest run test/xfp/provider.test.ts',
      commandAt: 1_800_000_000_123,
      exitCode: 1,
      output: {
        tail: 'abcdef',
        truncated: true
      }
    })
  })

  it('can suppress terminal output while preserving command metadata', async () => {
    const { provider } = providerFor(
      snapshot({
        lastTerminal: {
          command: 'pnpm lint',
          commandAt: 1_800_000_000_123,
          output: {
            head: 'lint output',
            tail: '',
            truncated: false,
            exitCode: 0
          }
        }
      })
    )

    const activity = await provider.getLastTerminalActivity({
      worktreeId: 'w-1',
      includeOutput: 'none'
    })

    expect(activity).toEqual({
      command: 'pnpm lint',
      commandAt: 1_800_000_000_123,
      exitCode: 0
    })
  })

  it('bounds head_tail terminal output across both segments', async () => {
    const { provider } = providerFor(
      snapshot({
        lastTerminal: {
          command: 'cat split.log',
          commandAt: 1_800_000_000_123,
          output: {
            head: 'abcdef',
            tail: 'uvwxyz',
            truncated: true,
            exitCode: 0
          }
        }
      })
    )

    const activity = await provider.getLastTerminalActivity({
      worktreeId: 'w-1',
      includeOutput: 'head_tail',
      maxChars: 1
    })

    expect(activity?.output).toEqual({
      head: 'a',
      truncated: true
    })
  })

  it('caps terminal maxChars at the provider upper bound', async () => {
    const longTail = 'x'.repeat(XFP_TERMINAL_MAX_CHARS + 128)
    const { provider } = providerFor(
      snapshot({
        lastTerminal: {
          command: 'cat huge.log',
          commandAt: 1_800_000_000_123,
          output: {
            head: '',
            tail: longTail,
            truncated: false,
            exitCode: 0
          }
        }
      })
    )

    const activity = await provider.getLastTerminalActivity({
      worktreeId: 'w-1',
      maxChars: XFP_TERMINAL_MAX_CHARS + 10_000
    })

    expect(activity?.output?.tail).toHaveLength(XFP_TERMINAL_MAX_CHARS)
    expect(activity?.output?.truncated).toBe(true)
  })

  it('returns recent activity with the XFP default limit of 10', async () => {
    const recentActivity = Array.from({ length: 12 }, (_, i) => ({
      timestamp: 1_800_000_000_000 + i,
      type: 'worktree.switch',
      summary: `switched from \`old-${i}\``
    }))
    const { provider, buildSnapshot } = providerFor(snapshot({ recentActivity }))

    const activity = await provider.getRecentActivity({ worktreeId: 'w-1' })

    expect(buildSnapshot).toHaveBeenCalledWith({
      worktreeId: 'w-1',
      windowMs: XFP_DEFAULT_RECENT_WINDOW_MS,
      maxActivity: 10
    })
    expect(activity).toHaveLength(10)
    expect(activity[0].summary).toBe('switched from `old-2`')
    expect(activity.at(-1)?.summary).toBe('switched from `old-11`')
  })

  it('uses a wider builder read when recent activity is type-filtered', async () => {
    const recentActivity = [
      { timestamp: 1, type: 'worktree.switch', summary: 'switched worktree' },
      { timestamp: 2, type: 'agent.file_search', summary: 'searched provider' },
      { timestamp: 3, type: 'agent.file_write', summary: 'edited provider' }
    ]
    const { provider, buildSnapshot } = providerFor(snapshot({ recentActivity }))

    const activity = await provider.getRecentActivity({
      worktreeId: 'w-1',
      types: ['agent.file_search'],
      limit: 5
    })

    expect(buildSnapshot).toHaveBeenCalledWith({
      worktreeId: 'w-1',
      windowMs: XFP_DEFAULT_RECENT_WINDOW_MS,
      maxActivity: XFP_MAX_RECENT_LIMIT
    })
    expect(activity).toEqual([
      { timestamp: 2, type: 'agent.file_search', summary: 'searched provider' }
    ])
  })

  it('returns checkpoint and episodic worktree summary with warnings', async () => {
    const { provider } = providerFor(
      snapshot({
        checkpoint: {
          createdAt: 1_800_000_000_100,
          ageMinutes: 2,
          source: 'abort',
          summary: 'Previous run stopped during provider wiring.',
          currentGoal: 'Expose scoped XFP provider methods',
          nextAction: 'Run targeted provider tests',
          blockingReason: null,
          hotFiles: ['src/main/xfp/provider.ts'],
          warnings: ['checkpoint hot file drift was tolerated']
        },
        episodicSummary: {
          markdown: '## Observed Recent Work\n- Implemented field context builder.',
          compactorId: 'rule-based',
          compactedAt: 1_800_000_000_200,
          sourceEventCount: 7
        }
      })
    )

    const summary = await provider.getWorktreeSummary({ worktreeId: 'w-1' })

    expect(summary).toEqual({
      markdown:
        '## Resumed Work State\n' +
        'Previous run stopped during provider wiring.\n' +
        '- Current goal (heuristic): Expose scoped XFP provider methods\n' +
        '- Next action (heuristic): Run targeted provider tests\n' +
        '- Hot files: src/main/xfp/provider.ts\n\n' +
        '## Observed Recent Work\n' +
        '- Implemented field context builder.',
      compactedAt: 1_800_000_000_200,
      source: 'checkpoint+episodic',
      warnings: ['checkpoint hot file drift was tolerated']
    })
  })

  it('returns only user-authored pinned facts from the builder snapshot', async () => {
    const { provider } = providerFor(
      snapshot({
        pinnedFacts: {
          contentMd: '- API base is local-only.\n- Do not use npm.',
          updatedAt: 1_800_000_000_500
        },
        semanticMemory: {
          project: { path: '/project/memory.md', markdown: '- generated context' },
          user: { path: '/user/memory.md', markdown: '- user memory file' }
        }
      })
    )

    const facts = await provider.getPinnedFacts({ worktreeId: 'w-1' })

    expect(facts).toEqual({
      markdown: '- API base is local-only.\n- Do not use npm.',
      updatedAt: 1_800_000_000_500
    })
  })

  it('uses disabled or empty results when the snapshot builder returns null', async () => {
    const { provider } = providerFor(null)

    await expect(provider.getCurrentFocus({ worktreeId: 'w-1' })).resolves.toEqual({
      disabled: true,
      asOf: null,
      worktree: null,
      file: null,
      selection: null
    })
    await expect(provider.getLastTerminalActivity({ worktreeId: 'w-1' })).resolves.toBeNull()
    await expect(provider.getRecentActivity({ worktreeId: 'w-1' })).resolves.toEqual([])
    await expect(provider.getWorktreeSummary({ worktreeId: 'w-1' })).resolves.toBeNull()
    await expect(provider.getPinnedFacts({ worktreeId: 'w-1' })).resolves.toBeNull()
  })
})
