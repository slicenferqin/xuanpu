import { describe, expect, it, vi } from 'vitest'
import {
  buildXfpFallbackContext,
  detectXfpFallbackReason
} from '../../src/main/xfp/fallback-context'
import type { XfpProvider } from '../../src/main/xfp/types'

function createProvider(): XfpProvider {
  return {
    getCurrentFocus: vi.fn().mockResolvedValue({
      disabled: false,
      asOf: 1,
      worktree: {
        id: 'wt-1',
        name: 'xuanpu',
        branchName: 'chore_20260518_infra',
        path: '/repo'
      },
      file: { path: '/repo/src/main.ts', name: 'main.ts' },
      selection: { path: '/repo/src/main.ts', fromLine: 10, toLine: 12, length: 80 }
    }),
    getLastTerminalActivity: vi.fn().mockResolvedValue({
      command: 'pnpm test',
      commandAt: 1,
      exitCode: 1,
      output: { tail: 'FAIL src/main.ts', truncated: false }
    }),
    getRecentActivity: vi.fn().mockResolvedValue([]),
    getWorktreeSummary: vi.fn().mockResolvedValue({
      markdown: 'Last task: migrate Claude to XFP.',
      compactedAt: 1,
      source: 'episodic',
      warnings: []
    }),
    getPinnedFacts: vi.fn().mockResolvedValue(null)
  }
}

describe('XFP fallback context', () => {
  it('detects high-confidence field references but ignores slash commands', () => {
    expect(detectXfpFallbackReason('这里为什么挂？')).toBe('field-reference')
    expect(detectXfpFallbackReason('continue')).toBe('resume')
    expect(detectXfpFallbackReason('/compact')).toBeNull()
    expect(detectXfpFallbackReason('implement the plan')).toBeNull()
  })

  it('builds a bounded focus and terminal fallback for field-sensitive prompts', async () => {
    const provider = createProvider()

    const fallback = await buildXfpFallbackContext({
      provider,
      scope: { worktreeId: 'wt-1', sessionId: 's-1' },
      promptText: '这里为什么挂？'
    })

    expect(fallback).toMatchObject({
      reason: 'field-reference',
      included: ['current_focus', 'last_terminal_activity']
    })
    expect(fallback?.markdown).toContain('[Xuanpu Field Fallback]')
    expect(fallback?.markdown).toContain('/repo/src/main.ts')
    expect(fallback?.markdown).toContain('pnpm test')
    expect(fallback?.markdown).toContain('FAIL src/main.ts')
    expect(fallback?.markdown).not.toContain('Recent Activity')
    expect(provider.getWorktreeSummary).not.toHaveBeenCalled()
  })

  it('includes compact worktree summary only for resume prompts', async () => {
    const provider = createProvider()

    const fallback = await buildXfpFallbackContext({
      provider,
      scope: { worktreeId: 'wt-1', sessionId: 's-1' },
      promptText: '继续'
    })

    expect(fallback?.reason).toBe('resume')
    expect(fallback?.included).toEqual([
      'current_focus',
      'last_terminal_activity',
      'worktree_summary'
    ])
    expect(fallback?.markdown).toContain('Last task: migrate Claude to XFP.')
    expect(provider.getWorktreeSummary).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      sessionId: 's-1'
    })
  })

  it('returns null when no fallback data is available', async () => {
    const provider = createProvider()
    vi.mocked(provider.getCurrentFocus).mockResolvedValue({
      disabled: true,
      asOf: null,
      worktree: null,
      file: null,
      selection: null
    })
    vi.mocked(provider.getLastTerminalActivity).mockResolvedValue(null)
    vi.mocked(provider.getWorktreeSummary).mockResolvedValue(null)

    await expect(
      buildXfpFallbackContext({
        provider,
        scope: { worktreeId: 'wt-1' },
        promptText: '继续'
      })
    ).resolves.toBeNull()
  })
})
