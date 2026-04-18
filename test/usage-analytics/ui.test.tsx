import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '../utils/render'
import { SessionCostPill } from '../../src/renderer/src/components/sessions/SessionCostPill'
import { SettingsUsage } from '../../src/renderer/src/components/settings/SettingsUsage'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'
import { useUsageAnalyticsStore } from '../../src/renderer/src/stores/useUsageAnalyticsStore'

const fetchDashboardMock = vi.fn()
const fetchSessionSummaryMock = vi.fn()
const resyncMock = vi.fn()

describe('usage analytics UI', () => {
  beforeEach(() => {
    fetchDashboardMock.mockReset()
    fetchSessionSummaryMock.mockReset()
    resyncMock.mockReset()

    useSettingsStore.setState((state) => ({ ...state, locale: 'en' }))
    useUsageAnalyticsStore.setState({
      filters: { range: '7d', engine: 'all', sessionStatus: 'all' },
      activeTab: 'overview',
      dashboard: null,
      isLoading: false,
      isResyncing: false,
      error: null,
      cache: {}
    })

    Object.defineProperty(window, 'usageAnalyticsOps', {
      value: {
        fetchDashboard: fetchDashboardMock,
        fetchSessionSummary: fetchSessionSummaryMock,
        resync: resyncMock
      },
      configurable: true
    })
  })

  it('renders the session cost pill and detail popover', async () => {
    const user = userEvent.setup()

    render(
      <SessionCostPill
        summary={{
          session_id: 'session-1',
          engine: 'claude-code',
          total_cost: 1.2345,
          total_tokens: 2300,
          input_tokens: 1200,
          output_tokens: 800,
          cache_write_tokens: 200,
          cache_read_tokens: 100,
          duration_seconds: 125,
          last_used_at: '2026-04-04T12:00:00.000Z',
          model_labels: ['Opus 4.7', 'Sonnet 4.6'],
          latest_model_label: 'Sonnet 4.6',
          partial: false
        }}
        fallbackCost={0}
        fallbackTokens={null}
      />
    )

    expect(screen.getByTestId('session-cost-pill')).toHaveTextContent('$1.2345')
    await user.click(screen.getByTestId('session-cost-pill'))

    expect(screen.getByText('Session Cost')).toBeTruthy()
    expect(screen.getByText('Opus 4.7 + Sonnet 4.6')).toBeTruthy()
    expect(screen.getByText('2m 5s')).toBeTruthy()
  })

  it('keeps session cost visible while token totals are still syncing', async () => {
    const user = userEvent.setup()

    render(
      <SessionCostPill
        summary={{
          session_id: 'session-2',
          engine: 'claude-code',
          total_cost: 0,
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_write_tokens: 0,
          cache_read_tokens: 0,
          duration_seconds: 0,
          last_used_at: '2026-04-18T00:35:40.000Z',
          model_labels: [],
          latest_model_label: null,
          partial: true
        }}
        fallbackCost={0.2374}
        fallbackTokens={{
          input: 3,
          output: 66,
          cacheRead: 0,
          cacheWrite: 37719
        }}
      />
    )

    expect(screen.getByTestId('session-cost-pill')).toHaveTextContent('$0.2374')
    await user.click(screen.getByTestId('session-cost-pill'))

    expect(screen.getByText('Session totals are syncing…')).toBeTruthy()
    expect(screen.queryByText('37.8K')).toBeNull()
  })

  it('renders settings usage dashboard and supports tab switching', async () => {
    const user = userEvent.setup()
    fetchDashboardMock.mockResolvedValue({
      success: true,
      data: {
        filters: { range: '7d', engine: 'all', sessionStatus: 'all' },
        generated_at: '2026-04-04T12:00:00.000Z',
        total_cost: 12.34,
        total_tokens: 34000,
        total_sessions: 2,
        total_input_tokens: 22000,
        total_output_tokens: 9000,
        total_cache_write_tokens: 2000,
        total_cache_read_tokens: 1000,
        by_engine: [
          { engine: 'claude-code', total_cost: 10, total_tokens: 28000, total_sessions: 1 },
          { engine: 'codex', total_cost: 2.34, total_tokens: 6000, total_sessions: 1 }
        ],
        by_model: [
          {
            engine: 'claude-code',
            model_key: 'sonnet',
            model_label: 'Sonnet 4.6',
            total_cost: 10,
            total_tokens: 28000,
            input_tokens: 18000,
            output_tokens: 8000,
            cache_write_tokens: 1000,
            cache_read_tokens: 1000,
            session_count: 1
          }
        ],
        by_project: [
          {
            engine: 'all',
            project_id: 'project-1',
            project_name: 'xuanpu',
            project_path: '/tmp/xuanpu',
            total_cost: 12.34,
            total_tokens: 34000,
            session_count: 2,
            last_used_at: '2026-04-04T12:00:00.000Z'
          }
        ],
        sessions: [
          {
            session_id: 'session-1',
            session_name: 'Cost dashboard',
            engine: 'claude-code',
            project_id: 'project-1',
            project_name: 'xuanpu',
            project_path: '/tmp/xuanpu',
            worktree_name: 'bloodhound',
            model_label: 'Sonnet 4.6',
            model_labels: ['Opus 4.7', 'Sonnet 4.6'],
            total_cost: 12.34,
            total_tokens: 34000,
            input_tokens: 22000,
            output_tokens: 9000,
            cache_write_tokens: 2000,
            cache_read_tokens: 1000,
            last_used_at: '2026-04-04T12:00:00.000Z',
            started_at: '2026-04-04T11:00:00.000Z',
            updated_at: '2026-04-04T12:00:00.000Z'
          }
        ],
        timeline: [
          {
            date: '2026-04-04',
            total_cost: 12.34,
            total_tokens: 34000,
            total_sessions: 2
          }
        ],
        partial_sessions: [],
        sync: {
          stale_session_count: 0,
          partial_session_count: 0,
          supported_session_count: 2,
          last_resynced_at: '2026-04-04T12:00:00.000Z'
        }
      }
    })
    resyncMock.mockResolvedValue({
      success: true,
      synced_session_ids: [],
      partial_session_ids: []
    })

    render(<SettingsUsage />)

    await waitFor(() => {
      expect(fetchDashboardMock).toHaveBeenCalled()
    })

    expect(screen.getByText('Usage Analytics')).toBeTruthy()
    expect(screen.getAllByText('$12.34').length).toBeGreaterThan(0)
    expect(screen.getByText('xuanpu')).toBeTruthy()

    await user.click(screen.getByTestId('usage-tab-models'))
    expect(screen.getByTestId('usage-tab-panel-models')).toBeTruthy()

    await user.click(screen.getByTestId('usage-engine-codex'))
    await waitFor(() => {
      expect(fetchDashboardMock).toHaveBeenCalledTimes(2)
    })

    await user.click(screen.getByTestId('usage-session-status-archived'))
    await waitFor(() => {
      expect(fetchDashboardMock).toHaveBeenCalledTimes(3)
    })
  })
})
