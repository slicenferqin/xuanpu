import { describe, it, expect } from 'vitest'
import {
  RuleBasedCompactor,
  InsufficientEventsError,
  __COMPACTOR_TUNABLES_FOR_TEST
} from '../../../src/main/field/episodic-compactor'
import type { StoredFieldEvent } from '../../../src/main/field/repository'
import type { FieldEventType } from '../../../src/shared/types'

function e(overrides: Partial<StoredFieldEvent>): StoredFieldEvent {
  return {
    seq: overrides.seq ?? Math.floor(Math.random() * 1_000_000),
    id: overrides.id ?? crypto.randomUUID(),
    timestamp: overrides.timestamp ?? Date.now(),
    worktreeId: overrides.worktreeId ?? 'w-1',
    projectId: overrides.projectId ?? 'p-1',
    sessionId: overrides.sessionId ?? null,
    relatedEventId: overrides.relatedEventId ?? null,
    type: (overrides.type as FieldEventType) ?? 'worktree.switch',
    payload:
      overrides.payload ?? { fromWorktreeId: null, toWorktreeId: 'w-1', trigger: 'user-click' }
  } as StoredFieldEvent
}

function input(events: StoredFieldEvent[], since = 0, until = Date.now() + 60_000) {
  return {
    worktreeId: 'w-1',
    worktreeName: 'auth-feat',
    branchName: 'feature/auth',
    events,
    since,
    until
  }
}

