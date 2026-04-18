import { create } from 'zustand'
import type {
  UsageAnalyticsDashboard,
  UsageAnalyticsEngineFilter,
  UsageAnalyticsFilters,
  UsageAnalyticsRange,
  UsageAnalyticsSessionStatusFilter
} from '@shared/types/usage-analytics'

export type UsageAnalyticsTab = 'overview' | 'models' | 'projects' | 'sessions' | 'timeline'

interface CachedDashboard {
  data: UsageAnalyticsDashboard
  fetchedAt: number
}

interface UsageAnalyticsState {
  filters: UsageAnalyticsFilters
  activeTab: UsageAnalyticsTab
  dashboard: UsageAnalyticsDashboard | null
  isLoading: boolean
  isResyncing: boolean
  error: string | null
  cache: Record<string, CachedDashboard>
  setRange: (range: UsageAnalyticsRange) => void
  setEngine: (engine: UsageAnalyticsEngineFilter) => void
  setSessionStatus: (status: UsageAnalyticsSessionStatusFilter) => void
  setActiveTab: (tab: UsageAnalyticsTab) => void
  fetchDashboard: (options?: { force?: boolean }) => Promise<UsageAnalyticsDashboard | null>
  resyncAndRefresh: () => Promise<void>
}

const CACHE_TTL_MS = 60_000

function getCacheKey(filters: UsageAnalyticsFilters): string {
  return `${filters.range}:${filters.engine}:${filters.sessionStatus}`
}

export const useUsageAnalyticsStore = create<UsageAnalyticsState>()((set, get) => ({
  filters: {
    range: '7d',
    engine: 'all',
    sessionStatus: 'all'
  },
  activeTab: 'overview',
  dashboard: null,
  isLoading: false,
  isResyncing: false,
  error: null,
  cache: {},

  setRange: (range) => {
    set((state) => ({
      filters: { ...state.filters, range }
    }))
  },

  setEngine: (engine) => {
    set((state) => ({
      filters: { ...state.filters, engine }
    }))
  },

  setSessionStatus: (sessionStatus) => {
    set((state) => ({
      filters: { ...state.filters, sessionStatus }
    }))
  },

  setActiveTab: (tab) => set({ activeTab: tab }),

  fetchDashboard: async (options) => {
    const { filters, cache } = get()
    const cacheKey = getCacheKey(filters)
    const cached = cache[cacheKey]

    if (!options?.force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      set({ dashboard: cached.data, error: null })
      return cached.data
    }

    set({ isLoading: true, error: null })

    try {
      const result = await window.usageAnalyticsOps.fetchDashboard(filters)
      const dashboard = result.data
      if (!result.success || !dashboard) {
        throw new Error(result.error || 'Failed to load usage analytics')
      }

      set((state) => ({
        dashboard,
        isLoading: false,
        error: null,
        cache: {
          ...state.cache,
          [cacheKey]: {
            data: dashboard,
            fetchedAt: Date.now()
          }
        }
      }))

      return dashboard
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  },

  resyncAndRefresh: async () => {
    if (get().isResyncing) return

    set({ isResyncing: true })
    try {
      await window.usageAnalyticsOps.resync()
      await get().fetchDashboard({ force: true })
    } finally {
      set({ isResyncing: false })
    }
  }
}))
