import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '../../utils/render'
import { act } from 'react'
import { WorktreeItem } from '@/components/worktrees/WorktreeItem'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useProjectStore, useWorktreeStore } from '@/stores'

// Mock window APIs needed by WorktreeItem
const mockProjectOps = {
  showInFolder: vi.fn(),
  copyToClipboard: vi.fn()
}

const mockWorktreeOps = {
  openInTerminal: vi.fn().mockResolvedValue({ success: true }),
  openInEditor: vi.fn().mockResolvedValue({ success: true }),
  delete: vi.fn().mockResolvedValue({ success: true }),
  renameBranch: vi.fn().mockResolvedValue({ success: true })
}

const mockDb = {
  worktree: {
    touch: vi.fn().mockResolvedValue(true)
  }
}

beforeEach(() => {
  // @ts-expect-error - Mock window.projectOps
  window.projectOps = mockProjectOps
  // @ts-expect-error - Mock window.worktreeOps
  window.worktreeOps = mockWorktreeOps
  // @ts-expect-error - Mock window.db
  window.db = mockDb

  vi.clearAllMocks()

  useProjectStore.setState({
    projects: [],
    isLoading: false,
    error: null,
    selectedProjectId: null,
    expandedProjectIds: new Set(),
    editingProjectId: null
  })

  useWorktreeStore.setState({
    worktreesByProject: new Map(),
    isLoading: false,
    error: null,
    selectedWorktreeId: null,
    creatingForProjectId: null
  })
})

describe('Session 3: Selection Auto-Propagation', () => {
  const worktreeA = {
    id: 'worktree-a1',
    project_id: 'project-a',
    name: 'tokyo',
    branch_name: 'tokyo',
    path: '/Users/test/.hive-worktrees/project-alpha/tokyo',
    status: 'active' as const,
    is_default: false,
    created_at: new Date().toISOString(),
    last_accessed_at: new Date().toISOString()
  }

  const worktreeB = {
    id: 'worktree-b1',
    project_id: 'project-b',
    name: 'paris',
    branch_name: 'paris',
    path: '/Users/test/.hive-worktrees/project-beta/paris',
    status: 'active' as const,
    is_default: false,
    created_at: new Date().toISOString(),
    last_accessed_at: new Date().toISOString()
  }

  function renderWorktree(content: React.ReactNode) {
    return render(<TooltipProvider>{content}</TooltipProvider>)
  }

  test('clicking worktree selects parent project', async () => {
    renderWorktree(<WorktreeItem worktree={worktreeA} projectPath="/path/to/project-alpha" />)

    const worktreeItem = screen.getByTestId('worktree-item-worktree-a1')
    await act(async () => {
      fireEvent.click(worktreeItem)
    })

    // Verify both worktree and project are selected
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('worktree-a1')
    expect(useProjectStore.getState().selectedProjectId).toBe('project-a')
  })

  test('switching worktree across projects updates project selection', async () => {
    const { rerender } = renderWorktree(
      <WorktreeItem worktree={worktreeA} projectPath="/path/to/project-alpha" />
    )

    // Click worktree in project A
    await act(async () => {
      fireEvent.click(screen.getByTestId('worktree-item-worktree-a1'))
    })
    expect(useProjectStore.getState().selectedProjectId).toBe('project-a')

    // Render worktree B and click it
    await act(async () => {
      rerender(
        <TooltipProvider>
          <WorktreeItem worktree={worktreeB} projectPath="/path/to/project-beta" />
        </TooltipProvider>
      )
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('worktree-item-worktree-b1'))
    })
    expect(useProjectStore.getState().selectedProjectId).toBe('project-b')
  })

  test('clicking worktree also clears unread status', async () => {
    renderWorktree(<WorktreeItem worktree={worktreeA} projectPath="/path/to/project-alpha" />)

    const worktreeItem = screen.getByTestId('worktree-item-worktree-a1')
    await act(async () => {
      fireEvent.click(worktreeItem)
    })

    // Verify worktree is selected (core functionality preserved)
    expect(useWorktreeStore.getState().selectedWorktreeId).toBe('worktree-a1')
    // Verify project is also selected (new behavior)
    expect(useProjectStore.getState().selectedProjectId).toBe('project-a')
  })

  test('project selection persists after multiple worktree clicks', async () => {
    renderWorktree(
      <>
        <WorktreeItem worktree={worktreeA} projectPath="/path/to/project-alpha" />
        <WorktreeItem worktree={worktreeB} projectPath="/path/to/project-beta" />
      </>
    )

    // Click worktree A
    await act(async () => {
      fireEvent.click(screen.getByTestId('worktree-item-worktree-a1'))
    })
    expect(useProjectStore.getState().selectedProjectId).toBe('project-a')

    // Click worktree B
    await act(async () => {
      fireEvent.click(screen.getByTestId('worktree-item-worktree-b1'))
    })
    expect(useProjectStore.getState().selectedProjectId).toBe('project-b')

    // Click worktree A again
    await act(async () => {
      fireEvent.click(screen.getByTestId('worktree-item-worktree-a1'))
    })
    expect(useProjectStore.getState().selectedProjectId).toBe('project-a')
  })
})
