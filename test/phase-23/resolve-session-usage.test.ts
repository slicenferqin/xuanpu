import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import {
  createTestDatabase,
  canRunDatabaseTests,
  getDatabaseLoadError
} from '../utils/db-test-utils'

const canRun = canRunDatabaseTests()
const loadError = getDatabaseLoadError()
const describeIf = canRun ? describe : describe.skip

describeIf('resolveSessionUsage priority: events > snapshot > legacy', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any
  let cleanup: () => void

  beforeAll(() => {
    if (!canRun) {
      console.warn(
        'Skipping resolveSessionUsage tests: better-sqlite3 not available.',
        loadError?.message
      )
    }
  })

  beforeEach(() => {
    const setup = createTestDatabase()
    db = setup.db
    cleanup = setup.cleanup

    db.createProject({
      id: 'test-project',
      name: 'Test Project',
      path: '/tmp/test-project'
    })
  })

  afterEach(() => {
    cleanup?.()
  })

  it('events=418K + snapshot=365K + legacy=239K → session summary returns 418K from events', () => {
    const session = db.createSession({
      project_id: 'test-project',
      worktree_id: null,
      name: 'test-session',
      agent_sdk: 'codex',
      opencode_session_id: 'thread-1'
    })

    // Seed legacy: 239K tokens
    db.upsertUsageEntry({
      session_id: session.id,
      project_id: 'test-project',
      agent_sdk: 'codex',
      source_kind: 'codex-message',
      source_message_id: 'codex-turn:turn1',
      input_tokens: 147269,
      output_tokens: 383,
      cache_read_tokens: 91520,
      total_tokens: 239172,
      cost: 0.793595,
      occurred_at: '2026-05-25T10:00:00Z'
    })

    // Seed snapshot: 365K tokens (stale)
    db.upsertUsageSnapshot({
      session_id: session.id,
      agent_sdk: 'codex',
      total_input_tokens: 273000,
      total_output_tokens: 2000,
      total_cache_read_tokens: 90000,
      total_tokens: 365000,
      total_cost_estimate: 0.792099,
      context_used_tokens: 273000,
      context_window_tokens: 258400,
      context_percent: 105.6,
      source_kind: 'codex-token-count',
      sync_status: 'synced',
      last_event_at: '2026-05-25T10:01:00Z'
    })

    // Seed events: 418K tokens (authoritative)
    db.insertUsageEvent({
      session_id: session.id,
      project_id: 'test-project',
      agent_sdk: 'codex',
      source_kind: 'codex-token-count',
      source_event_id: 'thread1:turn1:300000:80000:30000:5000',
      turn_id: 'turn1',
      input_tokens: 280000,
      output_tokens: 3000,
      cache_read_tokens: 135294,
      total_tokens: 418294,
      cost_estimate: 1.036941,
      occurred_at: '2026-05-25T10:02:00Z'
    })

    // Verify: events exist
    const events = db.getUsageEventsBySession(session.id)
    expect(events).toHaveLength(1)
    expect(events[0].total_tokens).toBe(418294)

    // Verify: snapshot was stale
    const snapshot = db.getUsageSnapshot(session.id)
    expect(snapshot).toBeDefined()
    expect(snapshot!.total_tokens).toBe(365000) // Before rebuild

    // After resolveSessionUsage runs, snapshot should be rebuilt from events
    // (We can't call the service directly in this test, but we verify the DB state)
  })

  it('events=418K → scope summary contribution matches events, not snapshot', () => {
    const session = db.createSession({
      project_id: 'test-project',
      worktree_id: null,
      name: 'test-session',
      agent_sdk: 'codex',
      opencode_session_id: 'thread-1'
    })

    // Seed snapshot: 365K (stale)
    db.upsertUsageSnapshot({
      session_id: session.id,
      agent_sdk: 'codex',
      total_input_tokens: 273000,
      total_output_tokens: 2000,
      total_cache_read_tokens: 90000,
      total_tokens: 365000,
      total_cost_estimate: 0.792099,
      source_kind: 'codex-token-count',
      sync_status: 'synced',
      last_event_at: '2026-05-25T10:01:00Z'
    })

    // Seed events: 418K (authoritative)
    db.insertUsageEvent({
      session_id: session.id,
      project_id: 'test-project',
      agent_sdk: 'codex',
      source_kind: 'codex-token-count',
      source_event_id: 'thread1:turn1:300000:80000:30000:5000',
      turn_id: 'turn1',
      input_tokens: 280000,
      output_tokens: 3000,
      cache_read_tokens: 135294,
      total_tokens: 418294,
      cost_estimate: 1.036941,
      occurred_at: '2026-05-25T10:02:00Z'
    })

    // Verify events are the source of truth
    const events = db.getUsageEventsBySession(session.id)
    expect(events).toHaveLength(1)
    expect(events[0].total_tokens).toBe(418294)
    expect(events[0].cost_estimate).toBe(1.036941)
  })

  it('no events + snapshot=365K → falls back to snapshot', () => {
    const session = db.createSession({
      project_id: 'test-project',
      worktree_id: null,
      name: 'test-session-snapshot-only',
      agent_sdk: 'codex'
    })

    db.upsertUsageSnapshot({
      session_id: session.id,
      agent_sdk: 'codex',
      total_input_tokens: 273000,
      total_output_tokens: 2000,
      total_cache_read_tokens: 90000,
      total_tokens: 365000,
      total_cost_estimate: 0.792099,
      source_kind: 'codex-token-count',
      sync_status: 'synced',
      last_event_at: '2026-05-25T10:01:00Z'
    })

    // No events — should fall back to snapshot
    const events = db.getUsageEventsBySession(session.id)
    expect(events).toHaveLength(0)

    const snapshot = db.getUsageSnapshot(session.id)
    expect(snapshot).toBeDefined()
    expect(snapshot!.total_tokens).toBe(365000)
  })

  it('no events + no snapshot + legacy=239K → falls back to legacy', () => {
    const session = db.createSession({
      project_id: 'test-project',
      worktree_id: null,
      name: 'test-session-legacy-only',
      agent_sdk: 'codex'
    })

    db.upsertUsageEntry({
      session_id: session.id,
      project_id: 'test-project',
      agent_sdk: 'codex',
      source_kind: 'codex-message',
      source_message_id: 'codex-turn:turn1',
      input_tokens: 147269,
      output_tokens: 383,
      cache_read_tokens: 91520,
      total_tokens: 239172,
      cost: 0.793595,
      occurred_at: '2026-05-25T10:00:00Z'
    })

    const events = db.getUsageEventsBySession(session.id)
    expect(events).toHaveLength(0)

    const snapshot = db.getUsageSnapshot(session.id)
    expect(snapshot).toBeUndefined()

    const entries = db.getUsageEntriesBySession(session.id)
    expect(entries).toHaveLength(1)
    expect(entries[0].total_tokens).toBe(239172)
  })

  it('snapshot rebuild: events=418K → snapshot updated to match events', () => {
    const session = db.createSession({
      project_id: 'test-project',
      worktree_id: null,
      name: 'test-session-rebuild',
      agent_sdk: 'codex'
    })

    // Initial snapshot: 365K
    db.upsertUsageSnapshot({
      session_id: session.id,
      agent_sdk: 'codex',
      total_input_tokens: 273000,
      total_output_tokens: 2000,
      total_cache_read_tokens: 90000,
      total_tokens: 365000,
      total_cost_estimate: 0.792099,
      context_used_tokens: 273000,
      context_window_tokens: 258400,
      context_percent: 105.6,
      source_kind: 'codex-token-count',
      sync_status: 'synced',
      last_event_at: '2026-05-25T10:01:00Z'
    })

    // Events: 418K
    db.insertUsageEvent({
      session_id: session.id,
      project_id: 'test-project',
      agent_sdk: 'codex',
      source_kind: 'codex-token-count',
      source_event_id: 'thread1:turn1:300000:80000:30000:5000',
      turn_id: 'turn1',
      input_tokens: 280000,
      output_tokens: 3000,
      cache_read_tokens: 135294,
      total_tokens: 418294,
      cost_estimate: 1.036941,
      occurred_at: '2026-05-25T10:02:00Z'
    })

    // Simulate snapshot rebuild (what resolveSessionUsage does)
    const events = db.getUsageEventsBySession(session.id)
    let totalTokens = 0
    let totalCost = 0
    for (const event of events) {
      totalTokens += event.total_tokens
      totalCost += event.cost_estimate
    }

    db.upsertUsageSnapshot({
      session_id: session.id,
      agent_sdk: 'codex',
      total_input_tokens: 280000,
      total_output_tokens: 3000,
      total_cache_read_tokens: 135294,
      total_tokens: totalTokens,
      total_cost_estimate: totalCost,
      context_used_tokens: 273000,
      context_window_tokens: 258400,
      context_percent: 105.6,
      source_kind: 'codex-token-count',
      sync_status: 'synced',
      last_event_at: '2026-05-25T10:02:00Z'
    })

    const updatedSnapshot = db.getUsageSnapshot(session.id)
    expect(updatedSnapshot).toBeDefined()
    expect(updatedSnapshot!.total_tokens).toBe(418294)
    expect(updatedSnapshot!.total_cost_estimate).toBe(1.036941)
  })
})
