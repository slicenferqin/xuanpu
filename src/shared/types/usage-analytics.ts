export type UsageAnalyticsEngine = 'claude-code' | 'codex'

export type UsageAnalyticsEngineFilter = 'all' | UsageAnalyticsEngine

export type UsageAnalyticsRange = 'today' | '7d' | '30d' | 'all'

export interface UsageAnalyticsFilters {
  range: UsageAnalyticsRange
  engine: UsageAnalyticsEngineFilter
}

export interface UsageAnalyticsEngineSummary {
  engine: UsageAnalyticsEngine
  total_cost: number
  total_tokens: number
  total_sessions: number
}

export interface UsageAnalyticsModelRow {
  engine: UsageAnalyticsEngine
  model_key: string
  model_label: string
  total_cost: number
  total_tokens: number
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
  session_count: number
}

export interface UsageAnalyticsProjectRow {
  engine: UsageAnalyticsEngine | 'all'
  project_id: string
  project_name: string
  project_path: string
  total_cost: number
  total_tokens: number
  session_count: number
  last_used_at: string
}

export interface UsageAnalyticsSessionRow {
  session_id: string
  session_name: string
  engine: UsageAnalyticsEngine
  project_id: string
  project_name: string
  project_path: string
  worktree_name: string | null
  model_label: string | null
  total_cost: number
  total_tokens: number
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
  last_used_at: string
  started_at: string
  updated_at: string
}

export interface UsageAnalyticsTimelineRow {
  date: string
  total_cost: number
  total_tokens: number
  total_sessions: number
}

export interface UsageAnalyticsPartialSession {
  session_id: string
  session_name: string
  engine: UsageAnalyticsEngine
  reason: 'missing-source' | 'missing-worktree' | 'sync-error'
  detail?: string
}

export interface UsageAnalyticsSyncInfo {
  stale_session_count: number
  partial_session_count: number
  supported_session_count: number
  last_resynced_at: string | null
}

export interface UsageAnalyticsDashboard {
  filters: UsageAnalyticsFilters
  generated_at: string
  total_cost: number
  total_tokens: number
  total_sessions: number
  total_input_tokens: number
  total_output_tokens: number
  total_cache_write_tokens: number
  total_cache_read_tokens: number
  by_engine: UsageAnalyticsEngineSummary[]
  by_model: UsageAnalyticsModelRow[]
  by_project: UsageAnalyticsProjectRow[]
  sessions: UsageAnalyticsSessionRow[]
  timeline: UsageAnalyticsTimelineRow[]
  partial_sessions: UsageAnalyticsPartialSession[]
  sync: UsageAnalyticsSyncInfo
}

export interface UsageAnalyticsSessionSummary {
  session_id: string
  engine: UsageAnalyticsEngine
  total_cost: number
  total_tokens: number
  input_tokens: number
  output_tokens: number
  cache_write_tokens: number
  cache_read_tokens: number
  duration_seconds: number
  last_used_at: string | null
  model_labels: string[]
  latest_model_label: string | null
  partial: boolean
}

export interface UsageAnalyticsDashboardResult {
  success: boolean
  data?: UsageAnalyticsDashboard
  error?: string
}

export interface UsageAnalyticsSessionSummaryResult {
  success: boolean
  data?: UsageAnalyticsSessionSummary
  error?: string
}

export interface UsageAnalyticsResyncResult {
  success: boolean
  synced_session_ids: string[]
  partial_session_ids: string[]
  error?: string
}
