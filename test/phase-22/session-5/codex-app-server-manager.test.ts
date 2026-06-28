/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock logger
vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// Mock child_process
vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    spawn: vi.fn(),
    spawnSync: vi.fn()
  }
})

import {
  CodexAppServerManager,
  type CodexSessionContext,
  type CodexProviderSession
} from '../../../src/main/services/codex-app-server-manager'

// ── Helper: create a test session context ───────────────────────────

function createTestContext(overrides?: Partial<CodexProviderSession>): {
  context: CodexSessionContext
  stdin: { write: ReturnType<typeof vi.fn>; writable: boolean }
} {
  const stdin = { write: vi.fn(), writable: true }

  const child = {
    stdin,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    pid: 12345,
    killed: false,
    kill: vi.fn(),
    on: vi.fn()
  } as any

  const output = {
    on: vi.fn(),
    close: vi.fn(),
    removeAllListeners: vi.fn()
  } as any

  const session: CodexProviderSession = {
    provider: 'codex',
    status: 'ready',
    threadId: 'thread-123',
    cwd: '/test/project',
    model: 'gpt-5.4',
    activeTurnId: null,
    resumeCursor: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  }

  const context: CodexSessionContext = {
    session,
    child,
    output,
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    nextRequestId: 1,
    stopping: false
  }

  return { context, stdin }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('CodexAppServerManager — app-server payloads', () => {
  let manager: CodexAppServerManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new CodexAppServerManager()
  })

  afterEach(() => {
    manager.stopAll()
    manager.removeAllListeners()
  })

  function seedSession(context: CodexSessionContext): void {
    const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
    sessionsMap.set(context.session.threadId!, context)
  }

  function getWrittenMessages(stdin: { write: ReturnType<typeof vi.fn> }): any[] {
    return stdin.write.mock.calls.map((call: any[]) => JSON.parse((call[0] as string).trim()))
  }

  function getTurnStartParams(messages: any[]): any {
    const msg = messages.find((m: any) => m.method === 'turn/start')
    return msg?.params ?? null
  }

  it('normalizes plain text input to Codex UserInput text_elements shape', async () => {
    const { context, stdin } = createTestContext()
    seedSession(context)

    const turnPromise = manager.sendTurn('thread-123', {
      text: 'hello',
      model: 'gpt-5.4'
    })

    const messages = getWrittenMessages(stdin)
    const turnStartMsg = messages.find((m: any) => m.method === 'turn/start')
    expect(turnStartMsg).toBeDefined()

    manager.handleStdoutLine(
      context,
      JSON.stringify({ id: turnStartMsg.id, result: { turn: { id: 'turn-xyz' } } })
    )

    await turnPromise

    const params = getTurnStartParams(messages)
    expect(params).not.toBeNull()
    expect(params.input).toEqual([{ type: 'text', text: 'hello', text_elements: [] }])
    expect(params.collaborationMode).toBeUndefined()
    expect(params.settings).toBeUndefined()
  })

  it('sends skills/list for the requested cwd', async () => {
    const { context, stdin } = createTestContext()
    seedSession(context)

    const skillsPromise = manager.listSkills('thread-123', '/test/project', true)

    const messages = getWrittenMessages(stdin)
    const listMsg = messages.find((message: any) => message.method === 'skills/list')
    expect(listMsg).toBeDefined()
    expect(listMsg.params).toEqual({
      cwds: ['/test/project'],
      forceReload: true
    })

    manager.handleStdoutLine(
      context,
      JSON.stringify({
        id: listMsg.id,
        result: { data: [{ cwd: '/test/project', skills: [], errors: [] }] }
      })
    )

    await expect(skillsPromise).resolves.toEqual({
      data: [{ cwd: '/test/project', skills: [], errors: [] }]
    })
  })

  it('prepends plan-mode instructions without unsupported collaborationMode payload', async () => {
    const { context, stdin } = createTestContext()
    seedSession(context)

    const turnPromise = manager.sendTurn('thread-123', {
      text: 'plan my task',
      interactionMode: 'plan',
      model: 'gpt-5.4'
    })

    const messages = getWrittenMessages(stdin)
    const turnStartMsg = messages.find((message: any) => message.method === 'turn/start')
    expect(turnStartMsg).toBeDefined()

    const params = getTurnStartParams(messages)
    expect(params.collaborationMode).toBeUndefined()
    expect(params.settings).toBeUndefined()
    expect(params.input[0]).toEqual({
      type: 'text',
      text: expect.stringContaining('[Xuanpu Plan Mode]'),
      text_elements: []
    })
    expect(params.input[0].text).toContain('<proposed_plan>')
    expect(params.input[1]).toEqual({ type: 'text', text: 'plan my task', text_elements: [] })

    manager.handleStdoutLine(
      context,
      JSON.stringify({ id: turnStartMsg.id, result: { turn: { id: 'turn-plan' } } })
    )

    await turnPromise
  })

  it('preserves structured skill input arrays in turn/start and normalizes text parts', async () => {
    const { context, stdin } = createTestContext()
    seedSession(context)

    const turnPromise = manager.sendTurn('thread-123', {
      input: [
        { type: 'skill', name: 'imagegen', path: '/skills/imagegen/SKILL.md' },
        { type: 'text', text: 'make it crisp' }
      ],
      model: 'gpt-5.4'
    })

    const messages = getWrittenMessages(stdin)
    const turnStartMsg = messages.find((message: any) => message.method === 'turn/start')
    expect(turnStartMsg).toBeDefined()

    const params = getTurnStartParams(messages)
    expect(params.input).toEqual([
      { type: 'skill', name: 'imagegen', path: '/skills/imagegen/SKILL.md' },
      { type: 'text', text: 'make it crisp', text_elements: [] }
    ])

    manager.handleStdoutLine(
      context,
      JSON.stringify({ id: turnStartMsg.id, result: { turn: { id: 'turn-skill' } } })
    )

    await turnPromise
  })

  it('sends reasoning effort as top-level effort and omits legacy settings', async () => {
    const { context, stdin } = createTestContext()
    seedSession(context)

    const turnPromise = manager.sendTurn('thread-123', {
      text: 'think lightly',
      model: 'gpt-5.4',
      reasoningEffort: 'low'
    })

    const messages = getWrittenMessages(stdin)
    const turnStartMsg = messages.find((m: any) => m.method === 'turn/start')

    manager.handleStdoutLine(
      context,
      JSON.stringify({ id: turnStartMsg.id, result: { turn: { id: 'turn-effort' } } })
    )

    await turnPromise

    const params = getTurnStartParams(messages)
    expect(params.effort).toBe('low')
    expect(params.settings).toBeUndefined()
  })

  it('passes serviceTier as a top-level turn/start field', async () => {
    const { context, stdin } = createTestContext()
    seedSession(context)

    const turnPromise = manager.sendTurn('thread-123', {
      text: 'fast please',
      model: 'gpt-5.4',
      serviceTier: 'fast'
    })

    const messages = getWrittenMessages(stdin)
    const turnStartMsg = messages.find((m: any) => m.method === 'turn/start')

    manager.handleStdoutLine(
      context,
      JSON.stringify({ id: turnStartMsg.id, result: { turn: { id: 'turn-fast' } } })
    )

    await turnPromise

    const params = getTurnStartParams(messages)
    expect(params.serviceTier).toBe('fast')
  })

  it('normalizes multi-part input for title generation style turns', async () => {
    const { context, stdin } = createTestContext()
    seedSession(context)

    const turnPromise = manager.sendTurn('thread-123', {
      model: 'gpt-5.4',
      reasoningEffort: 'low',
      input: [
        { type: 'text', text: 'Generate a title for this conversation:\n' },
        { type: 'text', text: 'Fix auth refresh token bug' }
      ]
    })

    const messages = getWrittenMessages(stdin)
    const turnStartMsg = messages.find((m: any) => m.method === 'turn/start')

    manager.handleStdoutLine(
      context,
      JSON.stringify({ id: turnStartMsg.id, result: { turn: { id: 'turn-title' } } })
    )

    await turnPromise

    const params = getTurnStartParams(messages)
    expect(params.input).toEqual([
      { type: 'text', text: 'Generate a title for this conversation:\n', text_elements: [] },
      { type: 'text', text: 'Fix auth refresh token bug', text_elements: [] }
    ])
    expect(params.effort).toBe('low')
    expect(params.settings).toBeUndefined()
    expect(params.collaborationMode).toBeUndefined()
  })
})

