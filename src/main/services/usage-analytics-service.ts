import type { DatabaseService } from '../db/database'
import type { Session } from '../db/types'
import { readClaudeTranscriptUsage } from './claude-transcript-reader'
import { createLogger } from './logger'
import { resolvePricingModelKey, calculateUsageCost } from '@shared/usage/pricing'
import { getCanonicalModelLabel } from '@shared/usage/models'
import { resolveCodexModelSlug } from './codex-models'
import type {
  UsageAnalyticsDashboard,
  UsageAnalyticsDashboardResult,
  UsageAnalyticsEngine,
  UsageAnalyticsEngineFilter,
  UsageAnalyticsFilters,
  UsageAnalyticsPartialSession,
  UsageAnalyticsResyncResult,
  UsageAnalyticsSessionRow,
  UsageAnalyticsSessionStatusFilter,
  UsageAnalyticsSessionSummary,
  UsageAnalyticsSessionSummaryResult,
  UsageAnalyticsTimelineRow
} from '@shared/types/usage-analytics'
import { getDatabase } from '../db'

const log = createLogger({ component: 'UsageAnalyticsService' })

type SupportedSession = Session & {
  project_name: string
  project_path: string
  worktree_name: string | null
  worktree_path: string | null
  worktree_status: 'active' | 'archived' | null
}

interface SessionSyncSnapshot {
  stale: boolean
  partial: boolean
  reason?: UsageAnalyticsPartialSession['reason']
  detail?: string
}

interface BackfillResult {
  sourceFound: boolean
  parsedEventCount: number
  insertedEventCount: number
  sourceMtimeMs: number | null
  error: string | null
}

interface SessionUsageTotals {
  totalCost: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  lastUsedAt: string | null
  modelLabels: string[]
  latestModelLabel: string | null
  contextUsedTokens: number | null
  contextWindowTokens: number | null
  contextPercent: number | null
  source: 'events' | 'snapshot' | 'legacy' | 'none'
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function toRangeBounds(range: UsageAnalyticsFilters['range']): {
  dateFrom: string | null
  dateTo: string | null
} {
  if (range === 'all') {
    return { dateFrom: null, dateTo: null }
  }

  const today = startOfLocalDay(new Date())

  if (range === 'today') {
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    return {
      dateFrom: today.toISOString(),
      dateTo: tomorrow.toISOString()
    }
  }

  const days = range === '7d' ? 6 : 29
  const dateFrom = new Date(today)
  dateFrom.setDate(dateFrom.getDate() - days)

  const dateTo = new Date(today)
  dateTo.setDate(dateTo.getDate() + 1)

  return {
    dateFrom: dateFrom.toISOString(),
    dateTo: dateTo.toISOString()
  }
}

function toSupportedAgentSdks(filter: UsageAnalyticsEngineFilter): UsageAnalyticsEngine[] {
  return filter === 'all' ? ['claude-code', 'codex'] : [filter]
}

function appendUnique(target: string[], value: string | null | undefined): void {
  if (!value) return
  if (!target.includes(value)) target.push(value)
}

function getEntryModelLabel(entry: {
  agent_sdk: UsageAnalyticsEngine
  model_id: string | null
  model_label: string | null
  provider_id: string | null
}): string {
  return (
    getCanonicalModelLabel(
      entry.model_id ?? entry.model_label,
      entry.provider_id ?? entry.agent_sdk
    ) ??
    entry.model_label ??
    entry.model_id ??
    'Unknown'
  )
}

export class UsageAnalyticsService {
  constructor(private readonly db: DatabaseService) {}

