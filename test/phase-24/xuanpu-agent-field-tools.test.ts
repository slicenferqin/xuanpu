import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock DB and field modules before importing field-tools
const mockGetWorktreeByPath = vi.fn()
const mockGetRecentFieldEvents = vi.fn()
const mockGetPinnedFacts = vi.fn()
const mockFlushNow = vi.fn(async () => {})
const mockGetEpisodicMemory = vi.fn()
const mockRecordXfpAuditEvent = vi.fn()

vi.mock('../../src/main/db', () => ({
  getDatabase: () => ({
    getWorktreeByPath: mockGetWorktreeByPath,
    getEpisodicMemory: mockGetEpisodicMemory
  })
}))

vi.mock('../../src/main/field/sink', () => ({
  getFieldEventSink: () => ({ flushNow: mockFlushNow })
}))

vi.mock('../../src/main/field/repository', () => ({
  getRecentFieldEvents: mockGetRecentFieldEvents
}))

vi.mock('../../src/main/field/pinned-facts-repository', () => ({
  getPinnedFacts: mockGetPinnedFacts
}))

vi.mock('../../src/main/xfp/audit', () => ({
  recordXfpAuditEvent: (...args: unknown[]) => mockRecordXfpAuditEvent(...args),
  summarizeXfpAuditOutput: (value: unknown) => ({
    outputSummary: typeof value === 'string' ? value : JSON.stringify(value),
    outputChars: typeof value === 'string' ? value.length : 100,
    truncated: false
  }),
  inferXfpAuditPrivacy: () => 'allowed',
  hasXfpTruncatedOutput: () => false
}))

import {
  xfpGetCurrentFocusTool,
  xfpGetLastTerminalTool,
  xfpGetRecentActivityTool,
  xfpGetWorktreeSummaryTool,
  xfpGetPinnedFactsTool
} from '../../src/main/services/xuanpu-agent/tools/field-tools'

const ABORT = new AbortController().signal

