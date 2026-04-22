import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

vi.mock('../../src/main/db', () => ({
  getDatabase: vi.fn()
}))

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import { emitAgentToolEvent } from '../../src/main/field/emit-agent-tool'
import { getFieldEventSink, resetFieldEventSink } from '../../src/main/field/sink'
import {
  invalidatePrivacyCache,
  setFieldCollectionEnabledCache,
  setBashOutputCaptureEnabledCache
} from '../../src/main/field/privacy'
import { resetEventBus } from '../../src/server/event-bus'
import type { FieldEvent } from '../../src/shared/types/field-event'

const WORKTREE_PATH = '/Users/dev/proj/wt'

function captureLastEnqueued(): FieldEvent | null {
  const sink = getFieldEventSink()
  let last: FieldEvent | null = null
  vi.spyOn(sink, 'enqueue').mockImplementation((evt: FieldEvent) => {
    last = evt
    return undefined as unknown as void
  })
  return new Proxy(
    {},
    {
      get: (_t, prop) => (prop === 'value' ? last : undefined)
    }
  ) as { value: FieldEvent | null }
}

beforeEach(() => {
  resetFieldEventSink()
  resetEventBus()
  invalidatePrivacyCache()
  setFieldCollectionEnabledCache(true)
  setBashOutputCaptureEnabledCache(false) // default OFF
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── Sub-agent skip ─────────────────────────────────────────────────────────

describe('emitAgentToolEvent — sub-agent skip (Phase 21.5)', () => {
  it('returns null and emits nothing when parentToolUseId is set', () => {
    const sink = getFieldEventSink()
    const spy = vi.spyOn(sink, 'enqueue')
    const id = emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: 'p-1',
      sessionId: 's-1',
      worktreePath: WORKTREE_PATH,
      toolName: 'Read',
      toolUseId: 'tu-1',
      parentToolUseId: 'tu-parent',
      input: { file_path: '/Users/dev/proj/wt/src/a.ts' }
    })
    expect(id).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('emits when parentToolUseId is null/undefined', () => {
    const sink = getFieldEventSink()
    const spy = vi.spyOn(sink, 'enqueue')
    const id = emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: 'p-1',
      sessionId: 's-1',
      worktreePath: WORKTREE_PATH,
      toolName: 'Read',
      toolUseId: 'tu-1',
      input: { file_path: '/Users/dev/proj/wt/src/a.ts' }
    })
    expect(id).not.toBeNull()
    expect(spy).toHaveBeenCalledOnce()
  })
})

// ─── Routing by tool name ───────────────────────────────────────────────────