  async fetchDashboard(filters: UsageAnalyticsFilters): Promise<UsageAnalyticsDashboardResult> {
    try {
      const sessionStatus: UsageAnalyticsSessionStatusFilter = filters.sessionStatus ?? 'all'
      const sessions = this.db.getUsageAnalyticsSessions(['claude-code', 'codex'], sessionStatus)
      const syncStates = new Map(
        this.db.getUsageSyncStates().map((state) => [state.session_id, state] as const)
      )
      const engines = toSupportedAgentSdks(filters.engine)
      const { dateFrom, dateTo } = toRangeBounds(filters.range)

      // Prefer v2 events; fall back to legacy entries per session
      const v2Events = this.db.listUsageEvents({ agentSdks: engines, dateFrom, dateTo })
      const legacyEntries = this.db.listUsageEntries({ agentSdks: engines, dateFrom, dateTo })

      // Build set of sessions that have v2 data
      const sessionsWithV2 = new Set(v2Events.map((e) => e.session_id))

      const sessionMap = new Map(sessions.map((session) => [session.id, session] as const))

      const totals = {
        cost: 0,
        tokens: 0,
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0
      }

      const engineMap = new Map<
        UsageAnalyticsEngine,
        { total_cost: number; total_tokens: number; sessionIds: Set<string> }
      >()
      const modelMap = new Map<
        string,
        {
          engine: UsageAnalyticsEngine
          model_key: string
          model_label: string
          total_cost: number
          total_tokens: number
          input_tokens: number
          output_tokens: number
          cache_write_tokens: number
          cache_read_tokens: number
          sessionIds: Set<string>
        }
      >()
      const projectMap = new Map<
        string,
        {
          engine: UsageAnalyticsEngine | 'all'
          project_id: string
          project_name: string
          project_path: string
          total_cost: number
          total_tokens: number
          sessionIds: Set<string>
          last_used_at: string
        }
      >()
      const sessionRows = new Map<
        string,
        UsageAnalyticsSessionRow & {
          sessionIds?: Set<string>
        }
      >()
      const timelineMap = new Map<string, UsageAnalyticsTimelineRow & { sessionIds: Set<string> }>()

      // Helper to accumulate a single data point into aggregates
      const accumulateEntry = (params: {
        sessionId: string
        agentSdk: UsageAnalyticsEngine
        modelId: string | null
        modelLabel: string | null
        providerId: string | null
        cost: number
        totalTokens: number
        inputTokens: number
        outputTokens: number
        cacheWriteTokens: number
        cacheReadTokens: number
        occurredAt: string
      }): void => {
        const session = sessionMap.get(params.sessionId)
        if (!session || !engines.includes(params.agentSdk)) return

        const canonicalModelKey = resolvePricingModelKey(
          params.modelId ?? params.modelLabel ?? 'unknown',
          params.providerId ?? params.agentSdk
        )
        const canonicalModelLabel = getCanonicalModelLabel(
          params.modelId ?? params.modelLabel,
          params.providerId ?? params.agentSdk
        ) ?? params.modelLabel ?? params.modelId ?? 'Unknown'

        totals.cost += params.cost
        totals.tokens += params.totalTokens
        totals.input += params.inputTokens
        totals.output += params.outputTokens
        totals.cacheWrite += params.cacheWriteTokens
        totals.cacheRead += params.cacheReadTokens

        const engineBucket = engineMap.get(params.agentSdk) ?? {
          total_cost: 0,
          total_tokens: 0,
          sessionIds: new Set<string>()
        }
        engineBucket.total_cost += params.cost
        engineBucket.total_tokens += params.totalTokens
        engineBucket.sessionIds.add(params.sessionId)
        engineMap.set(params.agentSdk, engineBucket)

        const modelKey = `${params.agentSdk}::${canonicalModelKey}`
        const modelBucket = modelMap.get(modelKey) ?? {
          engine: params.agentSdk,
          model_key: canonicalModelKey,
          model_label: canonicalModelLabel,
          total_cost: 0,
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_write_tokens: 0,
          cache_read_tokens: 0,
          sessionIds: new Set<string>()
        }
        modelBucket.total_cost += params.cost
        modelBucket.total_tokens += params.totalTokens
        modelBucket.input_tokens += params.inputTokens
        modelBucket.output_tokens += params.outputTokens
        modelBucket.cache_write_tokens += params.cacheWriteTokens
        modelBucket.cache_read_tokens += params.cacheReadTokens
        modelBucket.sessionIds.add(params.sessionId)
        modelMap.set(modelKey, modelBucket)

        const projectKey =
          filters.engine === 'all'
            ? session.project_id
            : `${params.agentSdk}::${session.project_id}`
        const projectBucket = projectMap.get(projectKey) ?? {
          engine: filters.engine === 'all' ? 'all' : params.agentSdk,
          project_id: session.project_id,
          project_name: session.project_name,
          project_path: session.project_path,
          total_cost: 0,
          total_tokens: 0,
          sessionIds: new Set<string>(),
          last_used_at: params.occurredAt
        }
        projectBucket.total_cost += params.cost
        projectBucket.total_tokens += params.totalTokens
        projectBucket.sessionIds.add(params.sessionId)
        if (params.occurredAt > projectBucket.last_used_at) {
          projectBucket.last_used_at = params.occurredAt
        }
        projectMap.set(projectKey, projectBucket)

        const sessionBucket = sessionRows.get(params.sessionId) ?? {
          session_id: params.sessionId,
          session_name: session.name ?? 'Untitled',
          engine: params.agentSdk,
          project_id: session.project_id,
          project_name: session.project_name,
          project_path: session.project_path,
          worktree_name: session.worktree_name,
          model_label: canonicalModelLabel,
          model_labels: [],
          total_cost: 0,
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_write_tokens: 0,
          cache_read_tokens: 0,
          last_used_at: params.occurredAt,
          started_at: session.created_at,
          updated_at: session.updated_at
        }
        sessionBucket.total_cost += params.cost
        sessionBucket.total_tokens += params.totalTokens
        sessionBucket.input_tokens += params.inputTokens
        sessionBucket.output_tokens += params.outputTokens
        sessionBucket.cache_write_tokens += params.cacheWriteTokens
        sessionBucket.cache_read_tokens += params.cacheReadTokens
        sessionBucket.model_label = canonicalModelLabel
        appendUnique(sessionBucket.model_labels, canonicalModelLabel)
        if (params.occurredAt > sessionBucket.last_used_at) {
          sessionBucket.last_used_at = params.occurredAt
        }
        sessionRows.set(params.sessionId, sessionBucket)

        const dateKey = formatDateKey(new Date(params.occurredAt))
        const timelineBucket = timelineMap.get(dateKey) ?? {
          date: dateKey,
          total_cost: 0,
          total_tokens: 0,
          total_sessions: 0,
          sessionIds: new Set<string>()
        }
        timelineBucket.total_cost += params.cost
        timelineBucket.total_tokens += params.totalTokens
        timelineBucket.sessionIds.add(params.sessionId)
        timelineBucket.total_sessions = timelineBucket.sessionIds.size
        timelineMap.set(dateKey, timelineBucket)
      }

      // Accumulate v2 events (preferred source)
      for (const event of v2Events) {
        accumulateEntry({
          sessionId: event.session_id,
          agentSdk: 'codex', // v2 events are currently only codex
          modelId: null, // resolved from session below
          modelLabel: null,
          providerId: 'codex',
          cost: event.cost_estimate,
          totalTokens: event.total_tokens,
          inputTokens: event.input_tokens,
          outputTokens: event.output_tokens,
          cacheWriteTokens: event.cache_write_tokens,
          cacheReadTokens: event.cache_read_tokens,
          occurredAt: event.occurred_at
        })
      }

      // Accumulate legacy entries ONLY for sessions without v2 data
      for (const entry of legacyEntries) {
        if (sessionsWithV2.has(entry.session_id)) continue // v2 takes priority
        accumulateEntry({
          sessionId: entry.session_id,
          agentSdk: entry.agent_sdk,
          modelId: entry.model_id,
          modelLabel: entry.model_label,
          providerId: entry.provider_id,
          cost: entry.cost,
          totalTokens: entry.total_tokens,
          inputTokens: entry.input_tokens,
          outputTokens: entry.output_tokens,
          cacheWriteTokens: entry.cache_write_tokens,
          cacheReadTokens: entry.cache_read_tokens,
          occurredAt: entry.occurred_at
        })
      }

      const partialSessions: UsageAnalyticsPartialSession[] = []
      let staleCount = 0

      for (const session of sessions) {
        if (!engines.includes(session.agent_sdk as UsageAnalyticsEngine)) continue
        const snapshot = this.getSessionSyncSnapshot(session, syncStates.get(session.id))
        if (snapshot.stale) staleCount += 1
        if (snapshot.partial && snapshot.reason) {
          partialSessions.push({
            session_id: session.id,
            session_name: session.name ?? 'Untitled',
            engine: session.agent_sdk as UsageAnalyticsEngine,
            reason: snapshot.reason,
            ...(snapshot.detail ? { detail: snapshot.detail } : {})
          })
        }
      }

      const lastResyncedAt =
        this.db
          .getUsageSyncStates()
          .map((state) => state.last_synced_at)
          .filter((value): value is string => !!value)
          .sort((a, b) => b.localeCompare(a))[0] ?? null

      const dashboard: UsageAnalyticsDashboard = {
        filters,
        generated_at: new Date().toISOString(),
        total_cost: totals.cost,
        total_tokens: totals.tokens,
        total_sessions: sessionRows.size,
        total_input_tokens: totals.input,
        total_output_tokens: totals.output,
        total_cache_write_tokens: totals.cacheWrite,
        total_cache_read_tokens: totals.cacheRead,
        by_engine: engines.map((engine) => {
          const bucket = engineMap.get(engine)
          return {
            engine,
            total_cost: bucket?.total_cost ?? 0,
            total_tokens: bucket?.total_tokens ?? 0,
            total_sessions: bucket?.sessionIds.size ?? 0
          }
        }),
        by_model: Array.from(modelMap.values())
          .map((bucket) => ({
            engine: bucket.engine,
            model_key: bucket.model_key,
            model_label: bucket.model_label,
            total_cost: bucket.total_cost,
            total_tokens: bucket.total_tokens,
            input_tokens: bucket.input_tokens,
            output_tokens: bucket.output_tokens,
            cache_write_tokens: bucket.cache_write_tokens,
            cache_read_tokens: bucket.cache_read_tokens,
            session_count: bucket.sessionIds.size
          }))
          .sort((a, b) => b.total_cost - a.total_cost),
        by_project: Array.from(projectMap.values())
          .map((bucket) => ({
            engine: bucket.engine,
            project_id: bucket.project_id,
            project_name: bucket.project_name,
            project_path: bucket.project_path,
            total_cost: bucket.total_cost,
            total_tokens: bucket.total_tokens,
            session_count: bucket.sessionIds.size,
            last_used_at: bucket.last_used_at
          }))
          .sort((a, b) => b.total_cost - a.total_cost),
        sessions: Array.from(sessionRows.values()).sort((a, b) =>
          b.last_used_at.localeCompare(a.last_used_at)
        ),
        timeline: Array.from(timelineMap.values())
          .map(({ sessionIds: _sessionIds, ...bucket }) => bucket)
          .sort((a, b) => a.date.localeCompare(b.date)),
        partial_sessions: partialSessions.sort((a, b) =>
          a.session_name.localeCompare(b.session_name)
        ),
        sync: {
          stale_session_count: staleCount,
          partial_session_count: partialSessions.length,
          supported_session_count: sessions.filter((session) =>
            engines.includes(session.agent_sdk as UsageAnalyticsEngine)
          ).length,
          last_resynced_at: lastResyncedAt
        }
      }

      return { success: true, data: dashboard }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('Failed to fetch usage dashboard', { error: message })
      return { success: false, error: message }
    }
  }