describe('CodexAppServerManager.steerTurn', () => {
  let manager: CodexAppServerManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new CodexAppServerManager()
  })

  afterEach(() => {
    manager.stopAll()
    manager.removeAllListeners()
  })

  function seedSession(context: CodexSessionContext): void {
    const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
    sessionsMap.set(context.session.threadId!, context)
  }

  function getWrittenMessages(stdin: { write: ReturnType<typeof vi.fn> }): any[] {
    return stdin.write.mock.calls.map((call: any[]) => JSON.parse((call[0] as string).trim()))
  }

  it('sends turn/steer with the active turn id by default', async () => {
    const { context, stdin } = createTestContext({ activeTurnId: 'turn-active-1' })
    seedSession(context)

    const steerPromise = manager.steerTurn('thread-123', {
      text: 'course correct'
    })

    const messages = getWrittenMessages(stdin)
    const steerMsg = messages.find((message: any) => message.method === 'turn/steer')
    expect(steerMsg).toBeDefined()
    expect(steerMsg.params).toEqual({
      threadId: 'thread-123',
      expectedTurnId: 'turn-active-1',
      input: [{ type: 'text', text: 'course correct', text_elements: [] }]
    })

    manager.handleStdoutLine(context, JSON.stringify({ id: steerMsg.id, result: { ok: true } }))

    await steerPromise
  })

  it('uses explicit turnId override when provided', async () => {
    const { context, stdin } = createTestContext({ activeTurnId: 'turn-active-1' })
    seedSession(context)

    const steerPromise = manager.steerTurn(
      'thread-123',
      { text: 'course correct' },
      'turn-override-9'
    )

    const messages = getWrittenMessages(stdin)
    const steerMsg = messages.find((message: any) => message.method === 'turn/steer')
    expect(steerMsg?.params.expectedTurnId).toBe('turn-override-9')
    expect(steerMsg?.params.turnId).toBeUndefined()

    manager.handleStdoutLine(context, JSON.stringify({ id: steerMsg.id, result: { ok: true } }))

    await steerPromise
  })
})