describe('emitAgentToolEvent — tool routing (Phase 21.5)', () => {
  it('Read → agent.file_read with path relative to worktree', () => {
    const sink = getFieldEventSink()
    let captured: FieldEvent | null = null
    vi.spyOn(sink, 'enqueue').mockImplementation((evt: FieldEvent) => {
      captured = evt
    })
    emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: null,
      sessionId: null,
      worktreePath: WORKTREE_PATH,
      toolName: 'Read',
      toolUseId: 'tu-1',
      input: { file_path: '/Users/dev/proj/wt/src/auth.ts' },
      output: { text: 'file contents' }
    })
    expect(captured).not.toBeNull()
    expect(captured!.type).toBe('agent.file_read')
    expect((captured!.payload as { path: string }).path).toBe('src/auth.ts')
    expect((captured!.payload as { bytes: number }).bytes).toBe(13)
    expect((captured!.payload as { toolUseId: string }).toolUseId).toBe('tu-1')
  })

  it('Edit → agent.file_write with operation="edit"', () => {
    const sink = getFieldEventSink()
    let captured: FieldEvent | null = null
    vi.spyOn(sink, 'enqueue').mockImplementation((evt: FieldEvent) => {
      captured = evt
    })
    emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: null,
      sessionId: null,
      worktreePath: WORKTREE_PATH,
      toolName: 'Edit',
      toolUseId: 'tu-2',
      input: { file_path: '/Users/dev/proj/wt/src/foo.ts' }
    })
    expect(captured!.type).toBe('agent.file_write')
    expect((captured!.payload as { operation: string }).operation).toBe('edit')
    expect((captured!.payload as { path: string }).path).toBe('src/foo.ts')
  })

  it('Glob → agent.file_search with pattern (NOT path)', () => {
    const sink = getFieldEventSink()
    let captured: FieldEvent | null = null
    vi.spyOn(sink, 'enqueue').mockImplementation((evt: FieldEvent) => {
      captured = evt
    })
    emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: null,
      sessionId: null,
      worktreePath: WORKTREE_PATH,
      toolName: 'Glob',
      toolUseId: 'tu-3',
      input: { pattern: '**/*.ts' },
      output: { matchCount: 12 }
    })
    expect(captured!.type).toBe('agent.file_search')
    expect((captured!.payload as { pattern: string }).pattern).toBe('**/*.ts')
    expect((captured!.payload as { matchCount: number }).matchCount).toBe(12)
    // Critical: no `path` field in agent.file_search payload.
    expect((captured!.payload as { path?: string }).path).toBeUndefined()
  })

  it('Bash → agent.bash_exec with command + exitCode + duration', () => {
    const sink = getFieldEventSink()
    let captured: FieldEvent | null = null
    vi.spyOn(sink, 'enqueue').mockImplementation((evt: FieldEvent) => {
      captured = evt
    })
    emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: null,
      sessionId: null,
      worktreePath: WORKTREE_PATH,
      toolName: 'Bash',
      toolUseId: 'tu-4',
      input: { command: 'pnpm test src/auth' },
      output: { exitCode: 0, durationMs: 1234 }
    })
    expect(captured!.type).toBe('agent.bash_exec')
    expect((captured!.payload as { command: string }).command).toBe('pnpm test src/auth')
    expect((captured!.payload as { exitCode: number }).exitCode).toBe(0)
    expect((captured!.payload as { durationMs: number }).durationMs).toBe(1234)
  })

  it.each([
    ['NotebookRead', 'agent.file_read'],
    ['file_read', 'agent.file_read'],
    ['Write', 'agent.file_write'],
    ['MultiEdit', 'agent.file_write'],
    ['NotebookEdit', 'agent.file_write'],
    ['apply_patch', 'agent.file_write'],
    ['Grep', 'agent.file_search'],
    ['exec_command', 'agent.bash_exec']
  ])('routes tool %s → %s', (toolName, expectedType) => {
    const sink = getFieldEventSink()
    let captured: FieldEvent | null = null
    vi.spyOn(sink, 'enqueue').mockImplementation((evt: FieldEvent) => {
      captured = evt
    })
    const isSearch = expectedType === 'agent.file_search'
    const isBash = expectedType === 'agent.bash_exec'
    emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: null,
      sessionId: null,
      worktreePath: WORKTREE_PATH,
      toolName,
      toolUseId: 'tu-x',
      input: isSearch
        ? { pattern: 'foo' }
        : isBash
          ? { command: 'echo' }
          : { file_path: '/Users/dev/proj/wt/x.ts' }
    })
    expect(captured!.type).toBe(expectedType)
  })

  it('unknown tool name → no-op (returns null, nothing enqueued)', () => {
    const sink = getFieldEventSink()
    const spy = vi.spyOn(sink, 'enqueue')
    const id = emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: null,
      sessionId: null,
      worktreePath: WORKTREE_PATH,
      toolName: 'WeirdNewTool',
      toolUseId: 'tu-z',
      input: { file_path: '/x' }
    })
    expect(id).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })
})

// ─── Glob-string guard for read/write paths ─────────────────────────────────

describe('emitAgentToolEvent — glob guard (Phase 21.5)', () => {
  it('drops Read with a glob string in file_path', () => {
    const sink = getFieldEventSink()
    const spy = vi.spyOn(sink, 'enqueue')
    const id = emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: null,
      sessionId: null,
      worktreePath: WORKTREE_PATH,
      toolName: 'Read',
      toolUseId: 'tu-1',
      input: { file_path: '**/*.ts' }
    })
    expect(id).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('drops Edit with a ? wildcard in path', () => {
    const sink = getFieldEventSink()
    const spy = vi.spyOn(sink, 'enqueue')
    const id = emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: null,
      sessionId: null,
      worktreePath: WORKTREE_PATH,
      toolName: 'Edit',
      toolUseId: 'tu-1',
      input: { file_path: 'src/file?.ts' }
    })
    expect(id).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('Glob still works fine with wildcard pattern (not subject to guard)', () => {
    const sink = getFieldEventSink()
    const spy = vi.spyOn(sink, 'enqueue')
    const id = emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: null,
      sessionId: null,
      worktreePath: WORKTREE_PATH,
      toolName: 'Glob',
      toolUseId: 'tu-1',
      input: { pattern: '**/*.ts' }
    })
    expect(id).not.toBeNull()
    expect(spy).toHaveBeenCalledOnce()
  })
})

// ─── Privacy gates ──────────────────────────────────────────────────────────

