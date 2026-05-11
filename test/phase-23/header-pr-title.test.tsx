import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { Header } from '@/components/layout/Header'
import { useConnectionStore } from '@/stores/useConnectionStore'
import { useGitStore } from '@/stores/useGitStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'

vi.mock('@/hooks/usePRDetection', () => ({
  usePRDetection: vi.fn()
}))

vi.mock('@/lib/platform', () => ({
  isMac: () => false
}))

vi.mock('@/assets/icon.png', () => ({
  default: 'mock-icon.png'
}))

const listBranchesWithStatusMock = vi.fn()
const getPRStateMock = vi.fn()

const project = {
  id: 'proj-1',
  name: 'Xuanpu',
  path: '/repos/xuanpu',
  description: null,
  tags: null,
  language: null,
  custom_icon: null,
  setup_script: null,
  run_script: null,
  archive_script: null,
  auto_assign_port: false,
  sort_order: 0,
  created_at: '2026-05-09T00:00:00.000Z',
  last_accessed_at: '2026-05-09T00:00:00.000Z'
}

const worktree = {
  id: 'wt-1',
  project_id: 'proj-1',
  name: 'hive-upstream',
  branch_name: 'feat/pr-title',
  path: '/repos/xuanpu/hive-upstream',
  status: 'active' as const,
  is_default: false,
  branch_renamed: 0,
  last_message_at: null,
  session_titles: '[]',
  last_model_provider_id: null,
  last_model_id: null,
  last_model_variant: null,
  created_at: '2026-05-09T00:00:00.000Z',
  last_accessed_at: '2026-05-09T00:00:00.000Z'
}

describe('Header PR title badge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listBranchesWithStatusMock.mockResolvedValue({ success: true, branches: [] })
    getPRStateMock.mockResolvedValue({
      success: true,
      state: 'OPEN',
      title: 'Show PR title in notification widget'
    })

    Object.defineProperty(window, 'gitOps', {
      configurable: true,
      writable: true,
      value: {
        ...window.gitOps,
        listBranchesWithStatus: listBranchesWithStatusMock,
        getPRState: getPRStateMock
      }
    })

    useSettingsStore.setState({ locale: 'en', vimModeEnabled: false })
    useConnectionStore.setState({ connections: [], selectedConnectionId: null })
    useProjectStore.setState({ projects: [project], selectedProjectId: 'proj-1' })
    useWorktreeStore.setState({
      selectedWorktreeId: 'wt-1',
      worktreesByProject: new Map([['proj-1', [worktree]]])
    })
    useGitStore.setState({
      remoteInfo: new Map([
        ['wt-1', { hasRemote: true, isGitHub: true, url: 'https://github.com/org/repo' }]
      ]),
      prCreation: new Map(),
      attachedPR: new Map([['wt-1', { number: 42, url: 'https://github.com/org/repo/pull/42' }]]),
      fileStatusesByWorktree: new Map([['/repos/xuanpu/hive-upstream', []]]),
      branchInfoByWorktree: new Map([
        [
          '/repos/xuanpu/hive-upstream',
          { name: 'feat/pr-title', tracking: 'origin/main', ahead: 0, behind: 0 }
        ]
      ]),
      conflictsByWorktree: {},
      isPushing: false,
      isPulling: false,
      isLoading: false,
      error: null
    })
  })

  test('loads and shows the attached PR title on the badge', async () => {
    render(<Header />)

    await waitFor(() => {
      expect(getPRStateMock).toHaveBeenCalledWith('/repos/xuanpu', 42)
    })

    const badge = screen.getByTestId('pr-badge')

    await waitFor(() => {
      expect(badge).toHaveTextContent('Show PR title in notification widget')
    })
    expect(badge).toHaveAttribute('title', 'PR #42: Show PR title in notification widget')
  })
})
