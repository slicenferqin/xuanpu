import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextPanelHost } from '@/components/context-panel/ContextPanelHost'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useContextStore } from '@/stores/useContextStore'
import { useSessionRuntimeStore } from '@/stores/useSessionRuntimeStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useGitStore } from '@/stores/useGitStore'
import type { TimelineMessage } from '@shared/lib/timeline-types'
import type React from 'react'

vi.mock('@/components/file-tree/FileTree', () => ({
  FileTree: () => <div data-testid="file-tree">FileTree</div>
}))

vi.mock('@/components/file-tree/ChangesView', () => ({
  ChangesView: () => <div data-testid="changes-view">ChangesView</div>
}))

vi.mock('@/components/file-tree/BranchDiffView', () => ({
  BranchDiffView: () => <div data-testid="branch-diff-view">BranchDiffView</div>
}))

vi.mock('@/components/diff-comments/DiffCommentsViewer', () => ({
  DiffCommentsViewer: () => <div data-testid="diff-comments-viewer">DiffCommentsViewer</div>
}))

vi.mock('@/components/pr-review/PrReviewViewer', () => ({
  PrReviewViewer: () => <div data-testid="pr-review-viewer">PrReviewViewer</div>
}))

function renderHost(options: { terminalPanel?: React.ReactNode } = {}): void {
  render(
    <ContextPanelHost
      worktreePath="/tmp/worktree"
      scopeId="wt-1"
      onClose={vi.fn()}
      onFileClick={vi.fn()}
      terminalPanel={options.terminalPanel}
    />
  )
}

function todoTimeline(): TimelineMessage[] {
  return [
    {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      timestamp: '2026-05-21T00:00:00.000Z',
      parts: [
        {
          type: 'tool_use',
          toolUse: {
            id: 'todo-1',
            name: 'TodoWrite',
            status: 'success',
            startTime: 1,
            input: {
              todos: [
                { id: 'task-1', content: 'Move tasks into the context panel', status: 'completed' }
              ]
            }
          }
        }
      ]
    }
  ]
}