describe('RuleBasedCompactor — Phase 22B.1 M2', () => {
  const compactor = new RuleBasedCompactor()

  describe('identity', () => {
    it('declares id "rule-based" and version 1', () => {
      expect(compactor.id).toBe('rule-based')
      expect(compactor.version).toBe(1)
    })
  })

  describe('minimum events guard', () => {
    it('throws InsufficientEventsError when events.length < 5', async () => {
      const events = Array.from({ length: 4 }, (_, i) =>
        e({ id: `x-${i}`, timestamp: i * 1000 })
      )
      await expect(compactor.compact(input(events))).rejects.toBeInstanceOf(
        InsufficientEventsError
      )
    })

    it('compacts successfully with exactly 5 events', async () => {
      const events = Array.from({ length: 5 }, (_, i) =>
        e({ id: `x-${i}`, timestamp: i * 1000 })
      )
      const out = await compactor.compact(input(events))
      expect(out.compactorId).toBe('rule-based')
      expect(out.version).toBe(1)
      expect(out.markdown).toContain('## Observed Recent Work')
    })
  })

  describe('Observed Recent Work section', () => {
    it('renders time buckets with counts (commands/files/prompts/switches)', async () => {
      const t = 1_700_000_000_000 // stable anchor
      const events: StoredFieldEvent[] = []
      // Bucket 1: 3 commands
      for (let i = 0; i < 3; i++) {
        events.push(
          e({
            id: `c-${i}`,
            timestamp: t + i * 10_000,
            type: 'terminal.command',
            payload: { command: 'ls' }
          })
        )
      }
      // Bucket 2 (15 min later): 2 file touches
      for (let i = 0; i < 2; i++) {
        events.push(
          e({
            id: `f-${i}`,
            timestamp: t + 16 * 60_000 + i * 10_000,
            type: 'file.focus',
            payload: { path: '/a.ts', name: 'a.ts', fromPath: null }
          })
        )
      }
      const out = await compactor.compact(input(events, t - 60_000))
      expect(out.markdown).toMatch(/ran 3 commands/)
      expect(out.markdown).toMatch(/touched 2 file events/)
    })

    it('skips empty buckets', async () => {
      const t = 1_700_000_000_000
      const events = [
        e({ id: 'a', timestamp: t, type: 'terminal.command', payload: { command: 'ls' } }),
        // 2-hour gap
        e({
          id: 'b',
          timestamp: t + 2 * 3600_000,
          type: 'terminal.command',
          payload: { command: 'pwd' }
        }),
        ...Array.from({ length: 3 }, (_, i) =>
          e({
            id: `c-${i}`,
            timestamp: t + 2 * 3600_000 + (i + 1) * 1000,
            type: 'file.focus',
            payload: { path: '/a.ts', name: 'a.ts', fromPath: null }
          })
        )
      ]
      const out = await compactor.compact(input(events, t - 60_000))
      // Should render ~2 active buckets, not dozens of empty ones in between
      const bucketLines = out.markdown
        .split('\n')
        .filter((l) => l.startsWith('- ') && /\d{2}:\d{2}–\d{2}:\d{2}/.test(l))
      expect(bucketLines.length).toBeLessThanOrEqual(4)
    })

    it('uses singular for count of 1', async () => {
      const t = 1_700_000_000_000
      const events = [
        e({ id: 'c', timestamp: t, type: 'terminal.command', payload: { command: 'ls' } }),
        e({
          id: 'f',
          timestamp: t + 1000,
          type: 'file.focus',
          payload: { path: '/a.ts', name: 'a.ts', fromPath: null }
        }),
        e({
          id: 'p',
          timestamp: t + 2000,
          type: 'session.message',
          payload: {
            agentSdk: 'claude-code',
            agentSessionId: 's-1',
            text: 'hi',
            attachmentCount: 0
          }
        }),
        e({
          id: 's',
          timestamp: t + 3000,
          type: 'worktree.switch',
          payload: { fromWorktreeId: 'old', toWorktreeId: 'w-1', trigger: 'user-click' }
        }),
        e({
          id: 'x',
          timestamp: t + 4000,
          type: 'worktree.switch',
          payload: { fromWorktreeId: 'old2', toWorktreeId: 'w-1', trigger: 'user-click' }
        })
      ]
      const out = await compactor.compact(input(events, t - 60_000))
      // "1 command" not "1 commands" (but we have 2 switches so we check singular on command)
      expect(out.markdown).toMatch(/ran 1 command\b/)
      expect(out.markdown).toMatch(/touched 1 file event\b/)
      expect(out.markdown).toMatch(/sent 1 prompt\b/)
    })
  })

  describe('Most-Touched Files section', () => {
    it('ranks by file event count, top 3 only', async () => {
      const t = 1_700_000_000_000
      const events: StoredFieldEvent[] = []
      // a.ts: 5 events
      for (let i = 0; i < 5; i++) {
        events.push(
          e({
            id: `a-${i}`,
            timestamp: t + i * 1000,
            type: 'file.focus',
            payload: { path: '/src/a.ts', name: 'a.ts', fromPath: null }
          })
        )
      }
      // b.ts: 3 events
      for (let i = 0; i < 3; i++) {
        events.push(
          e({
            id: `b-${i}`,
            timestamp: t + 10_000 + i * 1000,
            type: 'file.focus',
            payload: { path: '/src/b.ts', name: 'b.ts', fromPath: null }
          })
        )
      }
      // c.ts: 2 events
      for (let i = 0; i < 2; i++) {
        events.push(
          e({
            id: `c-${i}`,
            timestamp: t + 20_000 + i * 1000,
            type: 'file.open',
            payload: { path: '/src/c.ts', name: 'c.ts' }
          })
        )
      }
      // d.ts: 1 event (should NOT appear in top 3)
      events.push(
        e({
          id: 'd',
          timestamp: t + 30_000,
          type: 'file.open',
          payload: { path: '/src/d.ts', name: 'd.ts' }
        })
      )
      const out = await compactor.compact(input(events, t - 60_000))
      expect(out.markdown).toContain('## Most-Touched Files')
      expect(out.markdown).toContain('a.ts')
      expect(out.markdown).toContain('b.ts')
      expect(out.markdown).toContain('c.ts')
      expect(out.markdown).not.toContain('d.ts')
      // Should be in descending order
      const aIdx = out.markdown.indexOf('a.ts')
      const bIdx = out.markdown.indexOf('b.ts')
      expect(aIdx).toBeLessThan(bIdx)
    })

    it('is omitted when there are no file events', async () => {
      const t = 1_700_000_000_000
      const events = Array.from({ length: 5 }, (_, i) =>
        e({
          id: `c-${i}`,
          timestamp: t + i * 1000,
          type: 'terminal.command',
          payload: { command: 'ls' }
        })
      )
      const out = await compactor.compact(input(events, t - 60_000))
      expect(out.markdown).not.toContain('## Most-Touched Files')
    })
  })

  describe('Recent Failures / Signals section', () => {
    it('lists terminal.output events with non-zero exit codes', async () => {
      const t = 1_700_000_000_000
      const events = [
        e({
          id: 'c1',
          timestamp: t,
          type: 'terminal.command',
          payload: { command: 'pnpm test auth' }
        }),
        e({
          id: 'o1',
          timestamp: t + 5000,
          type: 'terminal.output',
          relatedEventId: 'c1',
          payload: {
            commandEventId: 'c1',
            head: 'FAIL',
            tail: '',
            truncated: false,
            totalBytes: 5,
            exitCode: 1,
            reason: 'exit'
          }
        }),
        e({
          id: 'c2',
          timestamp: t + 10_000,
          type: 'terminal.command',
          payload: { command: 'ls' }
        }),
        e({
          id: 'o2',
          timestamp: t + 11_000,
          type: 'terminal.output',
          relatedEventId: 'c2',
          payload: {
            commandEventId: 'c2',
            head: '',
            tail: '',
            truncated: false,
            totalBytes: 0,
            exitCode: 0, // success -> should NOT appear
            reason: 'exit'
          }
        }),
        // Extra event to meet min threshold
        e({ id: 'e5', timestamp: t + 20_000 })
      ]
      const out = await compactor.compact(input(events, t - 60_000))
      expect(out.markdown).toContain('## Recent Failures / Signals')
      expect(out.markdown).toContain('pnpm test auth')
      expect(out.markdown).toContain('exited with code 1')
      expect(out.markdown).not.toContain('exited with code 0')
    })

    it('omits the section when there are no failures', async () => {
      const t = 1_700_000_000_000
      const events = Array.from({ length: 5 }, (_, i) =>
        e({
          id: `c-${i}`,
          timestamp: t + i * 1000,
          type: 'terminal.command',
          payload: { command: 'ls' }
        })
      )
      const out = await compactor.compact(input(events, t - 60_000))
      expect(out.markdown).not.toContain('## Recent Failures')
    })

    it('shows "(unknown command)" when relatedEventId is missing', async () => {
      const t = 1_700_000_000_000
      const events: StoredFieldEvent[] = [
        e({
          id: 'o',
          timestamp: t,
          type: 'terminal.output',
          relatedEventId: null,
          payload: {
            commandEventId: null,
            head: 'error',
            tail: '',
            truncated: false,
            totalBytes: 5,
            exitCode: 2,
            reason: 'exit'
          }
        }),
        ...Array.from({ length: 4 }, (_, i) =>
          e({
            id: `filler-${i}`,
            timestamp: t + (i + 1) * 1000,
            type: 'file.focus',
            payload: { path: '/a.ts', name: 'a.ts', fromPath: null }
          })
        )
      ]
      const out = await compactor.compact(input(events, t - 60_000))
      expect(out.markdown).toContain('(unknown command)')
      expect(out.markdown).toContain('exited with code 2')
    })
  })

  describe('provenance (no inference)', () => {
    it('NEVER includes "Current Focus" section (that is 22A working memory territory)', async () => {
      const t = 1_700_000_000_000
      const events = Array.from({ length: 10 }, (_, i) =>
        e({
          id: `f-${i}`,
          timestamp: t + i * 1000,
          type: 'file.focus',
          payload: { path: '/a.ts', name: 'a.ts', fromPath: null }
        })
      )
      const out = await compactor.compact(input(events, t - 60_000))
      expect(out.markdown).not.toContain('Current Focus')
    })

    it('NEVER includes "Open Problems" section (rule-based cannot do this well)', async () => {
      const t = 1_700_000_000_000
      const events = [
        e({
          id: 'sel',
          timestamp: t,
          type: 'file.selection',
          payload: { path: '/a.ts', fromLine: 45, toLine: 58, length: 320 }
        }),
        e({
          id: 'cmd',
          timestamp: t + 5000,
          type: 'terminal.command',
          payload: { command: 'pnpm test' }
        }),
        e({
          id: 'out',
          timestamp: t + 10_000,
          type: 'terminal.output',
          relatedEventId: 'cmd',
          payload: {
            commandEventId: 'cmd',
            head: 'FAIL',
            tail: '',
            truncated: false,
            totalBytes: 5,
            exitCode: 1,
            reason: 'exit'
          }
        }),
        e({ id: 'e4', timestamp: t + 15_000 }),
        e({ id: 'e5', timestamp: t + 16_000 })
      ]
      const out = await compactor.compact(input(events, t - 60_000))
      expect(out.markdown).not.toContain('Open Problems')
      expect(out.markdown).not.toContain('heuristic')
    })

    it('does NOT synthesize cross-event inferences like "selection followed by test failure"', async () => {
      const t = 1_700_000_000_000
      const events = [
        e({
          id: 'sel',
          timestamp: t,
          type: 'file.selection',
          payload: { path: '/a.ts', fromLine: 45, toLine: 58, length: 320 }
        }),
        e({
          id: 'cmd',
          timestamp: t + 5000,
          type: 'terminal.command',
          payload: { command: 'pnpm test' }
        }),
        e({
          id: 'out',
          timestamp: t + 10_000,
          type: 'terminal.output',
          relatedEventId: 'cmd',
          payload: {
            commandEventId: 'cmd',
            head: 'FAIL',
            tail: '',
            truncated: false,
            totalBytes: 5,
            exitCode: 1,
            reason: 'exit'
          }
        }),
        e({ id: 'e4', timestamp: t + 15_000 }),
        e({ id: 'e5', timestamp: t + 16_000 })
      ]
      const out = await compactor.compact(input(events, t - 60_000))
      // No phrasings like "selection followed by", "after selecting", "related to"
      expect(out.markdown).not.toMatch(/followed by|after selecting|related to/i)
    })
  })

  describe('char budget', () => {
    it('output length stays under MAX_CHARS even with many events', async () => {
      const t = 1_700_000_000_000
      const events: StoredFieldEvent[] = []
      // 1000 events spread over 10 hours
      for (let i = 0; i < 1000; i++) {
        events.push(
          e({
            id: `f-${i}`,
            timestamp: t + i * 30_000,
            type: 'file.focus',
            payload: {
              path: `/very/long/path/to/file-${i % 50}.ts`,
              name: `file-${i % 50}.ts`,
              fromPath: null
            }
          })
        )
      }
      const out = await compactor.compact(input(events, t - 60_000))
      expect(out.markdown.length).toBeLessThanOrEqual(
        __COMPACTOR_TUNABLES_FOR_TEST.MAX_CHARS
      )
    })
  })
})
