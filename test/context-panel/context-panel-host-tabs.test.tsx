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
        fetchSessionSummary: vi.fn().mockResolvedValue({ success: false })
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
        getCheckpoint: vi.fn().mockResolvedValue(null)
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
    const sessions = ['sess-usage-a', 'sess-usage-b'].map((id, index) => ({
      id,
      worktree_id: 'wt-1',
      project_id: 'proj-1',
      connection_id: null,
      name: `Session ${index + 1}`,
      status: 'active' as const,
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
    window.usageAnalyticsOps.fetchSessionSummary = vi.fn(async (sessionId: string) => {
      const dataBySession = {
        'sess-usage-a': {
          session_id: 'sess-usage-a',
          engine: 'codex',
          total_cost: 0.0234,
          total_tokens: 12_000,
          input_tokens: 3_000,
          output_tokens: 7_000,
          cache_write_tokens: 500,
          cache_read_tokens: 1_500
        },
        'sess-usage-b': {
          session_id: 'sess-usage-b',
          engine: 'codex',
          total_cost: 0.033,
          total_tokens: 5_500,
          input_tokens: 1_100,
          output_tokens: 2_200,
          cache_write_tokens: 700,
          cache_read_tokens: 1_500
        }
      } as const
      const data = dataBySession[sessionId as keyof typeof dataBySession]
      return {
        success: !!data,
        data: data
          ? {
              ...data,
              duration_seconds: 120,
              last_used_at: '2026-05-21T00:00:00.000Z',
              model_labels: [],
              latest_model_label: null,
              partial: false
            }
          : undefined
      }
    })

    renderHost()

    await waitFor(() => {
      expect(screen.getByText('$0.06')).toBeInTheDocument()
      expect(screen.getByText('17.5K')).toBeInTheDocument()
      expect(screen.getByText('4.1K')).toBeInTheDocument()
      expect(screen.getByText('9.2K')).toBeInTheDocument()
      expect(screen.getByText('3.0K')).toBeInTheDocument()
      expect(screen.getByText('2 sessions in this Worktree')).toBeInTheDocument()
    })
  })
})