describe('CodexAppServerManager.setThreadGoal', () => {
  let manager: CodexAppServerManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new CodexAppServerManager()
  })

  afterEach(() => {
    manager.stopAll()
    manager.removeAllListeners()
  })

  function seedSession(context: CodexSessionContext): void {
    const sessionsMap = (manager as any).sessions as Map<string, CodexSessionContext>
    sessionsMap.set(context.session.threadId!, context)
  }

  function getWrittenMessages(stdin: { write: ReturnType<typeof vi.fn> }): any[] {
    return stdin.write.mock.calls.map((call: any[]) => JSON.parse((call[0] as string).trim()))
  }

  it('sends thread/goal/set with an active goal objective', async () => {
    const { context, stdin } = createTestContext()
    seedSession(context)

    const goalPromise = manager.setThreadGoal('thread-123', {
      objective: 'Finish migration',
      status: 'active',
      tokenBudget: null
    })

    const messages = getWrittenMessages(stdin)
    const goalMsg = messages.find((message: any) => message.method === 'thread/goal/set')
    expect(goalMsg).toBeDefined()
    expect(goalMsg.params).toEqual({
      threadId: 'thread-123',
      objective: 'Finish migration',
      status: 'active',
      tokenBudget: null
    })

    manager.handleStdoutLine(
      context,
      JSON.stringify({
        id: goalMsg.id,
        result: { goal: { objective: 'Finish migration', status: 'active' } }
      })
    )

    await expect(goalPromise).resolves.toEqual({
      goal: { objective: 'Finish migration', status: 'active' }
    })
  })
})
