import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  xfpDelegateSubtaskTool,
  getActiveSubtasks,
  getSubtask
} from '../../src/main/services/xuanpu-agent/tools/subtask-tools'

// Stub Date.now for deterministic IDs
const NOW = 1700000000000

describe('xuanpu-agent subtask delegation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789)
  })

  it('returns structured details with subtask metadata on success', async () => {
    const result = await xfpDelegateSubtaskTool.execute(
      'call-1',
      { description: 'Test subtask', prompt: 'Do something with src/main.ts' },
      new AbortController().signal,
      () => {},
      { sessionId: 'session-1', worktreePath: '/repo' }
    )

    expect(result.isError).toBeFalsy()
    expect(result.details).toMatchObject({
      subtask: true,
      description: 'Test subtask',
      agent: 'general',
      status: 'completed'
    })
    expect(result.details!.childSessionId).toMatch(/^subtask-\d+-[a-z0-9]{6}$/)
    expect(result.details!.startedAt).toBe(NOW)
    expect(result.details!.completedAt).toBe(NOW)

    // Text result should contain the subtask ID
    const text = result.content.map((p) => ('text' in p ? p.text : '')).join('')
    expect(text).toContain('Subtask Delegated: Test subtask')
    expect(text).toContain(result.details!.childSessionId)
    expect(text).toContain('completed')
  })

  it('generates unique childSessionIds for concurrent subtasks', async () => {
    const result1 = await xfpDelegateSubtaskTool.execute(
      'call-1',
      { description: 'Task A', prompt: 'prompt A' },
      new AbortController().signal,
      () => {},
      { sessionId: 'session-1' }
    )

    vi.spyOn(Date, 'now').mockReturnValue(NOW + 1)
    vi.spyOn(Math, 'random').mockReturnValue(0.987654321)

    const result2 = await xfpDelegateSubtaskTool.execute(
      'call-2',
      { description: 'Task B', prompt: 'prompt B' },
      new AbortController().signal,
      () => {},
      { sessionId: 'session-1' }
    )

    expect(result1.details!.childSessionId).not.toBe(result2.details!.childSessionId)
  })

  it('tracks active subtasks with lifecycle', async () => {
    const result = await xfpDelegateSubtaskTool.execute(
      'call-1',
      { description: 'Tracked task', prompt: 'some prompt' },
      new AbortController().signal,
      () => {},
      { sessionId: 'session-1' }
    )

    const childId = result.details!.childSessionId
    const subtask = getSubtask(childId)
    expect(subtask).toBeDefined()
    expect(subtask!.description).toBe('Tracked task')
    expect(subtask!.status).toBe('completed')
    expect(subtask!.completedAt).toBe(NOW)

    // Also visible in the active list
    const active = getActiveSubtasks()
    expect(active.some((s) => s.childSessionId === childId)).toBe(true)
  })

  it('getSubtask retrieves by childSessionId', async () => {
    const result = await xfpDelegateSubtaskTool.execute(
      'call-1',
      { description: 'Lookup task', prompt: 'prompt' },
      new AbortController().signal,
      () => {},
      { sessionId: 'session-1' }
    )

    const childId = result.details!.childSessionId
    const subtask = getSubtask(childId)
    expect(subtask).toBeDefined()
    expect(subtask!.description).toBe('Lookup task')
    expect(subtask!.status).toBe('completed')
  })

  it('extracts file references from prompt', async () => {
    const result = await xfpDelegateSubtaskTool.execute(
      'call-1',
      {
        description: 'File ref task',
        prompt: 'Fix the bug in src/main/utils.ts and update src/shared/types.ts'
      },
      new AbortController().signal,
      () => {},
      { sessionId: 'session-1' }
    )

    const text = result.content.map((p) => ('text' in p ? p.text : '')).join('')
    expect(text).toContain('src/main/utils.ts')
    expect(text).toContain('src/shared/types.ts')
  })

  it('extracts action verbs from prompt', async () => {
    const result = await xfpDelegateSubtaskTool.execute(
      'call-1',
      { description: 'Action task', prompt: 'Fix the bug and refactor the auth module, then test it' },
      new AbortController().signal,
      () => {},
      { sessionId: 'session-1' }
    )

    const text = result.content.map((p) => ('text' in p ? p.text : '')).join('')
    expect(text).toContain('fix')
    expect(text).toContain('refactor')
    expect(text).toContain('test')
  })

  it('uses custom agent when specified', async () => {
    const result = await xfpDelegateSubtaskTool.execute(
      'call-1',
      { description: 'Custom agent task', prompt: 'prompt', agent: 'code-reviewer' },
      new AbortController().signal,
      () => {},
      { sessionId: 'session-1' }
    )

    expect(result.details!.agent).toBe('code-reviewer')
  })
})
