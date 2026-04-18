import type { DatabaseService } from '../db/database'
import type { Session } from '../db/types'
import { readClaudeTranscriptUsage } from './claude-transcript-reader'
import { createLogger } from './logger'
import {
  calculateUsageCost,
  resolvePricingModelKey,
  type UsageTokenCounts
} from '@shared/usage/pricing'
import { getCanonicalModelLabel } from '@shared/usage/models'
import {
  extractUsageCost,
  extractUsageMessageID,
  extractUsageModelRef,
  extractUsageTokens
} from '@shared/usage/message'
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

function sumTokens(tokens: UsageTokenCounts): number {
  return tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead
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
      const entries = this.db.listUsageEntries({ agentSdks: engines, dateFrom, dateTo })
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

      for (const entry of entries) {
        const session = sessionMap.get(entry.session_id)
        if (!session || !engines.includes(entry.agent_sdk)) continue
        const canonicalModelKey = resolvePricingModelKey(
          entry.model_id ?? entry.model_label ?? 'unknown',
          entry.provider_id ?? entry.agent_sdk
        )
        const canonicalModelLabel = getEntryModelLabel(entry)

        totals.cost += entry.cost
        totals.tokens += entry.total_tokens
        totals.input += entry.input_tokens
        totals.output += entry.output_tokens
        totals.cacheWrite += entry.cache_write_tokens
        totals.cacheRead += entry.cache_read_tokens

        const engineBucket = engineMap.get(entry.agent_sdk) ?? {
          total_cost: 0,
          total_tokens: 0,
          sessionIds: new Set<string>()
        }
        engineBucket.total_cost += entry.cost
        engineBucket.total_tokens += entry.total_tokens
        engineBucket.sessionIds.add(entry.session_id)
        engineMap.set(entry.agent_sdk, engineBucket)

        const modelKey = `${entry.agent_sdk}::${canonicalModelKey}`
        const modelBucket = modelMap.get(modelKey) ?? {
          engine: entry.agent_sdk,
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
        modelBucket.total_cost += entry.cost
        modelBucket.total_tokens += entry.total_tokens
        modelBucket.input_tokens += entry.input_tokens
        modelBucket.output_tokens += entry.output_tokens
        modelBucket.cache_write_tokens += entry.cache_write_tokens
        modelBucket.cache_read_tokens += entry.cache_read_tokens
        modelBucket.sessionIds.add(entry.session_id)
        modelMap.set(modelKey, modelBucket)

        const projectKey =
          filters.engine === 'all'
            ? session.project_id
            : `${entry.agent_sdk}::${session.project_id}`
        const projectBucket = projectMap.get(projectKey) ?? {
          engine: filters.engine === 'all' ? 'all' : entry.agent_sdk,
          project_id: session.project_id,
          project_name: session.project_name,
          project_path: session.project_path,
          total_cost: 0,
          total_tokens: 0,
          sessionIds: new Set<string>(),
          last_used_at: entry.occurred_at
        }
        projectBucket.total_cost += entry.cost
        projectBucket.total_tokens += entry.total_tokens
        projectBucket.sessionIds.add(entry.session_id)
        if (entry.occurred_at > projectBucket.last_used_at) {
          projectBucket.last_used_at = entry.occurred_at
        }
        projectMap.set(projectKey, projectBucket)

        const sessionBucket = sessionRows.get(entry.session_id) ?? {
          session_id: entry.session_id,
          session_name: session.name ?? 'Untitled',
          engine: entry.agent_sdk,
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
          last_used_at: entry.occurred_at,
          started_at: session.created_at,
          updated_at: session.updated_at
        }
        sessionBucket.total_cost += entry.cost
        sessionBucket.total_tokens += entry.total_tokens
        sessionBucket.input_tokens += entry.input_tokens
        sessionBucket.output_tokens += entry.output_tokens
        sessionBucket.cache_write_tokens += entry.cache_write_tokens
        sessionBucket.cache_read_tokens += entry.cache_read_tokens
        sessionBucket.model_label = canonicalModelLabel
        appendUnique(sessionBucket.model_labels, canonicalModelLabel)
        if (entry.occurred_at > sessionBucket.last_used_at) {
          sessionBucket.last_used_at = entry.occurred_at
        }
        sessionRows.set(entry.session_id, sessionBucket)

        const dateKey = formatDateKey(new Date(entry.occurred_at))
        const timelineBucket = timelineMap.get(dateKey) ?? {
          date: dateKey,
          total_cost: 0,
          total_tokens: 0,
          total_sessions: 0,
          sessionIds: new Set<string>()
        }
        timelineBucket.total_cost += entry.cost
        timelineBucket.total_tokens += entry.total_tokens
        timelineBucket.sessionIds.add(entry.session_id)
        timelineBucket.total_sessions = timelineBucket.sessionIds.size
        timelineMap.set(dateKey, timelineBucket)
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

  async fetchSessionSummary(sessionId: string): Promise<UsageAnalyticsSessionSummaryResult> {
    try {
      const session = this.db
        .getUsageAnalyticsSessions(['claude-code', 'codex'], 'all')
        .find((item) => item.id === sessionId)

      if (!session) {
        return { success: false, error: 'Session not found or unsupported' }
      }

      await this.syncSession(session, true)

      const entries = [...this.db.getUsageEntriesBySession(sessionId)].sort((a, b) =>
        a.occurred_at.localeCompare(b.occurred_at)
      )
      const syncState = this.db.getUsageSyncState(sessionId)
      const modelLabels: string[] = []

      const summary: UsageAnalyticsSessionSummary = {
        session_id: sessionId,
        engine: session.agent_sdk as UsageAnalyticsEngine,
        total_cost: 0,
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        duration_seconds: 0,
        last_used_at: entries.length > 0 ? entries[entries.length - 1].occurred_at : null,
        model_labels: [],
        latest_model_label: null,
        partial: syncState?.status === 'partial' || syncState?.status === 'error'
      }

      for (const entry of entries) {
        summary.total_cost += entry.cost
        summary.total_tokens += entry.total_tokens
        summary.input_tokens += entry.input_tokens
        summary.output_tokens += entry.output_tokens
        summary.cache_write_tokens += entry.cache_write_tokens
        summary.cache_read_tokens += entry.cache_read_tokens
        appendUnique(modelLabels, getEntryModelLabel(entry))
      }

      summary.model_labels = modelLabels
      summary.latest_model_label = modelLabels[modelLabels.length - 1] ?? null

      const endAt = summary.last_used_at ?? session.updated_at
      summary.duration_seconds = Math.max(
        0,
        Math.round((new Date(endAt).getTime() - new Date(session.created_at).getTime()) / 1000)
      )

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

    if (syncState.status === 'partial') {
      return {
        stale: false,
        partial: true,
        reason: 'missing-source',
        detail: syncState.last_error ?? 'Source data is incomplete.'
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
      this.db.deleteUsageEntriesForSession(session.id, 'claude-transcript')
      this.db.upsertUsageSyncState({
        session_id: session.id,
        agent_sdk: 'claude-code',
        source_kind: 'claude-transcript',
        source_ref: transcript.filePath,
        source_mtime_ms: null,
        status: 'partial',
        entry_count: 0,
        last_synced_at: new Date().toISOString(),
        last_error: 'Claude transcript file is missing.'
      })
      return 'partial'
    }

    this.db.deleteUsageEntriesForSession(session.id, 'claude-transcript')
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

  private async syncCodexSession(session: SupportedSession): Promise<'synced'> {
    const messageRows = this.db.getSessionMessages(session.id)
    this.db.deleteUsageEntriesForSession(session.id, 'codex-message')

    const finalEntries = new Map<
      string,
      {
        occurredAt: string
        cost: number
        tokens: UsageTokenCounts
        modelID: string | null
        modelLabel: string | null
        providerID: string | null
      }
    >()

    for (const row of messageRows) {
      if (row.role !== 'assistant' || !row.opencode_message_json) continue

      try {
        const parsed = JSON.parse(row.opencode_message_json) as Record<string, unknown>
        const messageId = extractUsageMessageID(parsed) ?? row.opencode_message_id ?? row.id
        const tokens = extractUsageTokens(parsed)
        const modelRef = extractUsageModelRef(parsed)
        const explicitCost = extractUsageCost(parsed)

        if (!tokens && explicitCost <= 0) continue

        const resolvedTokens = tokens ?? {
          input: 0,
          output: 0,
          cacheWrite: 0,
          cacheRead: 0
        }
        const resolvedModel = modelRef?.modelID ?? session.model_id ?? 'unknown'
        const occurredAt = typeof parsed.timestamp === 'string' ? parsed.timestamp : row.created_at
        const cost =
          explicitCost > 0
            ? explicitCost
            : calculateUsageCost(resolvedModel, resolvedTokens, modelRef?.providerID ?? 'codex')

        finalEntries.set(messageId, {
          occurredAt,
          cost,
          tokens: resolvedTokens,
          modelID: resolvePricingModelKey(resolvedModel, modelRef?.providerID ?? 'codex'),
          modelLabel: modelRef?.displayName ?? resolvedModel,
          providerID: modelRef?.providerID ?? 'codex'
        })
      } catch {
        // Ignore malformed persisted message rows
      }
    }

    for (const [messageId, entry] of finalEntries.entries()) {
      this.db.upsertUsageEntry({
        session_id: session.id,
        project_id: session.project_id,
        worktree_id: session.worktree_id,
        agent_sdk: 'codex',
        source_kind: 'codex-message',
        source_message_id: messageId,
        provider_id: entry.providerID,
        model_id: entry.modelID,
        model_label: entry.modelLabel,
        input_tokens: entry.tokens.input,
        output_tokens: entry.tokens.output,
        cache_write_tokens: entry.tokens.cacheWrite,
        cache_read_tokens: entry.tokens.cacheRead,
        total_tokens: sumTokens(entry.tokens),
        cost: entry.cost,
        occurred_at: entry.occurredAt
      })
    }

    this.db.upsertUsageSyncState({
      session_id: session.id,
      agent_sdk: 'codex',
      source_kind: 'codex-message',
      source_ref: session.opencode_session_id ?? session.id,
      source_mtime_ms: new Date(session.updated_at).getTime(),
      status: 'synced',
      entry_count: finalEntries.size,
      last_synced_at: new Date().toISOString(),
      last_error: null
    })

    return 'synced'
  }
}

let usageAnalyticsService: UsageAnalyticsService | null = null

export function getUsageAnalyticsService(): UsageAnalyticsService {
  if (!usageAnalyticsService) {
    usageAnalyticsService = new UsageAnalyticsService(getDatabase())
  }
  return usageAnalyticsService
}
