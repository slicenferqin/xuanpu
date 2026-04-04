import { ipcMain } from 'electron'
import { createLogger } from '../services'
import { fetchClaudeUsage } from '../services/usage-service'
import { fetchOpenAIUsage } from '../services/openai-usage-service'
import { getUsageAnalyticsService } from '../services/usage-analytics-service'
import type { UsageAnalyticsFilters } from '@shared/types/usage-analytics'

const log = createLogger({ component: 'UsageHandlers' })

export function registerUsageHandlers(): void {
  log.info('Registering usage handlers')

  ipcMain.handle('usage:fetch', () => fetchClaudeUsage())
  ipcMain.handle('usage:fetchOpenai', () => fetchOpenAIUsage())
  ipcMain.handle('usageAnalytics:fetchDashboard', (_event, filters: UsageAnalyticsFilters) =>
    getUsageAnalyticsService().fetchDashboard(filters)
  )
  ipcMain.handle('usageAnalytics:fetchSessionSummary', (_event, sessionId: string) =>
    getUsageAnalyticsService().fetchSessionSummary(sessionId)
  )
  ipcMain.handle('usageAnalytics:resync', () => getUsageAnalyticsService().resync())
}
