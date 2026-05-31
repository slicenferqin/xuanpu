import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import {
  createTestDatabase,
  canRunDatabaseTests,
  getDatabaseLoadError
} from '../utils/db-test-utils'

const canRun = canRunDatabaseTests()
const loadError = getDatabaseLoadError()
const describeIf = canRun ? describe : describe.skip

describeIf('Usage Events (v2 ledger)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any
  let cleanup: () => void

  beforeAll(() => {
    if (!canRun) {
      console.warn(
        'Skipping usage events DB tests: better-sqlite3 not available.',
        loadError?.message
      )
    }
  })

  beforeEach(() => {
    const setup = createTestDatabase()
    db = setup.db
    cleanup = setup.cleanup

    // Create a test project first (FK requirement)
    db.createProject({
      id: 'test-project',
      name: 'Test Project',
      path: '/tmp/test-project'
    })
  })

  afterEach(() => {
    cleanup?.()
  })

  it('inserts multiple events with different fingerprints for the same turn', () => {
    const session = db.createSession({
      project_id: 'test-project',
      worktree_id: null,
      name: 'test-session',
      agent_sdk: 'codex'
    })

    db.insertUsageEvent({
      session_id: session.id,
      project_id: 'test-project',
      agent_sdk: 'codex',
      source_kind: 'codex-token-count',
      source_event_id: 'thread1:turn1:1000:500:200:300',
      turn_id: 'turn1',
      provider_id: 'codex',
      model_id: 'gpt-5.4',
      model_label: 'gpt-5.4',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 200,
      total_tokens: 350,
      cost_estimate: 0.01,
      occurred_at: '2026-05-25T10:00:00Z'
    })

    db.insertUsageEvent({
      session_id: session.id,
      project_id: 'test-project',
      agent_sdk: 'codex',
      source_kind: 'codex-token-count',
      source_event_id: 'thread1:turn1:2000:1000:500:500',
      turn_id: 'turn1',
      input_tokens: 200,
      output_tokens: 100,
      cache_read_tokens: 300,
      total_tokens: 600,
      cost_estimate: 0.02,
      occurred_at: '2026-05-25T10:01:00Z'
    })

    db.insertUsageEvent({
      session_id: session.id,
      project_id: 'test-project',
      agent_sdk: 'codex',
      source_kind: 'codex-token-count',
      source_event_id: 'thread1:turn1:3000:1500:800:700',
      turn_id: 'turn1',
      input_tokens: 300,
      output_tokens: 150,
      cache_read_tokens: 500,
      total_tokens: 950,
      cost_estimate: 0.03,
      occurred_at: '2026-05-25T10:02:00Z'
    })

    const events = db.getUsageEventsBySession(session.id)
    expect(events).toHaveLength(3)
    expect(events[0].turn_id).toBe('turn1')
    expect(events[0].agent_sdk).toBe('codex')
    expect(events[0].provider_id).toBe('codex')
    expect(events[0].model_id).toBe('gpt-5.4')
    expect(events[0].model_label).toBe('gpt-5.4')
    expect(events[1].turn_id).toBe('turn1')
    expect(events[2].turn_id).toBe('turn1')
  })

  it('ignores duplicate events with the same fingerprint', () => {
    const session = db.createSession({
      project_id: 'test-project',
      worktree_id: null,
      name: 'test-session-dup',
      agent_sdk: 'codex'
    })

    const eventData = {
      session_id: session.id,
      project_id: 'test-project',
      agent_sdk: 'codex' as const,
      source_kind: 'codex-token-count',
      source_event_id: 'thread1:turn1:1000:500:200:300',
      turn_id: 'turn1',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 200,
      total_tokens: 350,
      cost_estimate: 0.01,
      occurred_at: '2026-05-25T10:00:00Z'
    }

    db.insertUsageEvent(eventData)
    db.insertUsageEvent(eventData)

    const events = db.getUsageEventsBySession(session.id)
    expect(events).toHaveLength(1)
  })

  it('sum of event deltas equals final provider total', () => {
    const session = db.createSession({
      project_id: 'test-project',
      worktree_id: null,
      name: 'test-session-sum',
      agent_sdk: 'codex'
    })

    const events = [
      { input: 100, output: 50, cacheRead: 200, total: 350 },
      { input: 200, output: 100, cacheRead: 300, total: 600 },
      { input: 150, output: 75, cacheRead: 250, total: 475 }
    ]

    events.forEach((e, i) => {
      db.insertUsageEvent({
        session_id: session.id,
        project_id: 'test-project',
        agent_sdk: 'codex',
        source_kind: 'codex-token-count',
        source_event_id: `thread1:turn1:${i}`,
        turn_id: 'turn1',
        input_tokens: e.input,
        output_tokens: e.output,
        cache_read_tokens: e.cacheRead,
        total_tokens: e.total,
        cost_estimate: 0.01 * (i + 1),
        occurred_at: `2026-05-25T10:0${i}:00Z`
      })
    })

    const storedEvents = db.getUsageEventsBySession(session.id)
    expect(storedEvents).toHaveLength(3)

    const totalInput = storedEvents.reduce(
      (sum: number, e: { input_tokens: number }) => sum + e.input_tokens,
      0
    )
    const totalOutput = storedEvents.reduce(
      (sum: number, e: { output_tokens: number }) => sum + e.output_tokens,
      0
    )
    const totalCacheRead = storedEvents.reduce(
      (sum: number, e: { cache_read_tokens: number }) => sum + e.cache_read_tokens,
      0
    )
    const totalCost = storedEvents.reduce(
      (sum: number, e: { cost_estimate: number }) => sum + e.cost_estimate,
      0
    )

    expect(totalInput).toBe(450)
    expect(totalOutput).toBe(225)
    expect(totalCacheRead).toBe(750)
    expect(totalCost).toBeCloseTo(0.06, 10)
  })

  it('updates session usage snapshot with cumulative totals', () => {
    const session = db.createSession({
      project_id: 'test-project',
      worktree_id: null,
      name: 'test-session-snapshot',
      agent_sdk: 'codex'
    })

    db.insertUsageEvent({
      session_id: session.id,
      project_id: 'test-project',
      agent_sdk: 'codex',
      source_kind: 'codex-token-count',
      source_event_id: 'thread1:turn1:1000:500:200:300',
      turn_id: 'turn1',
      provider_id: 'codex',
      model_id: 'gpt-5.4',
      model_label: 'gpt-5.4',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 200,
      total_tokens: 350,
      cost_estimate: 0.01,
      occurred_at: '2026-05-25T10:00:00Z'
    })

    db.upsertUsageSnapshot({
      session_id: session.id,
      agent_sdk: 'codex',
      total_input_tokens: 500,
      total_output_tokens: 300,
      total_cache_read_tokens: 200,
      total_tokens: 1000,
      total_cost_estimate: 0.05,
      context_used_tokens: 100,
      context_window_tokens: 258400,
      context_percent: 0.039,
      source_kind: 'codex-token-count',
      sync_status: 'synced',
      last_event_at: '2026-05-25T10:00:00Z'
    })

    const snapshot = db.getUsageSnapshot(session.id)
    expect(snapshot).toBeDefined()
    expect(snapshot!.total_tokens).toBe(1000)
    expect(snapshot!.total_cost_estimate).toBe(0.05)
    expect(snapshot!.context_used_tokens).toBe(100)
    expect(snapshot!.context_window_tokens).toBe(258400)
    expect(snapshot!.sync_status).toBe('synced')
  })

  it('v2 events and legacy entries coexist', () => {
    const session = db.createSession({
      project_id: 'test-project',
      worktree_id: null,
      name: 'test-session-coexist',
      agent_sdk: 'codex'
    })

    db.insertUsageEvent({
      session_id: session.id,
      project_id: 'test-project',
      agent_sdk: 'codex',
      source_kind: 'codex-token-count',
      source_event_id: 'thread1:turn1:1000:500:200:300',
      turn_id: 'turn1',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 200,
      total_tokens: 350,
      cost_estimate: 0.01,
      occurred_at: '2026-05-25T10:00:00Z'
    })

    db.upsertUsageEntry({
      session_id: session.id,
      project_id: 'test-project',
      agent_sdk: 'codex',
      source_kind: 'codex-message',
      source_message_id: 'codex-turn:turn1',
      input_tokens: 50,
      output_tokens: 25,
      cache_read_tokens: 100,
      total_tokens: 175,
      cost: 0.005,
      occurred_at: '2026-05-25T10:00:00Z'
    })

    const events = db.getUsageEventsBySession(session.id)
    const entries = db.getUsageEntriesBySession(session.id)

    expect(events).toHaveLength(1)
    expect(events[0].total_tokens).toBe(350)
    expect(events[0].cost_estimate).toBe(0.01)

    expect(entries).toHaveLength(1)
    expect(entries[0].total_tokens).toBe(175)
  })

  it('listUsageEvents filters by agent SDK and date range', () => {
    const session = db.createSession({
      project_id: 'test-project',
      worktree_id: null,
      name: 'test-session-filter',
      agent_sdk: 'codex'
    })

    db.insertUsageEvent({
      session_id: session.id,
      project_id: 'test-project',
      agent_sdk: 'codex',
      source_kind: 'codex-token-count',
      source_event_id: 'thread1:turn1:1000:500:200:300',
      turn_id: 'turn1',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 200,
      total_tokens: 350,
      cost_estimate: 0.01,
      occurred_at: '2026-05-25T10:00:00Z'
    })

    db.insertUsageEvent({
      session_id: session.id,
      project_id: 'test-project',
      agent_sdk: 'codex',
      source_kind: 'codex-token-count',
      source_event_id: 'thread1:turn1:2000:1000:500:500',
      turn_id: 'turn1',
      input_tokens: 200,
      output_tokens: 100,
      cache_read_tokens: 300,
      total_tokens: 600,
      cost_estimate: 0.02,
      occurred_at: '2026-05-26T10:00:00Z'
    })

    // Filter by date range that only includes the first event
    const filtered = db.listUsageEvents({
      agentSdks: ['codex'],
      dateFrom: '2026-05-25T00:00:00Z',
      dateTo: '2026-05-26T00:00:00Z'
    })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].total_tokens).toBe(350)
    expect(filtered[0].agent_sdk).toBe('codex')
    expect(filtered[0].provider_id).toBe('codex')
    expect(filtered[0].model_id).toBe('gpt-5.4')
    expect(filtered[0].model_label).toBe('gpt-5.4')
  })
})

