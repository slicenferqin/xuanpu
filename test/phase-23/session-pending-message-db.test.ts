import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import {
  createTestDatabase,
  canRunDatabaseTests,
  getDatabaseLoadError
} from '../utils/db-test-utils'

const canRun = canRunDatabaseTests()
const loadError = getDatabaseLoadError()
const describeIf = canRun ? describe : describe.skip

describeIf('session pending message database queue', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any
  let cleanup: () => void
  let pathCounter = 0

  beforeAll(() => {
    if (!canRun) {
      console.warn(
        'Skipping session pending message DB tests: better-sqlite3 not available.',
        loadError?.message
      )
    }
  })

  beforeEach(() => {
    const setup = createTestDatabase()
    db = setup.db
    cleanup = setup.cleanup
  })

  afterEach(() => {
    cleanup?.()
  })

  function createSession(agentSdk: 'opencode' | 'claude-code' | 'codex' = 'codex') {
    pathCounter += 1
    const project = db.createProject({
      name: `Pending Queue ${pathCounter}`,
      path: `/tmp/xuanpu-pending-queue-${pathCounter}`
    })
    const worktree = db.createWorktree({
      project_id: project.id,
      name: 'main',
      branch_name: 'main',
      path: `/tmp/xuanpu-pending-queue-${pathCounter}/main`
    })
    return db.createSession({
      worktree_id: worktree.id,
      project_id: project.id,
      agent_sdk: agentSdk
    })
  }

  it('creates and lists pending messages in FIFO order', () => {
    const session = createSession('codex')
    const first = db.createSessionPendingMessage({
      session_id: session.id,
      runtime_id: 'codex',
      content: 'first',
      attachments_json: JSON.stringify([{ kind: 'data', name: 'a.txt' }]),
      prompt_options_json: JSON.stringify({ mode: 'build' }),
      model_json: JSON.stringify({ providerID: 'codex', modelID: 'gpt-5.4' }),
      enqueued_at: 100
    })
    const second = db.createSessionPendingMessage({
      session_id: session.id,
      runtime_id: 'codex',
      content: 'second',
      enqueued_at: 101
    })

    const messages = db.listSessionPendingMessages(session.id)
    expect(messages.map((message: { id: string }) => message.id)).toEqual([first.id, second.id])
    expect(messages[0]).toMatchObject({
      status: 'pending',
      content: 'first',
      attachments_json: JSON.stringify([{ kind: 'data', name: 'a.txt' }]),
      prompt_options_json: JSON.stringify({ mode: 'build' }),
      model_json: JSON.stringify({ providerID: 'codex', modelID: 'gpt-5.4' })
    })
  })

  it('claims only one pending message and keeps it visible as sending', () => {
    const session = createSession('codex')
    db.createSessionPendingMessage({
      session_id: session.id,
      runtime_id: 'codex',
      content: 'send me',
      enqueued_at: 100
    })

    const claimed = db.claimNextSessionPendingMessage(session.id, {
      agent_session_id: 'agent-session-1',
      sending_run_epoch: 7,
      sending_turn_id: 'turn-7'
    })
    const secondClaim = db.claimNextSessionPendingMessage(session.id)

    expect(claimed).toMatchObject({
      status: 'sending',
      agent_session_id: 'agent-session-1',
      sending_run_epoch: 7,
      sending_turn_id: 'turn-7',
      error: null
    })
    expect(secondClaim).toBeNull()
    expect(db.listSessionPendingMessages(session.id)).toHaveLength(1)
    expect(db.listSessionPendingMessages(session.id)[0].status).toBe('sending')
  })

  it('claims a specific pending message by id', () => {
    const session = createSession('codex')
    const first = db.createSessionPendingMessage({
      session_id: session.id,
      runtime_id: 'codex',
      content: 'first',
      enqueued_at: 100
    })
    const second = db.createSessionPendingMessage({
      session_id: session.id,
      runtime_id: 'codex',
      content: 'second',
      enqueued_at: 101
    })

    const claimed = db.claimSessionPendingMessage(second.id, {
      agent_session_id: 'agent-session-2'
    })

    expect(claimed).toMatchObject({
      id: second.id,
      status: 'sending',
      agent_session_id: 'agent-session-2'
    })
    expect(db.getSessionPendingMessage(first.id)).toMatchObject({ status: 'pending' })
    expect(db.claimSessionPendingMessage(second.id)).toBeNull()
  })

  it('completes accepted messages and hides sent rows from active queue reads', () => {
    const session = createSession('claude-code')
    const message = db.createSessionPendingMessage({
      session_id: session.id,
      runtime_id: 'claude-code',
      content: 'after current run'
    })
    db.claimNextSessionPendingMessage(session.id)

    const completed = db.completeSessionPendingMessage(message.id)

    expect(completed?.status).toBe('sent')
    expect(db.listSessionPendingMessages(session.id)).toEqual([])
    expect(db.listSessionPendingMessages(session.id, ['sent'])[0].id).toBe(message.id)
  })

  it('does not mark unclaimed pending messages as sent', () => {
    const session = createSession('codex')
    const message = db.createSessionPendingMessage({
      session_id: session.id,
      runtime_id: 'codex',
      content: 'not accepted yet'
    })

    expect(db.completeSessionPendingMessage(message.id)).toBeNull()
    expect(db.getSessionPendingMessage(message.id)).toMatchObject({
      status: 'pending',
      error: null
    })
  })

  it('restores failed sending messages back to pending with an error', () => {
    const session = createSession('codex')
    const message = db.createSessionPendingMessage({
      session_id: session.id,
      runtime_id: 'codex',
      content: 'retry later'
    })
    db.claimNextSessionPendingMessage(session.id, { sending_run_epoch: 1 })

    const restored = db.restoreSessionPendingMessage(message.id, 'provider busy')

    expect(restored).toMatchObject({
      status: 'pending',
      sending_run_epoch: null,
      sending_turn_id: null,
      error: 'provider busy'
    })
    expect(db.claimNextSessionPendingMessage(session.id)?.id).toBe(message.id)
  })

  it('restores failed terminal rows so they can be retried', () => {
    const session = createSession('codex')
    const message = db.createSessionPendingMessage({
      session_id: session.id,
      runtime_id: 'codex',
      content: 'retry failed row'
    })
    db.claimNextSessionPendingMessage(session.id)
    db.failSessionPendingMessage(message.id, 'provider rejected')

    const restored = db.restoreSessionPendingMessage(message.id, 'retry requested')

    expect(restored).toMatchObject({
      status: 'pending',
      error: 'retry requested'
    })
    expect(db.claimNextSessionPendingMessage(session.id)?.id).toBe(message.id)
  })

  it('cascades pending rows when a session is deleted', () => {
    const session = createSession('codex')
    db.createSessionPendingMessage({
      session_id: session.id,
      runtime_id: 'codex',
      content: 'will be removed'
    })

    db.deleteSession(session.id)

    expect(db.listSessionPendingMessages(session.id)).toEqual([])
  })
})