  /**
   * Unified session usage resolver. Both fetchSessionSummary and fetchScopeSummary
   * MUST use this to ensure consistent data.
   *
   * Priority:
   *   1. v2 usage_events — aggregate tokens/cost from the event-keyed ledger
   *   2. session_usage_snapshots — used ONLY for context/model metadata, or as
   *      fallback for totals when events are empty
   *   3. legacy usage_entries — final fallback
   *
   * This prevents the scope showing stale snapshot totals while the session
   * summary shows fresh event totals.
   */
  private resolveSessionUsage(sessionId: string): SessionUsageTotals {
    const events = this.db.getUsageEventsBySession(sessionId)
    const snapshot = this.db.getUsageSnapshot(sessionId)

    if (events.length > 0) {
      // Events are the authoritative source for totals
      let totalCost = 0
      let totalTokens = 0
      let inputTokens = 0
      let outputTokens = 0
      let cacheWriteTokens = 0
      let cacheReadTokens = 0
      let lastUsedAt: string | null = null
      const modelLabels: string[] = []

      for (const event of events) {
        totalCost += event.cost_estimate
        totalTokens += event.total_tokens
        inputTokens += event.input_tokens
        outputTokens += event.output_tokens
        cacheWriteTokens += event.cache_write_tokens
        cacheReadTokens += event.cache_read_tokens
        if (!lastUsedAt || event.occurred_at > lastUsedAt) {
          lastUsedAt = event.occurred_at
        }
      }

      // Model label from snapshot (metadata, not totals)
      if (snapshot?.model_label) {
        appendUnique(modelLabels, snapshot.model_label)
      }

      return {
        totalCost,
        totalTokens,
        inputTokens,
        outputTokens,
        cacheWriteTokens,
        cacheReadTokens,
        lastUsedAt,
        modelLabels,
        latestModelLabel: modelLabels[modelLabels.length - 1] ?? null,
        // Context from snapshot (events don't carry context info)
        contextUsedTokens: snapshot?.context_used_tokens ?? null,
        contextWindowTokens: snapshot?.context_window_tokens ?? null,
        contextPercent: snapshot?.context_percent ?? null,
        source: 'events'
      }
    }

    // Fallback: snapshot totals (when events don't exist yet)
    if (snapshot) {
      return {
        totalCost: snapshot.total_cost_estimate,
        totalTokens: snapshot.total_tokens,
        inputTokens: snapshot.total_input_tokens,
        outputTokens: snapshot.total_output_tokens,
        cacheWriteTokens: snapshot.total_cache_write_tokens,
        cacheReadTokens: snapshot.total_cache_read_tokens,
        lastUsedAt: snapshot.last_event_at,
        modelLabels: snapshot.model_label ? [snapshot.model_label] : [],
        latestModelLabel: snapshot.model_label ?? null,
        contextUsedTokens: snapshot.context_used_tokens ?? null,
        contextWindowTokens: snapshot.context_window_tokens ?? null,
        contextPercent: snapshot.context_percent ?? null,
        source: 'snapshot'
      }
    }

    // Final fallback: legacy usage_entries
    const entries = this.db.getUsageEntriesBySession(sessionId)
    if (entries.length > 0) {
      let totalCost = 0
      let totalTokens = 0
      let inputTokens = 0
      let outputTokens = 0
      let cacheWriteTokens = 0
      let cacheReadTokens = 0
      const modelLabels: string[] = []

      for (const entry of entries) {
        totalCost += entry.cost
        totalTokens += entry.total_tokens
        inputTokens += entry.input_tokens
        outputTokens += entry.output_tokens
        cacheWriteTokens += entry.cache_write_tokens
        cacheReadTokens += entry.cache_read_tokens
        appendUnique(modelLabels, getEntryModelLabel(entry))
      }

      const sorted = [...entries].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
      return {
        totalCost,
        totalTokens,
        inputTokens,
        outputTokens,
        cacheWriteTokens,
        cacheReadTokens,
        lastUsedAt: sorted[sorted.length - 1]?.occurred_at ?? null,
        modelLabels,
        latestModelLabel: modelLabels[modelLabels.length - 1] ?? null,
        contextUsedTokens: null,
        contextWindowTokens: null,
        contextPercent: null,
        source: 'legacy'
      }
    }

    return {
      totalCost: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      lastUsedAt: null,
      modelLabels: [],
      latestModelLabel: null,
      contextUsedTokens: null,
      contextWindowTokens: null,
      contextPercent: null,
      source: 'none'
    }
  }