describe('ContextPanelHost', () => {
  beforeEach(() => {
    useLayoutStore.setState({
      bottomPanelTab: 'terminal',
      rightContextTab: 'overview',
      rightReviewTab: 'changes'
    })
    useSessionStore.setState({
      activeSessionId: null,
      inlineConnectionSessionId: null
    })
    useSettingsStore.setState({ vimModeEnabled: true })
    useProjectStore.setState({
      projects: [],
      selectedProjectId: null
    })
    useWorktreeStore.setState({
      selectedWorktreeId: null,
      worktreesByProject: new Map()
    })
    useGitStore.setState({
      remoteInfo: new Map(),
      prTargetBranch: new Map(),
      reviewTargetBranch: new Map(),
      prCreation: new Map(),
      attachedPR: new Map(),
      branchInfoByWorktree: new Map(),
      fileStatusesByWorktree: new Map(),
      isPushing: false,
      isPulling: false
    })
    useContextStore.setState({
      tokensBySession: {},
      modelBySession: {},
      contextSnapshotsBySession: {},
      costBySession: {},
      costEventKeysBySession: {},
      modelLimits: {}
    })
    useSessionRuntimeStore.setState({
      sessions: new Map(),
      goals: new Map(),
      dismissedGoalSignatures: new Map(),
      interruptQueues: new Map(),
      pendingMessages: new Map(),
      sessionTasks: new Map()
    })
    Object.defineProperty(window, 'agentOps', {
      configurable: true,
      writable: true,
      value: {
        getTimeline: vi.fn().mockResolvedValue({ messages: [] })
      }
    })
    Object.defineProperty(window, 'usageAnalyticsOps', {
      configurable: true,
      writable: true,
      value: {
        fetchDashboard: vi.fn().mockResolvedValue({ success: false }),
        fetchSessionSummary: vi.fn().mockResolvedValue({ success: false }),
        fetchScopeSummary: vi.fn().mockResolvedValue({ success: false }),
        resync: vi.fn().mockResolvedValue({ success: true, synced_session_ids: [], partial_session_ids: [] })
      }
    })
    Object.defineProperty(window, 'db', {
      configurable: true,
      writable: true,
      value: {
        session: {
          getByWorktree: vi.fn().mockResolvedValue([]),
          getByConnection: vi.fn().mockResolvedValue([])
        }
      }
    })
    Object.defineProperty(window, 'gitOps', {
      configurable: true,
      writable: true,
      value: {
        listBranchesWithStatus: vi.fn().mockResolvedValue({ success: true, branches: [] }),
        listPRs: vi.fn().mockResolvedValue({ success: true, prs: [] }),
        getPRState: vi.fn().mockResolvedValue({ success: false }),
        prMerge: vi.fn().mockResolvedValue({ success: true })
      }
    })
    Object.defineProperty(window, 'fileOps', {
      configurable: true,
      writable: true,
      value: {
        readPrompt: vi.fn().mockResolvedValue({ success: false })
      }
    })
    Object.defineProperty(window, 'fieldOps', {
      configurable: true,
      writable: true,
      value: {
        getXfpAuditEvents: vi.fn().mockResolvedValue([
          {
            id: 'audit-1',
            worktreeId: 'wt-1',
            sessionId: 'sess-diagnostics',
            runtimeId: 'codex',
            kind: 'prompt',
            toolName: 'field_delivery',
            input: {
              mode: 'none',
              promptChars: 42,
              hasFieldContextEnvelope: false,
              hasXfpFallbackPrefix: false
            },
            outputSummary: 'field delivery: none • 42 runtime chars',
            outputChars: 39,
            truncated: false,
            privacy: 'allowed',
            createdAt: 100
          }
        ]),
        getLastInjection: vi.fn().mockResolvedValue(null),
        getEpisodicMemory: vi.fn().mockResolvedValue(null),
        getSemanticMemory: vi.fn().mockResolvedValue(null),
        getCheckpoint: vi.fn().mockResolvedValue(null),
        listContextPackages: vi.fn().mockResolvedValue([]),
        listEpisodeBlocks: vi.fn().mockResolvedValue([])
      }
    })
  })

  it('switches between overview, review, and files without owning terminal state', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ activeSessionId: 'sess-overview' })
    renderHost()

    expect(screen.getByTestId('context-panel-overview')).toBeInTheDocument()

    await user.click(screen.getByTestId('context-panel-tab-review'))
    expect(screen.getByTestId('changes-view')).toBeInTheDocument()

    await user.click(screen.getByTestId('context-panel-tab-files'))
    expect(screen.getByTestId('file-tree')).toBeInTheDocument()
  })

  it('keeps the content area on the left and the vertical rail on the right', () => {
    useSessionStore.setState({ activeSessionId: 'sess-overview' })
    renderHost()

    const host = screen.getByTestId('context-panel-host')
    expect(host.children[0]).toBe(screen.getByTestId('context-panel-content'))
    expect(host.children[1]).toBe(screen.getByTestId('context-panel-rail'))
    expect(screen.getByTestId('context-panel-tab-overview')).toHaveAttribute(
      'aria-label',
      'Overview'
    )
  })

  it('renders XFP diagnostics from the right context panel', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ activeSessionId: 'sess-diagnostics' })
    renderHost()

    await user.click(screen.getByTestId('context-panel-tab-diagnostics'))

    expect(screen.getByTestId('context-panel-diagnostics')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('field_delivery')).toBeInTheDocument()
      expect(screen.getByText('field delivery: none • 42 runtime chars')).toBeInTheDocument()
    })
    expect(window.fieldOps.getXfpAuditEvents).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      limit: 30
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(window.fieldOps.getXfpAuditEvents).toHaveBeenCalledTimes(1)
  })

  it('shows the terminal entry only when a right-docked terminal panel is provided', async () => {
    const user = userEvent.setup()
    renderHost({ terminalPanel: <div data-testid="context-panel-terminal">Terminal panel</div> })

    await user.click(screen.getByTestId('context-panel-tab-terminal'))

    expect(screen.getByTestId('context-panel-terminal')).toBeInTheDocument()
  })

  it('renders grouped latest-round tasks in the tasks panel from durable timeline data', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ activeSessionId: 'sess-tasks' })
    Object.defineProperty(window, 'agentOps', {
      configurable: true,
      writable: true,
      value: {
        getTimeline: vi.fn().mockResolvedValue({
          messages: [
            {
              id: 'user-1',
              role: 'user',
              content: '旧任务轮次',
              timestamp: '2026-05-21T00:00:00.000Z'
            },
            {
              id: 'assistant-1',
              role: 'assistant',
              content: '',
              timestamp: '2026-05-21T00:00:01.000Z',
              parts: [
                {
                  type: 'tool_use',
                  toolUse: {
                    id: 'todo-old',
                    name: 'TodoWrite',
                    status: 'success',
                    startTime: 1,
                    input: {
                      todos: [
                        { id: 'task-old-1', content: 'Completed old task', status: 'completed' },
                        { id: 'task-old-2', content: 'Pending old task', status: 'pending' }
                      ]
                    }
                  }
                }
              ]
            },
            {
              id: 'user-2',
              role: 'user',
              content: '最新任务轮次',
              timestamp: '2026-05-21T00:00:02.000Z'
            },
            {
              id: 'assistant-2',
              role: 'assistant',
              content: '',
              timestamp: '2026-05-21T00:00:03.000Z',
              parts: [
                {
                  type: 'tool_use',
                  toolUse: {
                    id: 'todo-new',
                    name: 'TodoWrite',
                    status: 'success',
                    startTime: 2,
                    input: {
                      todos: [
                        { id: 'task-1', content: 'Inspect session tasks', status: 'in_progress' },
                        { id: 'task-2', content: 'Update task panel', status: 'pending' },
                        { id: 'task-3', content: 'Verify UI changes', status: 'completed' }
                      ]
                    }
                  }
                }
              ]
            }
          ]
        })
      }
    })

    renderHost()

    await user.click(screen.getByTestId('context-panel-tab-tasks'))

    await waitFor(() => {
      expect(screen.getByTestId('context-panel-tasks')).toBeInTheDocument()
    })

    expect(screen.getByText('进行中')).toBeInTheDocument()
    expect(screen.getByText('待处理')).toBeInTheDocument()
    expect(screen.getByText('已完成')).toBeInTheDocument()
    expect(screen.getByText('查看任务')).toBeInTheDocument()
    expect(screen.getByText('更新任务面板')).toBeInTheDocument()
    expect(screen.getByText('Verify UI changes')).toBeInTheDocument()
    expect(screen.queryByText('Completed old task')).not.toBeInTheDocument()
    expect(screen.queryByText('Pending old task')).not.toBeInTheDocument()
  })

  it('prefers runtime tasks over durable fallback in the tasks panel', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ activeSessionId: 'sess-live-tasks' })
    useSessionRuntimeStore.getState().setSessionTasks('sess-live-tasks', [
      { id: 'task-live', content: 'Inspect live runtime task', status: 'in_progress' }
    ])
    Object.defineProperty(window, 'agentOps', {
      configurable: true,
      writable: true,
      value: {
        getTimeline: vi.fn().mockResolvedValue({ messages: todoTimeline() })
      }
    })

    renderHost()

    await user.click(screen.getByTestId('context-panel-tab-tasks'))

    await waitFor(() => {
      expect(screen.getByText('查看任务')).toBeInTheDocument()
    })
    expect(screen.queryByText('Move tasks into the context panel')).not.toBeInTheDocument()
  })

  it('keeps the terminal panel mounted while switching away and back', async () => {
    const user = userEvent.setup()
    renderHost({ terminalPanel: <div data-testid="context-panel-terminal">Terminal panel</div> })

    await user.click(screen.getByTestId('context-panel-tab-terminal'))

    const terminalContent = screen.getByTestId('context-panel-terminal-content')
    expect(screen.getByTestId('context-panel-terminal')).toBeInTheDocument()
    expect(terminalContent).not.toHaveClass('hidden')
    expect(terminalContent).toHaveAttribute('aria-hidden', 'false')

    await user.click(screen.getByTestId('context-panel-tab-overview'))

    expect(screen.getByTestId('context-panel-terminal')).toBeInTheDocument()
    expect(terminalContent).toHaveClass('hidden')
    expect(terminalContent).toHaveAttribute('aria-hidden', 'true')

    await user.click(screen.getByTestId('context-panel-tab-terminal'))

    expect(screen.getByTestId('context-panel-terminal')).toBeInTheDocument()
    expect(terminalContent).not.toHaveClass('hidden')
    expect(terminalContent).toHaveAttribute('aria-hidden', 'false')
  })

  it('keeps vim right-sidebar tab events compatible with review sub-tabs', () => {
    renderHost()

    act(() => {
      window.dispatchEvent(new CustomEvent('hive:right-sidebar-tab', { detail: { tab: 'diffs' } }))
    })

    expect(screen.getByTestId('branch-diff-view')).toBeInTheDocument()
    expect(useLayoutStore.getState().rightContextTab).toBe('review')
    expect(useLayoutStore.getState().rightReviewTab).toBe('diffs')
  })

  it('selects the terminal bottom tab for vim terminal sidebar events', () => {
    useLayoutStore.setState({ bottomPanelTab: 'run' })
    renderHost({ terminalPanel: <div data-testid="context-panel-terminal">Terminal panel</div> })

    act(() => {
      window.dispatchEvent(
        new CustomEvent('hive:right-sidebar-tab', { detail: { tab: 'terminal' } })
      )
    })

    expect(useLayoutStore.getState().rightContextTab).toBe('terminal')
    expect(useLayoutStore.getState().bottomPanelTab).toBe('terminal')
  })

  it('keeps AI review and PR actions inside the review context panel', async () => {
    const user = userEvent.setup()
    useProjectStore.setState({
      projects: [
        {
          id: 'proj-1',
          name: 'Project',
          path: '/tmp/project',
          description: null,
          tags: null,
          language: null,
          custom_icon: null,
          setup_script: null,
          run_script: null,
          archive_script: null,
          auto_assign_port: false,
          sort_order: 0,
          created_at: '2026-05-21T00:00:00.000Z',
          last_accessed_at: '2026-05-21T00:00:00.000Z'
        }
      ],
      selectedProjectId: 'proj-1'
    })
    useWorktreeStore.setState({
      selectedWorktreeId: 'wt-1',
      worktreesByProject: new Map([
        [
          'proj-1',
          [
            {
              id: 'wt-1',
              project_id: 'proj-1',
              name: 'feature',
              branch_name: 'feature',
              path: '/tmp/worktree',
              status: 'active',
              is_default: false,
              branch_renamed: 0,
              last_message_at: null,
              session_titles: '[]',
              last_model_provider_id: null,
              last_model_id: null,
              last_model_variant: null,
              created_at: '2026-05-21T00:00:00.000Z',
              last_accessed_at: '2026-05-21T00:00:00.000Z',
              github_pr_number: null,
              github_pr_url: null
            }
          ]
        ]
      ])
    })
    useGitStore.setState({
      remoteInfo: new Map([
        ['wt-1', { hasRemote: true, isGitHub: true, url: 'git@github.com:org/repo.git' }]
      ]),
      branchInfoByWorktree: new Map([
        ['/tmp/worktree', { name: 'feature', tracking: 'origin/main', ahead: 0, behind: 0 }]
      ])
    })
    window.gitOps.listBranchesWithStatus = vi.fn().mockResolvedValue({
      success: true,
      branches: [{ name: 'origin/main', isRemote: true }]
    })

    renderHost()
    await user.click(screen.getByTestId('context-panel-tab-review'))

    expect(screen.getByTestId('context-panel-review-actions')).toBeInTheDocument()
    expect(screen.getByTestId('review-button')).toHaveTextContent('AI Review')
    expect(screen.getByTestId('review-target-branch-trigger')).toHaveTextContent('origin/main')
    expect(screen.getByTestId('pr-section')).toBeInTheDocument()
    expect(screen.getByTestId('pr-button')).toBeInTheDocument()
    expect(screen.getByTestId('pr-target-branch-trigger')).toHaveTextContent('origin/main')
  })


  it('renders and dismisses completed goals from the right goal panel', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ activeSessionId: 'sess-goal' })
    useSessionRuntimeStore.getState().setSessionGoal('sess-goal', {
      threadId: 'thread-1',
      objective: 'Ship infra polish',
      successCriteria: 'Tasks, goal, and overview live in the context panel',
      status: 'completed',
      createdAt: 10,
      updatedAt: 20
    })

    renderHost()
    await user.click(screen.getByTestId('context-panel-tab-goal'))

    expect(screen.getByTestId('goal-status-card')).toHaveTextContent('Ship infra polish')
    await user.click(screen.getByTestId('goal-dismiss-button'))

    await waitFor(() => {
      expect(screen.queryByTestId('goal-status-card')).not.toBeInTheDocument()
      expect(screen.getByText('No goal set')).toBeInTheDocument()
    })
  })

  it('shows worktree-wide cumulative usage summary in the overview panel', async () => {
    const user = userEvent.setup()
    const sessions = ['sess-usage-a', 'sess-usage-b'].map((id, index) => ({
      id,
      worktree_id: 'wt-1',
      project_id: 'proj-1',
      connection_id: null,
      name: `Session ${index + 1}`,
      status: index === 0 ? ('active' as const) : ('archived' as const),
      opencode_session_id: `runtime-${index + 1}`,
      agent_sdk: 'codex' as const,
      mode: 'build' as const,
      model_provider_id: null,
      model_id: null,
      model_variant: null,
      first_message_at: null,
      created_at: '2026-05-21T00:00:00.000Z',
      updated_at: '2026-05-21T00:00:00.000Z',
      completed_at: null
    }))
    useSessionStore.setState({
      activeSessionId: 'sess-usage-a',
      activeWorktreeId: 'wt-1',
      sessionsByWorktree: new Map([['wt-1', sessions]]),
      tabOrderByWorktree: new Map([['wt-1', sessions.map((session) => session.id)]])
    })
    window.db.session.getByWorktree = vi.fn().mockResolvedValue(sessions)
    // Current session summary
    window.usageAnalyticsOps.fetchSessionSummary = vi.fn().mockResolvedValue({
      success: true,
      data: {
        session_id: 'sess-usage-a',
        engine: 'codex',
        total_cost: 0.03,
        total_tokens: 8000,
        input_tokens: 2000,
        output_tokens: 4500,
        cache_write_tokens: 500,
        cache_read_tokens: 1000,
        duration_seconds: 120,
        last_used_at: '2026-05-21T00:02:00.000Z',
        model_labels: ['o3'],
        latest_model_label: 'o3',
        partial: false
      }
    })
    // Worktree aggregate
    window.usageAnalyticsOps.fetchScopeSummary = vi.fn().mockResolvedValue({
      success: true,
      data: {
        scope_id: 'wt-1',
        scope_type: 'worktree',
        session_count: 2,
        active_session_count: 1,
        total_cost: 0.06,
        total_tokens: 17500,
        input_tokens: 4100,
        output_tokens: 9200,
        cache_write_tokens: 1200,
        cache_read_tokens: 3000,
        context_used_tokens: null,
        context_window_tokens: null,
        context_percent: null,
        coverage: { synced: 2, partial: 0, legacy_undercounted: 0, missing_source: 0, unsupported: 0 },
        partial_sessions: []
      }
    })

    renderHost()

    await waitFor(() => {
      // Current session data appears in primary section
      expect(screen.getByText('$0.03')).toBeInTheDocument()
      expect(screen.getByText('8.0K')).toBeInTheDocument()
      // Worktree aggregate appears in secondary section
      expect(screen.getByText('$0.06')).toBeInTheDocument()
      expect(screen.getByText('17.5K')).toBeInTheDocument()
      expect(screen.getByText('2')).toBeInTheDocument()
    })

    const breakdown = screen.getByLabelText('Session breakdown')
    await user.hover(breakdown)
    expect(breakdown).toHaveAttribute('title', '1 active sessions\n1 inactive sessions')
  })

  it('falls back to live tokens when persisted cost has no token counters yet', async () => {
    const sessions = [
      {
        id: 'sess-codex-cost-only',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        connection_id: null,
        name: 'Codex cost only',
        status: 'active' as const,
        opencode_session_id: 'codex-runtime-1',
        agent_sdk: 'codex' as const,
        mode: 'build' as const,
        model_provider_id: null,
        model_id: null,
        model_variant: null,
        first_message_at: null,
        created_at: '2026-05-21T00:00:00.000Z',
        updated_at: '2026-05-21T00:00:00.000Z',
        completed_at: null
      }
    ]
    useSessionStore.setState({
      activeSessionId: 'sess-codex-cost-only',
      activeWorktreeId: 'wt-1',
      sessionsByWorktree: new Map([['wt-1', sessions]]),
      tabOrderByWorktree: new Map([['wt-1', ['sess-codex-cost-only']]])
    })
    useContextStore.getState().setSessionTokens('sess-codex-cost-only', {
      input: 3,
      output: 66,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 37_719
    })
    useContextStore.getState().setSessionCost('sess-codex-cost-only', 0.1042)
    window.db.session.getByWorktree = vi.fn().mockResolvedValue(sessions)
    // Session summary returns 0 cost/tokens → should fall back to live values
    window.usageAnalyticsOps.fetchSessionSummary = vi.fn().mockResolvedValue({
      success: true,
      data: {
        session_id: 'sess-codex-cost-only',
        engine: 'codex',
        total_cost: 0,
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        duration_seconds: 60,
        last_used_at: '2026-05-21T00:01:00.000Z',
        model_labels: [],
        latest_model_label: null,
        partial: true
      }
    })

    renderHost()

    await waitFor(() => {
      // Falls back to live cost
      expect(screen.getByText('$0.10')).toBeInTheDocument()
      // Falls back to live tokens (3 + 66 + 0 + 37719 = 37788)
      expect(screen.getByText('37.8K')).toBeInTheDocument()
    })
  })

  it('keeps the larger visible token snapshot without double-counting summary plus live', async () => {
    const sessions = [
      {
        id: 'sess-claude-syncing',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        connection_id: null,
        name: 'Claude syncing',
        status: 'active' as const,
        opencode_session_id: 'claude-runtime-1',
        agent_sdk: 'claude-code' as const,
        mode: 'build' as const,
        model_provider_id: null,
        model_id: null,
        model_variant: null,
        first_message_at: null,
        created_at: '2026-05-21T00:00:00.000Z',
        updated_at: '2026-05-21T00:00:00.000Z',
        completed_at: null
      }
    ]
    useSessionStore.setState({
      activeSessionId: 'sess-claude-syncing',
      activeWorktreeId: 'wt-1',
      sessionsByWorktree: new Map([['wt-1', sessions]]),
      tabOrderByWorktree: new Map([['wt-1', ['sess-claude-syncing']]])
    })
    useContextStore.getState().setSessionTokens('sess-claude-syncing', {
      input: 300,
      output: 200,
      reasoning: 0,
      cacheRead: 100,
      cacheWrite: 50
    })
    window.db.session.getByWorktree = vi.fn().mockResolvedValue(sessions)
    // Current session summary — returns higher tokens than live
    window.usageAnalyticsOps.fetchSessionSummary = vi.fn().mockResolvedValue({
      success: true,
      data: {
        session_id: 'sess-claude-syncing',
        engine: 'claude-code',
        total_cost: 0,
        total_tokens: 1_200,
        input_tokens: 700,
        output_tokens: 300,
        cache_write_tokens: 100,
        cache_read_tokens: 100,
        duration_seconds: 30,
        last_used_at: '2026-05-21T00:00:30.000Z',
        model_labels: ['claude-sonnet-4-20250514'],
        latest_model_label: 'claude-sonnet-4-20250514',
        partial: false
      }
    })
    window.usageAnalyticsOps.fetchScopeSummary = vi.fn().mockResolvedValue({
      success: true,
      data: {
        scope_id: 'wt-1',
        scope_type: 'worktree',
        session_count: 1,
        active_session_count: 1,
        total_cost: 0,
        total_tokens: 1_200,
        input_tokens: 700,
        output_tokens: 300,
        cache_write_tokens: 100,
        cache_read_tokens: 100,
        context_used_tokens: null,
        context_window_tokens: null,
        context_percent: null,
        coverage: { synced: 0, partial: 1, legacy_undercounted: 0, missing_source: 0, unsupported: 0 },
        partial_sessions: ['sess-claude-syncing']
      }
    })

    renderHost()

    await waitFor(() => {
      expect(window.usageAnalyticsOps.fetchScopeSummary).toHaveBeenCalledWith(
        'wt-1',
        'worktree',
        ['sess-claude-syncing']
      )
      // Current session and worktree aggregate both show 1.2K
      const elements = screen.getAllByText('1.2K')
      expect(elements.length).toBeGreaterThanOrEqual(1)
      // The higher value (1.2K) wins over live (650)
      expect(screen.queryByText('650')).not.toBeInTheDocument()
    })
  })

  it('does not double-count when scope has no contribution for active session', async () => {
    const sessions = [
      {
        id: 'sess-no-contrib',
        worktree_id: 'wt-1',
        project_id: 'proj-1',
        connection_id: null,
        name: 'No contrib session',
        status: 'active' as const,
        opencode_session_id: 'runtime-no-contrib',
        agent_sdk: 'codex' as const,
        mode: 'build' as const,
        model_provider_id: null,
        model_id: null,
        model_variant: null,
        first_message_at: null,
        created_at: '2026-05-21T00:00:00.000Z',
        updated_at: '2026-05-21T00:00:00.000Z',
        completed_at: null
      }
    ]
    useSessionStore.setState({
      activeSessionId: 'sess-no-contrib',
      activeWorktreeId: 'wt-1',
      sessionsByWorktree: new Map([['wt-1', sessions]]),
      tabOrderByWorktree: new Map([['wt-1', ['sess-no-contrib']]])
    })
    // Live tokens: 418K
    useContextStore.getState().setSessionTokens('sess-no-contrib', {
      input: 280000,
      output: 3000,
      reasoning: 0,
      cacheRead: 135294,
      cacheWrite: 0
    })
    useContextStore.getState().setSessionCost('sess-no-contrib', 1.036941)
    window.db.session.getByWorktree = vi.fn().mockResolvedValue(sessions)
    window.usageAnalyticsOps.fetchSessionSummary = vi.fn().mockResolvedValue({
      success: true,
      data: {
        session_id: 'sess-no-contrib',
        engine: 'codex',
        total_cost: 1.036941,
        total_tokens: 418294,
        input_tokens: 280000,
        output_tokens: 3000,
        cache_write_tokens: 0,
        cache_read_tokens: 135294,
        duration_seconds: 120,
        last_used_at: '2026-05-21T00:02:00.000Z',
        model_labels: ['o3'],
        latest_model_label: 'o3',
        partial: false,
        context_used_tokens: null,
        context_window_tokens: null,
        context_percent: null
      }
    })
    // Scope has NO session_contributions — simulates missing contribution
    window.usageAnalyticsOps.fetchScopeSummary = vi.fn().mockResolvedValue({
      success: true,
      data: {
        scope_id: 'wt-1',
        scope_type: 'worktree',
        session_count: 1,
        active_session_count: 1,
        total_cost: 0.79,
        total_tokens: 239172,
        input_tokens: 147269,
        output_tokens: 383,
        cache_write_tokens: 0,
        cache_read_tokens: 91520,
        context_used_tokens: null,
        context_window_tokens: null,
        context_percent: null,
        coverage: { synced: 1, partial: 0, legacy_undercounted: 0, missing_source: 0, unsupported: 0 },
        partial_sessions: []
        // No session_contributions — renderer must NOT do base - 0 + live
      }
    })

    renderHost()

    await waitFor(() => {
      // Current session shows 418K / $1.04
      expect(screen.getByText('$1.04')).toBeInTheDocument()
      expect(screen.getByText('418.3K')).toBeInTheDocument()
      // Worktree aggregate should be Math.max(239K, 418K) = 418K, NOT 239K + 418K = 657K
      expect(screen.queryByText('657.5K')).not.toBeInTheDocument()
      expect(screen.queryByText('783.5K')).not.toBeInTheDocument()
    })
  })
})
