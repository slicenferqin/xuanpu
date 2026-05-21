import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextPanelHost } from '@/components/context-panel/ContextPanelHost'
import { useLayoutStore } from '@/stores/useLayoutStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useContextStore } from '@/stores/useContextStore'
import { useSessionRuntimeStore } from '@/stores/useSessionRuntimeStore'
import type { TimelineMessage } from '@shared/lib/timeline-types'

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

function renderHost(): void {
  render(<ContextPanelHost worktreePath="/tmp/worktree" onClose={vi.fn()} onFileClick={vi.fn()} />)
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
      rightContextTab: 'overview',
      rightReviewTab: 'changes'
    })
    useSessionStore.setState({
      activeSessionId: null,
      inlineConnectionSessionId: null
    })
    useSettingsStore.setState({ vimModeEnabled: true })
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

  it('keeps vim right-sidebar tab events compatible with review sub-tabs', () => {
    renderHost()

    act(() => {
      window.dispatchEvent(new CustomEvent('hive:right-sidebar-tab', { detail: { tab: 'diffs' } }))
    })

    expect(screen.getByTestId('branch-diff-view')).toBeInTheDocument()
    expect(useLayoutStore.getState().rightContextTab).toBe('review')
    expect(useLayoutStore.getState().rightReviewTab).toBe('diffs')
  })

  it('renders latest session tasks from the shared timeline extraction helper', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ activeSessionId: 'sess-1' })
    window.agentOps.getTimeline = vi.fn().mockResolvedValue({ messages: todoTimeline() })

    renderHost()
    await user.click(screen.getByTestId('context-panel-tab-tasks'))

    await waitFor(() => {
      expect(screen.getByText('Move tasks into the context panel')).toBeInTheDocument()
    })
  })

  it('prefers live task snapshots over the persisted timeline in the tasks panel', async () => {
    const user = userEvent.setup()
    useSessionStore.setState({ activeSessionId: 'sess-live' })
    useSessionRuntimeStore.getState().setSessionTasks('sess-live', [
      {
        id: 'live-task',
        content: 'Live task from streaming update',
        status: 'in_progress'
      }
    ])
    window.agentOps.getTimeline = vi.fn().mockResolvedValue({ messages: todoTimeline() })

    renderHost()
    await user.click(screen.getByTestId('context-panel-tab-tasks'))

    expect(screen.getByText('Live task from streaming update')).toBeInTheDocument()
    expect(screen.queryByText('Move tasks into the context panel')).not.toBeInTheDocument()
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

  it('shows cumulative usage summary in the overview panel', async () => {
    useSessionStore.setState({ activeSessionId: 'sess-usage' })
    window.usageAnalyticsOps.fetchSessionSummary = vi.fn().mockResolvedValue({
      success: true,
      data: {
        session_id: 'sess-usage',
        engine: 'codex',
        total_cost: 0.0234,
        total_tokens: 12_000,
        input_tokens: 3_000,
        output_tokens: 7_000,
        cache_write_tokens: 500,
        cache_read_tokens: 1_500,
        duration_seconds: 120,
        last_used_at: '2026-05-21T00:00:00.000Z',
        model_labels: [],
        latest_model_label: null,
        partial: false
      }
    })

    renderHost()

    await waitFor(() => {
      expect(screen.getByText('$0.02')).toBeInTheDocument()
      expect(screen.getByText('12.0K')).toBeInTheDocument()
      expect(screen.getByText('3.0K')).toBeInTheDocument()
      expect(screen.getByText('1.5K')).toBeInTheDocument()
    })
  })
})