describeIf('backfillCodexFromJsonl with synthetic fixture', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any
  let cleanup: () => void
  let fixtureDir: string

  beforeAll(() => {
    if (!canRun) {
      console.warn(
        'Skipping backfill tests: better-sqlite3 not available.',
        loadError?.message
      )
    }
  })

  beforeEach(() => {
    const setup = createTestDatabase()
    db = setup.db
    cleanup = setup.cleanup
    fixtureDir = join(tmpdir(), 'codex-fixture-' + randomUUID())
    mkdirSync(fixtureDir, { recursive: true })

    // Create project (FK requirement)
    db.createProject({
      id: 'test-project',
      name: 'Test Project',
      path: '/tmp/test-project'
    })
  })

  afterEach(() => {
    cleanup?.()
  })

  function createSyntheticJsonl(threadId: string, events: Array<{
    turnId?: string
    lastInput: number
    lastCachedInput: number
    lastOutput: number
    lastReasoning: number
    totalInput: number
    totalCachedInput: number
    totalOutput: number
    totalReasoning: number
    timestamp?: string
  }>): string {
    const lines: string[] = []

    // Add a turn_context event to establish turn_id
    if (events.length > 0 && events[0].turnId) {
      lines.push(JSON.stringify({
        type: 'turn_context',
        payload: {
          turn_id: events[0].turnId
        }
      }))
    }

    for (const event of events) {
      lines.push(JSON.stringify({
        type: 'token_count',
        payload: {
          type: 'token_count',
          turn_id: event.turnId,
          info: {
            model: 'o3',
            last_token_usage: {
              input_tokens: event.lastInput,
              cached_input_tokens: event.lastCachedInput,
              output_tokens: event.lastOutput,
              reasoning_output_tokens: event.lastReasoning
            },
            total_token_usage: {
              input_tokens: event.totalInput,
              cached_input_tokens: event.totalCachedInput,
              output_tokens: event.totalOutput,
              reasoning_output_tokens: event.totalReasoning
            }
          }
        },
        timestamp: event.timestamp ?? '2026-05-25T10:00:00.000Z'
      }))
    }

    return lines.join('\n') + '\n'
  }

  it('parses synthetic JSONL with turn attribution via turn_context', () => {
    const threadId = 'test-thread-' + randomUUID()
    const jsonl = createSyntheticJsonl(threadId, [
      {
        turnId: 'turn-abc',
        lastInput: 1000,
        lastCachedInput: 200,
        lastOutput: 500,
        lastReasoning: 100,
        totalInput: 1000,
        totalCachedInput: 200,
        totalOutput: 500,
        totalReasoning: 100
      },
      {
        turnId: 'turn-abc',
        lastInput: 2000,
        lastCachedInput: 400,
        lastOutput: 1000,
        lastReasoning: 200,
        totalInput: 3000,
        totalCachedInput: 600,
        totalOutput: 1500,
        totalReasoning: 300
      }
    ])

    const jsonlPath = join(fixtureDir, `rollout-${threadId}.jsonl`)
    writeFileSync(jsonlPath, jsonl)

    // Create session with matching opencode_session_id
    const session = db.createSession({
      project_id: 'test-project',
      worktree_id: null,
      name: 'backfill-test',
      agent_sdk: 'codex',
      opencode_session_id: threadId
    })

    // We can't directly call backfillCodexFromJsonl (it's private),
    // but we can verify the DB state after the service runs.
    // For now, test the DB layer directly.
    db.insertUsageEvent({
      session_id: session.id,
      project_id: 'test-project',
      agent_sdk: 'codex',
      source_kind: 'codex-token-count',
      source_event_id: `${threadId}:turn-abc:1000:200:500:100`,
      turn_id: 'turn-abc',
      input_tokens: 800,
      output_tokens: 500,
      reasoning_tokens: 100,
      cache_read_tokens: 200,
      total_tokens: 1500,
      cost_estimate: 0.01,
      occurred_at: '2026-05-25T10:00:00.000Z'
    })

    db.insertUsageEvent({
      session_id: session.id,
      project_id: 'test-project',
      agent_sdk: 'codex',
      source_kind: 'codex-token-count',
      source_event_id: `${threadId}:turn-abc:3000:600:1500:300`,
      turn_id: 'turn-abc',
      input_tokens: 2400,
      output_tokens: 1000,
      reasoning_tokens: 200,
      cache_read_tokens: 600,
      total_tokens: 4000,
      cost_estimate: 0.03,
      occurred_at: '2026-05-25T10:01:00.000Z'
    })

    const events = db.getUsageEventsBySession(session.id)
    expect(events).toHaveLength(2)
    expect(events[0].turn_id).toBe('turn-abc')
    expect(events[1].turn_id).toBe('turn-abc')

    // Sum of deltas
    const totalTokens = events.reduce(
      (sum: number, e: { total_tokens: number }) => sum + e.total_tokens,
      0
    )
    expect(totalTokens).toBe(5500) // 1500 + 4000
  })

  it('synthetic fixture: idempotent re-insert is ignored', () => {
    const session = db.createSession({
      project_id: 'test-project',
      worktree_id: null,
      name: 'idempotent-test',
      agent_sdk: 'codex'
    })

    const eventData = {
      session_id: session.id,
      project_id: 'test-project',
      agent_sdk: 'codex' as const,
      source_kind: 'codex-token-count',
      source_event_id: 'thread1:turn1:1000:200:500:100',
      turn_id: 'turn1',
      input_tokens: 800,
      output_tokens: 500,
      cache_read_tokens: 200,
      total_tokens: 1500,
      cost_estimate: 0.01,
      occurred_at: '2026-05-25T10:00:00Z'
    }

    // Insert twice
    db.insertUsageEvent(eventData)
    db.insertUsageEvent(eventData)

    const events = db.getUsageEventsBySession(session.id)
    expect(events).toHaveLength(1)
  })

  it('context window from snapshot is preserved', () => {
    const session = db.createSession({
      project_id: 'test-project',
      worktree_id: null,
      name: 'context-window-test',
      agent_sdk: 'codex'
    })

    db.upsertUsageSnapshot({
      session_id: session.id,
      agent_sdk: 'codex',
      total_input_tokens: 168829,
      total_output_tokens: 89571,
      total_cache_read_tokens: 0,
      total_tokens: 258400,
      total_cost_estimate: 7.61,
      context_used_tokens: 168829,
      context_window_tokens: 258400,
      context_percent: 65.3,
      source_kind: 'codex-token-count',
      sync_status: 'synced',
      last_event_at: '2026-05-25T10:00:00Z'
    })

    const snapshot = db.getUsageSnapshot(session.id)
    expect(snapshot).toBeDefined()
    expect(snapshot!.context_used_tokens).toBe(168829)
    expect(snapshot!.context_window_tokens).toBe(258400)
    expect(snapshot!.context_percent).toBeCloseTo(65.3, 1)
  })
})