describe('xuanpu-agent field tools — failure paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetWorktreeByPath.mockReturnValue(null)
    mockGetRecentFieldEvents.mockReturnValue([])
    mockGetPinnedFacts.mockReturnValue(null)
    mockGetEpisodicMemory.mockReturnValue(null)
  })

  describe('resolveWorktreePath', () => {
    it('xfp_get_current_focus throws when context has no worktreePath', async () => {
      await expect(
        xfpGetCurrentFocusTool.execute('call-1', {}, ABORT, () => {}, undefined)
      ).rejects.toThrow('xfp_* tools require a worktreePath in the tool context')
    })

    it('xfp_get_last_terminal_activity throws when context is empty object', async () => {
      await expect(
        xfpGetLastTerminalTool.execute('call-1', {}, ABORT, () => {}, {})
      ).rejects.toThrow('xfp_* tools require a worktreePath in the tool context')
    })

    it('xfp_get_recent_activity throws when context is undefined', async () => {
      await expect(
        xfpGetRecentActivityTool.execute('call-1', {}, ABORT, () => {}, undefined)
      ).rejects.toThrow('xfp_* tools require a worktreePath in the tool context')
    })

    it('xfp_get_worktree_summary throws when context has no worktreePath', async () => {
      await expect(
        xfpGetWorktreeSummaryTool.execute('call-1', {}, ABORT, () => {}, { sessionId: 's-1' })
      ).rejects.toThrow('xfp_* tools require a worktreePath in the tool context')
    })

    it('xfp_get_pinned_facts throws when context is undefined', async () => {
      await expect(
        xfpGetPinnedFactsTool.execute('call-1', {}, ABORT, () => {}, undefined)
      ).rejects.toThrow('xfp_* tools require a worktreePath in the tool context')
    })
  })

  describe('worktree not found', () => {
    const CTX = { worktreePath: '/repo', sessionId: 's-1' }

    it('xfp_get_current_focus returns "No worktree found" when DB returns null', async () => {
      mockGetWorktreeByPath.mockReturnValue(null)
      const result = await xfpGetCurrentFocusTool.execute('call-1', {}, ABORT, () => {}, CTX)
      expect(result.isError).toBeFalsy()
      const text = result.content.map((p: { text?: string }) => p.text).join('')
      expect(text).toContain('No worktree found')
    })

    it('xfp_get_last_terminal_activity returns "No worktree found" when DB returns null', async () => {
      mockGetWorktreeByPath.mockReturnValue(null)
      const result = await xfpGetLastTerminalTool.execute('call-1', {}, ABORT, () => {}, CTX)
      const text = result.content.map((p: { text?: string }) => p.text).join('')
      expect(text).toContain('No worktree found')
    })

    it('xfp_get_recent_activity returns "No worktree found" when DB returns null', async () => {
      mockGetWorktreeByPath.mockReturnValue(null)
      const result = await xfpGetRecentActivityTool.execute('call-1', {}, ABORT, () => {}, CTX)
      const text = result.content.map((p: { text?: string }) => p.text).join('')
      expect(text).toContain('No worktree found')
    })

    it('xfp_get_worktree_summary returns "No worktree found" when DB returns null', async () => {
      mockGetWorktreeByPath.mockReturnValue(null)
      const result = await xfpGetWorktreeSummaryTool.execute('call-1', {}, ABORT, () => {}, CTX)
      const text = result.content.map((p: { text?: string }) => p.text).join('')
      expect(text).toContain('No worktree found')
    })

    it('xfp_get_pinned_facts returns "No worktree found" when DB returns null', async () => {
      mockGetWorktreeByPath.mockReturnValue(null)
      const result = await xfpGetPinnedFactsTool.execute('call-1', {}, ABORT, () => {}, CTX)
      const text = result.content.map((p: { text?: string }) => p.text).join('')
      expect(text).toContain('No worktree found')
    })
  })

  describe('event payload guards', () => {
    const CTX = { worktreePath: '/repo', sessionId: 's-1' }
    const WORKTREE = { id: 'w-1', name: 'test', path: '/repo' }

    it('xfp_get_current_focus skips events with null payload without crashing', async () => {
      mockGetWorktreeByPath.mockReturnValue(WORKTREE)
      mockGetRecentFieldEvents.mockReturnValue([
        { type: 'file.open', payload: null, timestamp: Date.now(), id: 'e1' },
        { type: 'file.focus', payload: { path: '/repo/src/main.ts' }, timestamp: Date.now(), id: 'e2' }
      ])
      const result = await xfpGetCurrentFocusTool.execute('call-1', {}, ABORT, () => {}, CTX)
      const text = result.content.map((p: { text?: string }) => p.text).join('')
      expect(text).toContain('src/main.ts')
      expect(text).not.toContain('Error')
    })

    it('xfp_get_current_focus skips events with string payload without crashing', async () => {
      mockGetWorktreeByPath.mockReturnValue(WORKTREE)
      mockGetRecentFieldEvents.mockReturnValue([
        { type: 'file.open', payload: 'invalid', timestamp: Date.now(), id: 'e1' }
      ])
      const result = await xfpGetCurrentFocusTool.execute('call-1', {}, ABORT, () => {}, CTX)
      const text = result.content.map((p: { text?: string }) => p.text).join('')
      expect(text).toContain('None (no recent file focus detected)')
    })

    it('xfp_get_recent_activity skips events with null payload gracefully', async () => {
      mockGetWorktreeByPath.mockReturnValue(WORKTREE)
      mockGetRecentFieldEvents.mockReturnValue([
        { type: 'file.open', payload: null, timestamp: Date.now(), id: 'e1' },
        { type: 'terminal.command', payload: { command: 'pnpm test' }, timestamp: Date.now(), id: 'e2' }
      ])
      const result = await xfpGetRecentActivityTool.execute('call-1', { limit: 10 }, ABORT, () => {}, CTX)
      const text = result.content.map((p: { text?: string }) => p.text).join('')
      expect(text).toContain('pnpm test')
    })

    it('xfp_get_last_terminal_activity skips events with malformed payload', async () => {
      mockGetWorktreeByPath.mockReturnValue(WORKTREE)
      mockGetRecentFieldEvents.mockReturnValue([
        { type: 'terminal.command', payload: { notCommand: true }, timestamp: Date.now(), id: 'e1' },
        { type: 'terminal.command', payload: { command: 'git status' }, timestamp: Date.now(), id: 'e2' }
      ])
      const result = await xfpGetLastTerminalTool.execute('call-1', {}, ABORT, () => {}, CTX)
      const text = result.content.map((p: { text?: string }) => p.text).join('')
      expect(text).toContain('git status')
    })
  })

  describe('flush error resilience', () => {
    const CTX = { worktreePath: '/repo', sessionId: 's-1' }
    const WORKTREE = { id: 'w-1', name: 'test', path: '/repo' }

    it('xfp_get_current_focus continues when flushNow rejects', async () => {
      mockGetWorktreeByPath.mockReturnValue(WORKTREE)
      mockFlushNow.mockRejectedValueOnce(new Error('flush failed'))
      mockGetRecentFieldEvents.mockReturnValue([])
      const result = await xfpGetCurrentFocusTool.execute('call-1', {}, ABORT, () => {}, CTX)
      const text = result.content.map((p: { text?: string }) => p.text).join('')
      expect(text).toContain('Current Focus')
      expect(text).not.toContain('Error')
    })

    it('xfp_get_last_terminal_activity continues when flushNow rejects', async () => {
      mockGetWorktreeByPath.mockReturnValue(WORKTREE)
      mockFlushNow.mockRejectedValueOnce(new Error('flush failed'))
      mockGetRecentFieldEvents.mockReturnValue([])
      const result = await xfpGetLastTerminalTool.execute('call-1', {}, ABORT, () => {}, CTX)
      const text = result.content.map((p: { text?: string }) => p.text).join('')
      expect(text).toContain('Last Terminal Activity')
    })
  })

  describe('audit path', () => {
    const CTX = { worktreePath: '/repo', sessionId: 's-1' }
    const WORKTREE = { id: 'w-1', name: 'test', path: '/repo' }

    it('xfp_get_current_focus records audit event on success', async () => {
      mockGetWorktreeByPath.mockReturnValue(WORKTREE)
      mockGetRecentFieldEvents.mockReturnValue([])
      await xfpGetCurrentFocusTool.execute('call-1', {}, ABORT, () => {}, CTX)
      expect(mockRecordXfpAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId: 'w-1',
          sessionId: 's-1',
          runtimeId: 'xuanpu-agent',
          kind: 'tool',
          toolName: 'xfp_get_current_focus'
        })
      )
    })

    it('xfp_get_last_terminal_activity records audit event on success', async () => {
      mockGetWorktreeByPath.mockReturnValue(WORKTREE)
      mockGetRecentFieldEvents.mockReturnValue([])
      await xfpGetLastTerminalTool.execute('call-1', {}, ABORT, () => {}, CTX)
      expect(mockRecordXfpAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId: 'w-1',
          sessionId: 's-1',
          runtimeId: 'xuanpu-agent',
          kind: 'tool',
          toolName: 'xfp_get_last_terminal_activity'
        })
      )
    })

    it('xfp_get_recent_activity records audit event with input params', async () => {
      mockGetWorktreeByPath.mockReturnValue(WORKTREE)
      mockGetRecentFieldEvents.mockReturnValue([])
      await xfpGetRecentActivityTool.execute('call-1', { limit: 5 }, ABORT, () => {}, CTX)
      expect(mockRecordXfpAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId: 'w-1',
          sessionId: 's-1',
          runtimeId: 'xuanpu-agent',
          kind: 'tool',
          toolName: 'xfp_get_recent_activity',
          input: { limit: 5 }
        })
      )
    })

    it('xfp_get_worktree_summary records audit event on success', async () => {
      mockGetWorktreeByPath.mockReturnValue(WORKTREE)
      await xfpGetWorktreeSummaryTool.execute('call-1', {}, ABORT, () => {}, CTX)
      expect(mockRecordXfpAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId: 'w-1',
          sessionId: 's-1',
          runtimeId: 'xuanpu-agent',
          kind: 'tool',
          toolName: 'xfp_get_worktree_summary'
        })
      )
    })

    it('xfp_get_pinned_facts records audit event on success', async () => {
      mockGetWorktreeByPath.mockReturnValue(WORKTREE)
      mockGetPinnedFacts.mockReturnValue(null)
      await xfpGetPinnedFactsTool.execute('call-1', {}, ABORT, () => {}, CTX)
      expect(mockRecordXfpAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreeId: 'w-1',
          sessionId: 's-1',
          runtimeId: 'xuanpu-agent',
          kind: 'tool',
          toolName: 'xfp_get_pinned_facts'
        })
      )
    })

    it('audit is not called when worktree is not found', async () => {
      mockGetWorktreeByPath.mockReturnValue(null)
      await xfpGetCurrentFocusTool.execute('call-1', {}, ABORT, () => {}, CTX)
      expect(mockRecordXfpAuditEvent).not.toHaveBeenCalled()
    })

    it('audit includes output summary from result', async () => {
      mockGetWorktreeByPath.mockReturnValue(WORKTREE)
      mockGetRecentFieldEvents.mockReturnValue([])
      await xfpGetCurrentFocusTool.execute('call-1', {}, ABORT, () => {}, CTX)
      const call = mockRecordXfpAuditEvent.mock.calls[0][0]
      expect(call.outputSummary).toContain('Current Focus')
      expect(call.outputChars).toBeGreaterThan(0)
    })
  })
})
