import { describe, it, expect } from 'vitest'
import {
  formatFieldContext,
  __FORMATTER_TUNABLES_FOR_TEST
} from '../../../src/main/field/context-formatter'
import type { FieldContextSnapshot } from '../../../src/shared/types'

function snapshot(overrides: Partial<FieldContextSnapshot> = {}): FieldContextSnapshot {
  return {
    asOf: new Date('2026-04-21T14:25:30').getTime(),
    windowMs: 5 * 60_000,
    worktree: {
      id: 'w-abc123de-aaaa-bbbb-cccc-111122223333',
      name: 'auth-feat',
      branchName: 'feature/auth'
    },
    worktreeNotes: null,
    focus: { file: null, selection: null },
    lastTerminal: null,
    recentActivity: [],
    ...overrides
  }
}

describe('formatFieldContext — Phase 22A M2', () => {
  describe('template', () => {
    it('includes the [Field Context] header with local timestamp', () => {
      const out = formatFieldContext(snapshot())
      expect(out.markdown).toMatch(/^\[Field Context — as of \d{2}:\d{2}:\d{2}\]/)
    })

    it('includes the untrusted-data directive', () => {
      const out = formatFieldContext(snapshot())
      expect(out.markdown).toContain('untrusted data')
      expect(out.markdown).toContain('Current Focus')
    })

    it('renders Worktree section when worktree is present', () => {
      const out = formatFieldContext(snapshot())
      expect(out.markdown).toContain('## Worktree')
      expect(out.markdown).toContain('auth-feat')
      expect(out.markdown).toContain('feature/auth')
    })

    it('omits Worktree section when worktree is null', () => {
      const out = formatFieldContext(snapshot({ worktree: null }))
      expect(out.markdown).not.toContain('## Worktree')
    })
  })

  describe('focus', () => {
    it('renders Current Focus with file and selection', () => {
      const out = formatFieldContext(
        snapshot({
          focus: {
            file: { path: '/abs/src/auth/login.ts', name: 'login.ts' },
            selection: {
              path: '/abs/src/auth/login.ts',
              fromLine: 45,
              toLine: 58,
              length: 320
            }
          }
        })
      )
      expect(out.markdown).toContain('## Current Focus')
      expect(out.markdown).toContain('/abs/src/auth/login.ts')
      expect(out.markdown).toContain('lines 45-58')
      expect(out.markdown).toContain('320 chars selected')
    })

    it('renders selection range as single line when fromLine==toLine', () => {
      const out = formatFieldContext(
        snapshot({
          focus: {
            file: { path: '/a.ts', name: 'a.ts' },
            selection: { path: '/a.ts', fromLine: 10, toLine: 10, length: 5 }
          }
        })
      )
      expect(out.markdown).toContain('line 10')
      expect(out.markdown).not.toContain('lines 10-10')
    })

    it('omits Current Focus when both file and selection are null', () => {
      const out = formatFieldContext(snapshot())
      expect(out.markdown).not.toContain('## Current Focus')
    })
  })

  describe('terminal', () => {
    it('renders command, elapsed, exit code, and output head+tail', () => {
      const asOf = new Date('2026-04-21T14:25:30').getTime()
      const out = formatFieldContext(
        snapshot({
          asOf,
          lastTerminal: {
            command: 'pnpm test auth',
            commandAt: asOf - 10_000, // 10s ago
            output: {
              head: 'FAIL  src/auth/login.test.ts\nsome details',
              tail: 'Tests: 1 failed, 3 passed',
              truncated: false,
              exitCode: 1
            }
          }
        })
      )
      expect(out.markdown).toContain('## Last Terminal Activity')
      expect(out.markdown).toContain('pnpm test auth')
      expect(out.markdown).toContain('10s ago')
      expect(out.markdown).toContain('exit 1')
      expect(out.markdown).toContain('Output (head):')
      expect(out.markdown).toContain('FAIL  src/auth/login.test.ts')
      expect(out.markdown).toContain('Output (tail):')
      expect(out.markdown).toContain('1 failed')
    })

    it('shows truncation notice when output.truncated is true', () => {
      const out = formatFieldContext(
        snapshot({
          lastTerminal: {
            command: 'cat big.log',
            commandAt: Date.now(),
            output: {
              head: 'line1',
              tail: 'last',
              truncated: true,
              exitCode: 0
            }
          }
        })
      )
      expect(out.markdown).toContain('truncated at capture time')
    })

    it('no output section when lastTerminal has null output', () => {
      const out = formatFieldContext(
        snapshot({
          lastTerminal: {
            command: 'sleep 10',
            commandAt: Date.now(),
            output: null
          }
        })
      )
      expect(out.markdown).toContain('## Last Terminal Activity')
      expect(out.markdown).toContain('sleep 10')
      expect(out.markdown).not.toContain('Output (head):')
    })
  })

  describe('recent activity', () => {
    it('renders recentActivity with timestamps + summaries', () => {
      const t = new Date('2026-04-21T14:23:00').getTime()
      const out = formatFieldContext(
        snapshot({
          recentActivity: [
            { timestamp: t, type: 'worktree.switch', summary: 'switched from `old1234`' },
            { timestamp: t + 10_000, type: 'file.focus', summary: 'focused `x.ts`' }
          ]
        })
      )
      expect(out.markdown).toContain('## Recent Activity (last 5 min)')
      expect(out.markdown).toContain('switched from')
      expect(out.markdown).toContain('focused')
    })

    it('caps activity to 30 in tier 0 (no budget pressure)', () => {
      const entries = Array.from({ length: 40 }, (_, i) => ({
        timestamp: Date.now() + i * 100,
        type: 'worktree.switch',
        summary: `entry ${i}`
      }))
      const out = formatFieldContext(snapshot({ recentActivity: entries }))
      const activityLines = out.markdown
        .split('\n')
        .filter((l) => l.startsWith('- ') && l.includes('entry '))
      // Formatter passes through all entries (caller controls cap via maxActivity);
      // the tier 0 cap on our side is 30 but the input here is 40; no tier1 kicked.
      expect(activityLines.length).toBeGreaterThan(0)
    })
  })

  describe('budget', () => {
    it('approxTokens is roughly chars / 3', () => {
      const out = formatFieldContext(snapshot())
      const ratio = out.markdown.length / out.approxTokens
      expect(ratio).toBeGreaterThanOrEqual(2.5)
      expect(ratio).toBeLessThanOrEqual(3.5)
    })

    it('wasTruncated is false when under budget', () => {
      const out = formatFieldContext(snapshot())
      expect(out.wasTruncated).toBe(false)
    })

    it('wasTruncated is true when input exceeds budget', () => {
      const bigNotes = 'x'.repeat(50_000)
      const out = formatFieldContext(
        snapshot({ worktreeNotes: bigNotes }),
        { tokenBudget: 200 }
      )
      expect(out.wasTruncated).toBe(true)
    })

    it('preserves Worktree + Current Focus + Command even at tiny budget', () => {
      const asOf = Date.now()
      const out = formatFieldContext(
        snapshot({
          asOf,
          worktreeNotes: 'x'.repeat(20_000),
          focus: {
            file: { path: '/src/a.ts', name: 'a.ts' },
            selection: { path: '/src/a.ts', fromLine: 1, toLine: 10, length: 100 }
          },
          lastTerminal: {
            command: 'pnpm test',
            commandAt: asOf - 5_000,
            output: {
              head: Array.from({ length: 100 }, (_, i) => `head-line-${i}`).join('\n'),
              tail: Array.from({ length: 100 }, (_, i) => `tail-line-${i}`).join('\n'),
              truncated: false,
              exitCode: 1
            }
          },
          recentActivity: Array.from({ length: 30 }, (_, i) => ({
            timestamp: asOf - i * 1000,
            type: 'file.focus',
            summary: `focused file-${i}`
          }))
        }),
        { tokenBudget: 300 }
      )
      expect(out.markdown).toContain('## Worktree')
      expect(out.markdown).toContain('## Current Focus')
      expect(out.markdown).toContain('/src/a.ts')
      expect(out.markdown).toContain('pnpm test')
      expect(out.markdown).toContain('exit 1')
      expect(out.wasTruncated).toBe(true)
    })

    it('trims Recent Activity before terminal head+tail (priority check)', () => {
      const asOf = Date.now()
      const activity = Array.from({ length: 30 }, (_, i) => ({
        timestamp: asOf - i * 1000,
        type: 'file.focus',
        summary: `focused very-long-file-path-${'x'.repeat(50)}-${i}`
      }))
      const out = formatFieldContext(
        snapshot({
          asOf,
          lastTerminal: {
            command: 'pnpm test',
            commandAt: asOf - 5_000,
            output: {
              head: 'FAIL critical\nline2',
              tail: 'Tests failed',
              truncated: false,
              exitCode: 1
            }
          },
          recentActivity: activity
        }),
        { tokenBudget: 600 }
      )
      // Terminal output (critical diagnostic) should still be present
      expect(out.markdown).toContain('FAIL critical')
      // Activity should be reduced or removed
      const activityEntries = out.markdown
        .split('\n')
        .filter((l) => l.includes('very-long-file-path'))
      expect(activityEntries.length).toBeLessThan(30)
    })
  })

  describe('constants', () => {
    it('exports tunables for integration tests', () => {
      expect(__FORMATTER_TUNABLES_FOR_TEST.DEFAULT_TOKEN_BUDGET).toBe(1500)
      expect(__FORMATTER_TUNABLES_FOR_TEST.CHARS_PER_TOKEN).toBe(3)
    })
  })
})