  async fetchSessionSummary(sessionId: string): Promise<UsageAnalyticsSessionSummaryResult> {
    try {
      const session = this.db
        .getUsageAnalyticsSessions(['claude-code', 'codex'], 'all')
        .find((item) => item.id === sessionId)

      if (!session) {
        return { success: false, error: 'Session not found or unsupported' }
      }

      await this.syncSession(session, true)

      const usage = this.resolveSessionUsage(sessionId)
      const syncState = this.db.getUsageSyncState(sessionId)
      const isPartialStatus = syncState?.status === 'partial'
        || syncState?.status === 'error'
        || syncState?.status === 'missing-source'
        || syncState?.status === 'legacy-undercounted'

      const endAt = usage.lastUsedAt ?? session.updated_at
      const summary: UsageAnalyticsSessionSummary = {
        session_id: sessionId,
        engine: session.agent_sdk as UsageAnalyticsEngine,
        total_cost: usage.totalCost,
        total_tokens: usage.totalTokens,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_write_tokens: usage.cacheWriteTokens,
        cache_read_tokens: usage.cacheReadTokens,
        duration_seconds: Math.max(
          0,
          Math.round((new Date(endAt).getTime() - new Date(session.created_at).getTime()) / 1000)
        ),
        last_used_at: usage.lastUsedAt,
        model_labels: usage.modelLabels,
        latest_model_label: usage.latestModelLabel,
        partial: isPartialStatus,
        context_used_tokens: usage.contextUsedTokens,
        context_window_tokens: usage.contextWindowTokens,
        context_percent: usage.contextPercent
      }

      return { success: true, data: summary }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('Failed to fetch session usage summary', { sessionId, error: message })
      return { success: false, error: message }
    }
  }

  async resync(): Promise<UsageAnalyticsResyncResult> {
    const sessions = this.db.getUsageAnalyticsSessions(['claude-code', 'codex'], 'all')
    const syncStates = new Map(
      this.db.getUsageSyncStates().map((state) => [state.session_id, state] as const)
    )

    const staleSessions = sessions.filter(
      (session) => this.getSessionSyncSnapshot(session, syncStates.get(session.id)).stale
    )

    const syncedSessionIds: string[] = []
    const partialSessionIds: string[] = []

    for (const session of staleSessions) {
      const result = await this.syncSession(session, false)
      if (result === 'partial') {
        partialSessionIds.push(session.id)
      } else if (result === 'synced') {
        syncedSessionIds.push(session.id)
      }
    }

    return {
      success: true,
      synced_session_ids: syncedSessionIds,
      partial_session_ids: partialSessionIds
    }
  }

