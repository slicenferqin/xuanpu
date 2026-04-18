import { beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WorktreeItem } from '@/components/worktrees/WorktreeItem'
import { TooltipProvider } from '@/components/ui/tooltip'

/**
 * Session 8: Worktree Row Meta UI — Tests
 *
 * These tests verify:
 * 1. Relative time renders when lastMessageTime exists
 * 2. No time displayed when no last activity exists
 * 3. Time element has tooltip with full date
 * 4. New UI shows type metadata instead of status text
 * 5. Long names use middle truncation
 * 6. Selected rows keep the actions button visible
 */

const mockGetWorktreeStatus = vi.fn().mockReturnValue(null)
const mockLastMessageTimeByWorktree: Record<string, number> = {}

vi.mock('@/stores/useWorktreeStatusStore', () => ({
  useWorktreeStatusStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        getWorktreeStatus: mockGetWorktreeStatus,
        getWorktreeCompletedEntry: () => null,
        clearWorktreeUnread: vi.fn(),
        lastMessageTimeByWorktree: mockLastMessageTimeByWorktree
      }),
    {
      getState: () => ({
        clearWorktreeUnread: vi.fn(),
        getWorktreeStatus: mockGetWorktreeStatus,
        getWorktreeCompletedEntry: () => null,
        lastMessageTimeByWorktree: mockLastMessageTimeByWorktree
      })
    }
  )
}))

const worktreeStoreState = {
  selectedWorktreeId: 'wt-other',
  selectWorktree: vi.fn(),
  archiveWorktree: vi.fn(),
  unbranchWorktree: vi.fn(),
  archivingWorktreeIds: new Set<string>(),
  updateWorktreeBranch: vi.fn()
}

const projectStoreState = {
  selectProject: vi.fn(),
  projects: []
}

const connectionStoreState = {
  connectionModeActive: false,
  connectionModeSourceWorktreeId: null,
  connectionModeSelectedIds: new Set<string>(),
  toggleConnectionModeWorktree: vi.fn(),
  enterConnectionMode: vi.fn()
}

const pinnedStoreState = {
  pinnedWorktreeIds: new Set<string>(),
  pinWorktree: vi.fn(),
  unpinWorktree: vi.fn()
}

const hintStoreState = {
  hintMap: new Map<string, string>(),
  mode: 'jump',
  pendingChar: null,
  actionMode: null,
  inputFocused: false
}

const vimModeStoreState = {
  mode: 'insert'
}

const settingsStoreState = {
  vimModeEnabled: false,
  locale: 'en'
}

vi.mock('@/stores', () => ({
  useWorktreeStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(worktreeStoreState) : worktreeStoreState,
    {
      getState: () => worktreeStoreState
    }
  ),
  useProjectStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(projectStoreState) : projectStoreState,
    {
      getState: () => projectStoreState
    }
  ),
  useConnectionStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(connectionStoreState) : connectionStoreState,
    {
      getState: () => connectionStoreState
    }
  ),
  usePinnedStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(pinnedStoreState) : pinnedStoreState,
    {
      getState: () => pinnedStoreState
    }
  ),
  useHintStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(hintStoreState) : hintStoreState,
    {
      getState: () => hintStoreState
    }
  ),
  useVimModeStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(vimModeStoreState) : vimModeStoreState,
    {
      getState: () => vimModeStoreState
    }
  ),
  useSettingsStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(settingsStoreState) : settingsStoreState,
    {
      getState: () => settingsStoreState
    }
  )
}))

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(settingsStoreState) : settingsStoreState,
    {
      getState: () => settingsStoreState,
      subscribe: vi.fn(() => () => {})
    }
  )
}))

vi.mock('@/stores/useGitStore', () => ({
  useGitStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      branchInfoByWorktree: new Map()
    })
}))

vi.mock('@/stores/useFileViewerStore', () => ({
  useFileViewerStore: {
    getState: () => ({
      openContextEditor: vi.fn()
    })
  }
}))

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  gitToast: { worktreeArchived: vi.fn(), operationFailed: vi.fn() },
  clipboardToast: { copied: vi.fn() }
}))

const mockWorktree = {
  id: 'wt-1',
  project_id: 'proj-1',
  name: 'feature/auth',
  branch_name: 'feature/auth',
  path: '/path/to/worktree',
  status: 'active' as const,
  is_default: false,
  last_message_at: null,
  created_at: '2025-01-01T00:00:00Z',
  last_accessed_at: '2025-01-01T00:00:00Z',
  attachments: '[]'
}

function renderWorktreeItem(worktree = mockWorktree): void {
  render(
    <TooltipProvider>
      <WorktreeItem worktree={worktree} projectPath="/project" />
    </TooltipProvider>
  )
}

describe('Session 8: Worktree Row Meta UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    worktreeStoreState.selectedWorktreeId = 'wt-other'
    connectionStoreState.connectionModeActive = false

    for (const key of Object.keys(mockLastMessageTimeByWorktree)) {
      delete mockLastMessageTimeByWorktree[key]
    }
  })

  test('renders relative time when lastMessageTime exists', () => {
    mockLastMessageTimeByWorktree['wt-1'] = Date.now() - 120000

    renderWorktreeItem()

    const timeEl = screen.getByTestId('worktree-last-message-time')
    expect(timeEl).toBeDefined()
    expect(timeEl.textContent).toBe('2m')
  })

  test('does not render time when no last activity exists', () => {
    renderWorktreeItem({ ...mockWorktree, last_accessed_at: '' })

    expect(screen.queryByTestId('worktree-last-message-time')).toBeNull()
  })

  test('time element has tooltip with full date', () => {
    const timestamp = Date.now() - 3600000
    mockLastMessageTimeByWorktree['wt-1'] = timestamp

    renderWorktreeItem()

    const timeEl = screen.getByTestId('worktree-last-message-time')
    expect(timeEl.getAttribute('title')).toBe(new Date(timestamp).toLocaleString())
  })

  test('renders branch metadata instead of status text', () => {
    mockLastMessageTimeByWorktree['wt-1'] = Date.now() - 60000

    renderWorktreeItem()

    expect(screen.queryByTestId('worktree-status-text')).toBeNull()

    const metaEl = screen.getByTestId('worktree-meta-type')
    expect(metaEl.textContent).toBe('Branch')

    const timeEl = screen.getByTestId('worktree-last-message-time')
    expect(timeEl.textContent).toBe('1m')
  })

  test('uses middle truncation for long primary labels', () => {
    renderWorktreeItem({
      ...mockWorktree,
      name: 'fix/codex-transcript-super-long-branch-name',
      branch_name: 'fix/codex-transcript-super-long-branch-name'
    })

    const nameEl = screen.getByTestId('worktree-primary-name')
    expect(nameEl.textContent).toContain('…')
    expect(nameEl.textContent).not.toBe('fix/codex-transcript-super-long-branch-name')
  })

  test('keeps actions visible on the selected row', () => {
    worktreeStoreState.selectedWorktreeId = 'wt-1'

    renderWorktreeItem()

    const actionsEl = screen.getByTestId('worktree-actions-wt-1')
    expect(actionsEl.className).toContain('opacity-100')
  })
})