describe('emitAgentToolEvent — privacy (Phase 21.5)', () => {
  it('field_collection_enabled = false → all agent events dropped', () => {
    setFieldCollectionEnabledCache(false)
    const sink = getFieldEventSink()
    const spy = vi.spyOn(sink, 'enqueue')

    for (const tool of ['Read', 'Edit', 'Glob', 'Bash']) {
      emitAgentToolEvent({
        worktreeId: 'w-1',
        projectId: null,
        sessionId: null,
        worktreePath: WORKTREE_PATH,
        toolName: tool,
        toolUseId: `tu-${tool}`,
        input:
          tool === 'Glob'
            ? { pattern: 'x' }
            : tool === 'Bash'
              ? { command: 'echo' }
              : { file_path: '/Users/dev/proj/wt/x.ts' }
      })
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('Bash output capture default OFF → stdoutHead/stderrTail are null', () => {
    setBashOutputCaptureEnabledCache(false)
    const sink = getFieldEventSink()
    let captured: FieldEvent | null = null
    vi.spyOn(sink, 'enqueue').mockImplementation((evt: FieldEvent) => {
      captured = evt
    })
    emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: null,
      sessionId: null,
      worktreePath: WORKTREE_PATH,
      toolName: 'Bash',
      toolUseId: 'tu-1',
      input: { command: 'env' },
      output: { text: 'API_KEY=secret', error: 'fatal: token=abc', exitCode: 1 }
    })
    expect((captured!.payload as { stdoutHead: string | null }).stdoutHead).toBeNull()
    expect((captured!.payload as { stderrTail: string | null }).stderrTail).toBeNull()
    // Command is still captured (user can see it in sidebar anyway)
    expect((captured!.payload as { command: string }).command).toBe('env')
  })

  it('Bash output capture ON → head/tail truncated to 1024 chars', () => {
    setBashOutputCaptureEnabledCache(true)
    const sink = getFieldEventSink()
    let captured: FieldEvent | null = null
    vi.spyOn(sink, 'enqueue').mockImplementation((evt: FieldEvent) => {
      captured = evt
    })
    const longOut = 'A'.repeat(2000)
    const longErr = 'B'.repeat(2000) + 'TAIL_END'
    emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: null,
      sessionId: null,
      worktreePath: WORKTREE_PATH,
      toolName: 'Bash',
      toolUseId: 'tu-1',
      input: { command: 'pnpm build' },
      output: { text: longOut, error: longErr, exitCode: 0 }
    })
    const stdout = (captured!.payload as { stdoutHead: string }).stdoutHead
    const stderr = (captured!.payload as { stderrTail: string }).stderrTail
    expect(stdout.length).toBe(1024)
    expect(stdout.startsWith('A')).toBe(true)
    expect(stderr.length).toBe(1024)
    expect(stderr.endsWith('TAIL_END')).toBe(true)
  })
})

// ─── Field-level constraints ───────────────────────────────────────────────

describe('emitAgentToolEvent — field constraints (Phase 21.5)', () => {
  it('truncates command to 512 chars', () => {
    const sink = getFieldEventSink()
    let captured: FieldEvent | null = null
    vi.spyOn(sink, 'enqueue').mockImplementation((evt: FieldEvent) => {
      captured = evt
    })
    emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: null,
      sessionId: null,
      worktreePath: WORKTREE_PATH,
      toolName: 'Bash',
      toolUseId: 'tu-1',
      input: { command: 'x'.repeat(2000) }
    })
    expect((captured!.payload as { command: string }).command.length).toBe(512)
  })

  it('drops Read without file_path', () => {
    const sink = getFieldEventSink()
    const spy = vi.spyOn(sink, 'enqueue')
    const id = emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: null,
      sessionId: null,
      worktreePath: WORKTREE_PATH,
      toolName: 'Read',
      toolUseId: 'tu-1',
      input: {}
    })
    expect(id).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('drops Glob without pattern', () => {
    const sink = getFieldEventSink()
    const spy = vi.spyOn(sink, 'enqueue')
    const id = emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: null,
      sessionId: null,
      worktreePath: WORKTREE_PATH,
      toolName: 'Glob',
      toolUseId: 'tu-1',
      input: {}
    })
    expect(id).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('drops calls missing toolUseId', () => {
    const sink = getFieldEventSink()
    const spy = vi.spyOn(sink, 'enqueue')
    const id = emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: null,
      sessionId: null,
      worktreePath: WORKTREE_PATH,
      toolName: 'Read',
      toolUseId: '',
      input: { file_path: '/Users/dev/proj/wt/x.ts' }
    })
    expect(id).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('keeps already-relative paths unchanged', () => {
    const sink = getFieldEventSink()
    let captured: FieldEvent | null = null
    vi.spyOn(sink, 'enqueue').mockImplementation((evt: FieldEvent) => {
      captured = evt
    })
    emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: null,
      sessionId: null,
      worktreePath: WORKTREE_PATH,
      toolName: 'Read',
      toolUseId: 'tu-1',
      input: { file_path: 'src/foo.ts' }
    })
    expect((captured!.payload as { path: string }).path).toBe('src/foo.ts')
  })

  it('reads input.path when input.file_path is absent (fallback)', () => {
    const sink = getFieldEventSink()
    let captured: FieldEvent | null = null
    vi.spyOn(sink, 'enqueue').mockImplementation((evt: FieldEvent) => {
      captured = evt
    })
    emitAgentToolEvent({
      worktreeId: 'w-1',
      projectId: null,
      sessionId: null,
      worktreePath: WORKTREE_PATH,
      toolName: 'Read',
      toolUseId: 'tu-1',
      input: { path: '/Users/dev/proj/wt/x.ts' }
    })
    expect((captured!.payload as { path: string }).path).toBe('x.ts')
  })
})