  async fetchScopeSummary(
    scopeId: string,
    scopeType: 'worktree' | 'connection',
    sessionIds: string[]
  ): Promise<import('@shared/types/usage-analytics').UsageAnalyticsScopeSummaryResult> {
    try {
      const sessions = this.db.getUsageAnalyticsSessions(['claude-code', 'codex'], 'all')
      const sessionMap = new Map(sessions.map((s) => [s.id, s] as const))

      // Sync supported sessions before aggregating (like fetchSessionSummary does)
      for (const sessionId of sessionIds) {
        const session = sessionMap.get(sessionId)
        if (session) {
          try {
            await this.syncSession(session, false)
          } catch {
            // Non-fatal — we'll use whatever data is available
          }
        }
      }

      const syncStates = new Map(
        this.db.getUsageSyncStates().map((state) => [state.session_id, state] as const)
      )

      const coverage = {
        synced: 0,
        partial: 0,
        legacy_undercounted: 0,
        missing_source: 0,
        unsupported: 0
      }

      let totalCost = 0
      let totalTokens = 0
      let inputTokens = 0
      let outputTokens = 0
      let cacheWriteTokens = 0
      let cacheReadTokens = 0
      let contextUsedTokens: number | null = null
      let contextWindowTokens: number | null = null
      let contextPercent: number | null = null
      const partialSessions: import('@shared/types/usage-analytics').UsageAnalyticsPartialSession[] = []
      const seenSessionIds = new Set<string>()
      // Per-session contributions for renderer live overlay
      const sessionContributions = new Map<string, {
        totalCost: number
        totalTokens: number
        inputTokens: number
        outputTokens: number
        cacheWriteTokens: number
        cacheReadTokens: number
      }>()

      for (const sessionId of sessionIds) {
        if (seenSessionIds.has(sessionId)) continue
        seenSessionIds.add(sessionId)

        const session = sessionMap.get(sessionId)
        if (!session) {
          coverage.unsupported++
          continue
        }

        const syncState = syncStates.get(sessionId)
        const syncStatus = syncState?.status ?? 'unknown'

        // Coverage accounting
        if (syncStatus === 'synced') {
          coverage.synced++
        } else if (syncStatus === 'legacy-undercounted') {
          coverage.legacy_undercounted++
        } else if (syncStatus === 'partial' || syncStatus === 'missing-source') {
          coverage.partial++
        } else if (syncStatus === 'error') {
          coverage.partial++
        } else {
          coverage.missing_source++
        }

        // Partial session detail
        const syncSnapshot = this.getSessionSyncSnapshot(session, syncState)
        if (syncSnapshot.partial && syncSnapshot.reason) {
          partialSessions.push({
            session_id: sessionId,
            session_name: session.name ?? 'Untitled',
            engine: session.agent_sdk as import('@shared/types/usage-analytics').UsageAnalyticsEngine,
            reason: syncSnapshot.reason,
            ...(syncSnapshot.detail ? { detail: syncSnapshot.detail } : {})
          })
        }

        // Use unified resolver — same as fetchSessionSummary
        const usage = this.resolveSessionUsage(sessionId)

        totalCost += usage.totalCost
        totalTokens += usage.totalTokens
        inputTokens += usage.inputTokens
        outputTokens += usage.outputTokens
        cacheWriteTokens += usage.cacheWriteTokens
        cacheReadTokens += usage.cacheReadTokens

        sessionContributions.set(sessionId, {
          totalCost: usage.totalCost,
          totalTokens: usage.totalTokens,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          cacheReadTokens: usage.cacheReadTokens
        })

        // Context: use the highest context window, sum used (only for active sessions)
        if (usage.contextWindowTokens && usage.contextWindowTokens > 0) {
          contextUsedTokens = (contextUsedTokens ?? 0) + (usage.contextUsedTokens ?? 0)
          contextWindowTokens = Math.max(contextWindowTokens ?? 0, usage.contextWindowTokens)
        }
      }

      if (contextUsedTokens !== null && contextWindowTokens !== null && contextWindowTokens > 0) {
        contextPercent = (contextUsedTokens / contextWindowTokens) * 100
      }

      return {
        success: true,
        data: {
          scope_id: scopeId,
          scope_type: scopeType,
          session_count: seenSessionIds.size,
          active_session_count: sessionIds.filter((id) => {
            const s = sessionMap.get(id)
            return s?.status === 'active'
          }).length,
          total_cost: totalCost,
          total_tokens: totalTokens,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_write_tokens: cacheWriteTokens,
          cache_read_tokens: cacheReadTokens,
          context_used_tokens: contextUsedTokens,
          context_window_tokens: contextWindowTokens,
          context_percent: contextPercent,
          coverage,
          partial_sessions: partialSessions,
          session_contributions: Object.fromEntries(sessionContributions)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('Failed to fetch scope summary', { scopeId, scopeType, error: message })
      return { success: false, error: message }
    }
  }

  private getSessionSyncSnapshot(
    session: SupportedSession,
    syncState: ReturnType<DatabaseService['getUsageSyncState']> | undefined
  ): SessionSyncSnapshot {
    if (session.agent_sdk === 'claude-code') {
      if (!session.worktree_path) {
        return {
          stale: false,
          partial: true,
          reason: 'missing-worktree',
          detail: 'Session no longer has a worktree path for transcript lookup.'
        }
      }

      if (!session.opencode_session_id) {
        return {
          stale: false,
          partial: true,
          reason: 'missing-source',
          detail: 'Session does not have a Claude transcript id.'
        }
      }
    }

    if (!syncState) {
      return { stale: true, partial: false }
    }

    if (syncState.status === 'partial' || syncState.status === 'missing-source') {
      return {
        stale: false,
        partial: true,
        reason: 'missing-source',
        detail: syncState.last_error ?? 'Source data is incomplete.'
      }
    }

    if (syncState.status === 'legacy-undercounted') {
      return {
        stale: false,
        partial: true,
        reason: 'missing-source',
        detail: syncState.last_error ?? 'Only legacy undercounted data available.'
      }
    }

    if (syncState.status === 'error') {
      return {
        stale: false,
        partial: true,
        reason: 'sync-error',
        detail: syncState.last_error ?? 'Analytics sync failed.'
      }
    }

    if (!syncState.last_synced_at) {
      return { stale: true, partial: false }
    }

    if (session.updated_at > syncState.last_synced_at) {
      return { stale: true, partial: false }
    }

    return { stale: false, partial: false }
  }

  private async syncSession(
    session: SupportedSession,
    force: boolean
  ): Promise<'synced' | 'partial' | 'skipped'> {
    const syncState = this.db.getUsageSyncState(session.id)
    if (!force) {
      const snapshot = this.getSessionSyncSnapshot(session, syncState)
      if (!snapshot.stale) return 'skipped'
    }

    if (session.agent_sdk === 'claude-code') {
      return this.syncClaudeSession(session)
    }

    return this.syncCodexSession(session)
  }

  private async syncClaudeSession(session: SupportedSession): Promise<'synced' | 'partial'> {
    if (!session.worktree_path || !session.opencode_session_id) {
      this.db.upsertUsageSyncState({
        session_id: session.id,
        agent_sdk: 'claude-code',
        source_kind: 'claude-transcript',
        status: 'partial',
        entry_count: 0,
        last_synced_at: new Date().toISOString(),
        last_error: !session.worktree_path
          ? 'Missing worktree path for Claude transcript.'
          : 'Missing Claude transcript session id.'
      })
      return 'partial'
    }

    const transcript = await readClaudeTranscriptUsage(
      session.worktree_path,
      session.opencode_session_id
    )

    if (transcript.mtimeMs === null) {
      this.db.upsertUsageSyncState({
        session_id: session.id,
        agent_sdk: 'claude-code',
        source_kind: 'claude-transcript',
        source_ref: transcript.filePath,
        source_mtime_ms: null,
        status: 'partial',
        entry_count: this.db
          .getUsageEntriesBySession(session.id)
          .filter((e) => e.source_kind === 'claude-transcript').length,
        last_synced_at: new Date().toISOString(),
        last_error: 'Claude transcript file is missing.'
      })
      return 'partial'
    }

    for (const entry of transcript.entries) {
      this.db.upsertUsageEntry({
        session_id: session.id,
        project_id: session.project_id,
        worktree_id: session.worktree_id,
        agent_sdk: 'claude-code',
        source_kind: 'claude-transcript',
        source_message_id: entry.sourceMessageId,
        provider_id: 'claude-code',
        model_id: resolvePricingModelKey(entry.model, 'claude-code'),
        model_label: entry.model,
        input_tokens: entry.inputTokens,
        output_tokens: entry.outputTokens,
        cache_write_tokens: entry.cacheWriteTokens,
        cache_read_tokens: entry.cacheReadTokens,
        total_tokens: entry.totalTokens,
        cost: entry.cost,
        occurred_at: entry.occurredAt
      })
    }

    this.db.upsertUsageSyncState({
      session_id: session.id,
      agent_sdk: 'claude-code',
      source_kind: 'claude-transcript',
      source_ref: transcript.filePath,
      source_mtime_ms: transcript.mtimeMs,
      status: 'synced',
      entry_count: transcript.entries.length,
      last_synced_at: new Date().toISOString(),
      last_error: null
    })

    return 'synced'
  }

  private async syncCodexSession(session: SupportedSession): Promise<'synced' | 'partial'> {
    // First, try to backfill from JSONL if available
    const jsonlPath = await this.resolveCodexJsonlPath(session)
    let backfillResult: BackfillResult | null = null
    if (jsonlPath) {
      backfillResult = await this.backfillCodexFromJsonl(session)
    }

    // Then count existing entries for sync state
    const existingEntries = this.db
      .getUsageEntriesBySession(session.id)
      .filter((entry) => entry.source_kind === 'codex-message')

    const existingEvents = this.db.getUsageEventsBySession(session.id)

    // Determine quality status:
    // - synced: v2 events exist (backfill or live wrote them)
    // - legacy-undercounted: only legacy rows exist, no v2 events (undercount)
    // - partial: JSONL found but backfill produced no events (parse failure)
    // - missing-source: no JSONL and no data at all
    let status: string
    let lastError: string | null = null

    if (existingEvents.length > 0) {
      status = 'synced'
      // If backfill itself had an error, log it but don't downgrade —
      // live events may have already populated the ledger correctly.
      if (backfillResult?.error) {
        log.warn('syncCodexSession: backfill had errors but v2 events exist', {
          sessionId: session.id,
          error: backfillResult.error
        })
      }
    } else if (existingEntries.length > 0) {
      // Legacy rows exist but no v2 events — this is the undercount state
      status = 'legacy-undercounted'
      if (backfillResult?.sourceFound && backfillResult.parsedEventCount === 0) {
        lastError = 'JSONL found but contained no token_count events.'
      } else if (backfillResult?.error) {
        lastError = `Backfill failed: ${backfillResult.error}`
      } else if (!backfillResult?.sourceFound) {
        lastError = 'Codex JSONL source is missing; only legacy undercounted data exists.'
      }
    } else if (backfillResult?.sourceFound) {
      // JSONL found but no events were inserted
      status = 'partial'
      lastError = backfillResult.error
        ? `Backfill failed: ${backfillResult.error}`
        : 'JSONL found but contained no usable token_count events.'
    } else if (jsonlPath) {
      status = 'partial'
      lastError = 'JSONL path resolved but backfill did not run.'
    } else {
      status = 'missing-source'
      lastError = 'Codex JSONL source is missing.'
    }

    // Use real file mtime from backfill if available, else fallback
    const sourceMtimeMs = backfillResult?.sourceMtimeMs
      ?? (jsonlPath ? new Date(session.updated_at).getTime() : null)

    // When events exist, rebuild snapshot from event ledger to keep it fresh.
    // This prevents snapshot from lagging behind events (the root cause of
    // scope aggregate < current session).
    if (existingEvents.length > 0) {
      const existingSnapshot = this.db.getUsageSnapshot(session.id)
      let totalCost = 0
      let totalTokens = 0
      let inputTokens = 0
      let outputTokens = 0
      let cacheWriteTokens = 0
      let cacheReadTokens = 0
      let lastEventAt: string | null = null

      for (const event of existingEvents) {
        totalCost += event.cost_estimate
        totalTokens += event.total_tokens
        inputTokens += event.input_tokens
        outputTokens += event.output_tokens
        cacheWriteTokens += event.cache_write_tokens
        cacheReadTokens += event.cache_read_tokens
        if (!lastEventAt || event.occurred_at > lastEventAt) {
          lastEventAt = event.occurred_at
        }
      }

      this.db.upsertUsageSnapshot({
        session_id: session.id,
        agent_sdk: 'codex',
        runtime_session_id: session.opencode_session_id ?? null,
        thread_id: session.opencode_session_id ?? null,
        provider_id: 'codex',
        model_id: session.model_id ?? null,
        model_label: session.model_id ?? null,
        total_input_tokens: inputTokens,
        total_output_tokens: outputTokens,
        total_reasoning_tokens: 0,
        total_cache_write_tokens: cacheWriteTokens,
        total_cache_read_tokens: cacheReadTokens,
        total_tokens: totalTokens,
        total_cost_estimate: totalCost,
        context_used_tokens: existingSnapshot?.context_used_tokens ?? null,
        context_window_tokens: existingSnapshot?.context_window_tokens ?? null,
        context_percent: existingSnapshot?.context_percent ?? null,
        source_kind: 'codex-token-count',
        sync_status: 'synced',
        last_event_at: lastEventAt ?? new Date().toISOString()
      })
    }

    this.db.upsertUsageSyncState({
      session_id: session.id,
      agent_sdk: 'codex',
      source_kind: 'codex-token-count',
      source_ref: jsonlPath ?? session.opencode_session_id ?? session.id,
      source_mtime_ms: sourceMtimeMs,
      status,
      entry_count: existingEntries.length + existingEvents.length,
      last_synced_at: new Date().toISOString(),
      last_error: lastError
    })

    if (status === 'missing-source') return 'partial'
    if (status === 'legacy-undercounted') return 'partial'
    if (status === 'partial') return 'partial'
    return 'synced'
  }

  /**
   * Backfill usage_events from Codex JSONL file.
   *
   * Parses all token_count events from the JSONL and inserts them into
   * the v2 event-keyed ledger. This corrects the undercount caused by
   * the old turn-keyed persistence.
   *
   * Returns a structured result — callers must inspect it to determine
   * the sync quality state. Silent failures are no longer possible.
   */
  private async backfillCodexFromJsonl(session: SupportedSession): Promise<BackfillResult> {
    const result: BackfillResult = {
      sourceFound: false,
      parsedEventCount: 0,
      insertedEventCount: 0,
      sourceMtimeMs: null,
      error: null
    }

    try {
      const jsonlPath = await this.resolveCodexJsonlPath(session)
      if (!jsonlPath) return result

      result.sourceFound = true

      const { readFile, stat } = await import('node:fs/promises')
      const content = await readFile(jsonlPath, 'utf-8')

      try {
        const fileStat = await stat(jsonlPath)
        result.sourceMtimeMs = fileStat.mtimeMs
      } catch {
        // Non-fatal — mtime is best-effort
      }

      const lines = content.split('\n').filter((l) => l.trim())

      // Resolve model from session record first, then fallback to JSONL
      const sessionModelId = session.model_id
      const sessionModelLabel = session.model_id

      let lastTokenCount: Record<string, unknown> | undefined
      let lastTimestamp: string | undefined

      // Fix 3: Maintain current turn_id across the JSONL stream.
      // token_count events don't carry turn_id, but turn_context and
      // task_started events do. We attribute subsequent token_count
      // events to the most recently seen turn.
      let currentTurnId: string | null = null

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>
          const msg = asObject(entry.payload) ?? asObject(entry.msg)
          if (!msg) continue

          // Track turn_id from turn_context and task_started events
          if (msg.type === 'turn_context') {
            const payload = asObject(msg.payload) ?? msg
            const turnId = asString(payload.turn_id)
            if (turnId) currentTurnId = turnId
            continue
          }
          if (msg.type === 'task_started') {
            const payload = asObject(msg.payload) ?? msg
            const turnId = asString(payload.turn_id)
            if (turnId) currentTurnId = turnId
            continue
          }

          if (msg.type !== 'token_count') continue

          const info = asObject(msg.info)
          if (!info) continue

          result.parsedEventCount++

          const lastUsage = asObject(info.last_token_usage)
          const totalUsage = asObject(info.total_token_usage) ?? lastUsage
          if (!lastUsage) continue

          const lastInputTokens = asNumber(lastUsage.input_tokens) ?? 0
          const lastCachedInputTokens = asNumber(lastUsage.cached_input_tokens) ?? 0
          const lastOutputTokens = asNumber(lastUsage.output_tokens) ?? 0
          const lastReasoningTokens = asNumber(lastUsage.reasoning_output_tokens) ?? 0

          const totalInputTokens = asNumber(totalUsage?.input_tokens) ?? lastInputTokens
          const totalCachedInputTokens =
            asNumber(totalUsage?.cached_input_tokens) ?? lastCachedInputTokens
          const totalOutputTokens = asNumber(totalUsage?.output_tokens) ?? lastOutputTokens
          const totalReasoningTokens =
            asNumber(totalUsage?.reasoning_output_tokens) ?? lastReasoningTokens

          // Use tracked turn_id — token_count events don't carry their own
          const turnId = asString(msg.turn_id) ?? asString(entry.turn_id) ?? currentTurnId

          // Build event fingerprint (cumulative totals for idempotency)
          const sourceEventId = [
            session.opencode_session_id ?? 'unknown',
            turnId ?? 'unknown',
            totalInputTokens,
            totalCachedInputTokens,
            totalOutputTokens,
            totalReasoningTokens
          ].join(':')

          // Resolve model: prefer session record, then JSONL info, then fallback
          const modelID = sessionModelId
            ?? resolveCodexModelSlug(asString(info.model) ?? undefined)

          // Delta from last_token_usage (the event's incremental tokens)
          // Note: reasoning_output_tokens is a subset of output_tokens, NOT additive
          const lastTokensDelta = {
            input: Math.max(0, lastInputTokens - lastCachedInputTokens),
            cacheRead: lastCachedInputTokens,
            cacheWrite: 0,
            output: lastOutputTokens
          }
          // total_tokens = input + output (reasoning is subset of output)
          const totalDelta = lastTokensDelta.input + lastTokensDelta.output + lastTokensDelta.cacheRead

          if (totalDelta <= 0) continue

          const cost = calculateUsageCost(modelID, lastTokensDelta, 'codex')
          const pricingModelKey = resolvePricingModelKey(modelID, 'codex')

          // Use JSONL timestamp if available, otherwise fallback to now.
          const rawTimestamp = entry.timestamp ?? entry.ts
          let occurredAt: string
          if (typeof rawTimestamp === 'string' && rawTimestamp.length > 0) {
            const parsed = new Date(rawTimestamp)
            occurredAt = Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString()
          } else if (typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)) {
            occurredAt = new Date(rawTimestamp).toISOString()
          } else {
            occurredAt = new Date().toISOString()
          }
          lastTimestamp = occurredAt

          this.db.insertUsageEvent({
            session_id: session.id,
            project_id: session.project_id,
            worktree_id: session.worktree_id ?? null,
            agent_sdk: 'codex',
            source_kind: 'codex-token-count',
            source_event_id: sourceEventId,
            runtime_session_id: session.opencode_session_id ?? null,
            thread_id: session.opencode_session_id ?? null,
            turn_id: turnId ?? null,
            provider_id: 'codex',
            model_id: pricingModelKey,
            model_label: sessionModelLabel ?? modelID,
            input_tokens: lastTokensDelta.input,
            output_tokens: lastTokensDelta.output,
            reasoning_tokens: lastReasoningTokens,
            cache_write_tokens: lastTokensDelta.cacheWrite,
            cache_read_tokens: lastTokensDelta.cacheRead,
            total_tokens: totalDelta,
            cost_estimate: cost,
            occurred_at: occurredAt
          })

          result.insertedEventCount++
          lastTokenCount = info
        } catch {
          continue
        }
      }

      // Update snapshot from the last token_count event
      if (lastTokenCount && result.insertedEventCount > 0) {
        const lastUsage = asObject(lastTokenCount.last_token_usage)
        const totalUsage = asObject(lastTokenCount.total_token_usage) ?? lastUsage
        if (lastUsage && totalUsage) {
          const totalInputTokens = asNumber(totalUsage.input_tokens) ?? 0
          const totalCachedInputTokens = asNumber(totalUsage.cached_input_tokens) ?? 0
          const totalOutputTokens = asNumber(totalUsage.output_tokens) ?? 0
          const totalReasoningTokens = asNumber(totalUsage.reasoning_output_tokens) ?? 0
          const lastInputTokens = asNumber(lastUsage.input_tokens) ?? 0
          const contextWindow = asNumber(lastTokenCount.model_context_window) ?? 0
          const modelID = sessionModelId
            ?? resolveCodexModelSlug(asString(lastTokenCount.model) ?? undefined)
          const pricingModelKey = resolvePricingModelKey(modelID, 'codex')

          // total_tokens = input + output (reasoning is subset of output)
          const snapshotTotalTokens = totalInputTokens + totalOutputTokens

          this.db.upsertUsageSnapshot({
            session_id: session.id,
            agent_sdk: 'codex',
            runtime_session_id: session.opencode_session_id ?? null,
            thread_id: session.opencode_session_id ?? null,
            provider_id: 'codex',
            model_id: pricingModelKey,
            model_label: sessionModelLabel ?? modelID,
            total_input_tokens: Math.max(0, totalInputTokens - totalCachedInputTokens),
            total_output_tokens: totalOutputTokens,
            total_reasoning_tokens: totalReasoningTokens,
            total_cache_write_tokens: 0,
            total_cache_read_tokens: totalCachedInputTokens,
            total_tokens: snapshotTotalTokens,
            total_cost_estimate: calculateUsageCost(
              modelID,
              {
                input: Math.max(0, totalInputTokens - totalCachedInputTokens),
                cacheRead: totalCachedInputTokens,
                cacheWrite: 0,
                output: totalOutputTokens
              },
              'codex'
            ),
            context_used_tokens: lastInputTokens,
            context_window_tokens: contextWindow,
            context_percent: contextWindow > 0 ? (lastInputTokens / contextWindow) * 100 : 0,
            source_kind: 'codex-token-count',
            source_ref: jsonlPath,
            source_mtime_ms: result.sourceMtimeMs,
            sync_status: 'synced',
            last_event_at: lastTimestamp ?? new Date().toISOString()
          })
        }

        log.info('backfillCodexFromJsonl: backfilled usage events', {
          sessionId: session.id,
          parsedEventCount: result.parsedEventCount,
          insertedEventCount: result.insertedEventCount,
          sourceMtimeMs: result.sourceMtimeMs,
          jsonlPath
        })
      }

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.error = message
      log.warn('backfillCodexFromJsonl: failed', {
        sessionId: session.id,
        error: message
      })
      return result
    }
  }

  /**
   * Resolve the Codex JSONL file path for a session.
   *
   * Searches ~/.codex/sessions/ for a JSONL file matching the thread ID.
   */
  private async resolveCodexJsonlPath(session: SupportedSession): Promise<string | null> {
    const threadId = session.opencode_session_id
    if (!threadId) return null

    try {
      const { readdir } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const os = await import('node:os')

      const codexSessionsDir = join(os.homedir(), '.codex', 'sessions')

      // Search for JSONL files matching the thread ID
      // Pattern: ~/.codex/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl
      const findJsonl = async (dir: string): Promise<string | null> => {
        try {
          const entries = await readdir(dir, { withFileTypes: true })
          for (const entry of entries) {
            const fullPath = join(dir, entry.name)
            if (entry.isDirectory()) {
              const result = await findJsonl(fullPath)
              if (result) return result
            } else if (
              entry.isFile() &&
              entry.name.endsWith('.jsonl') &&
              entry.name.includes(threadId)
            ) {
              return fullPath
            }
          }
        } catch {
          // Directory might not exist
        }
        return null
      }

      return await findJsonl(codexSessionsDir)
    } catch {
      return null
    }
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

let usageAnalyticsService: UsageAnalyticsService | null = null

export function getUsageAnalyticsService(): UsageAnalyticsService {
  if (!usageAnalyticsService) {
    usageAnalyticsService = new UsageAnalyticsService(getDatabase())
  }
  return usageAnalyticsService
}
