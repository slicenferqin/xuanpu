import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '../utils/render'
import { SettingsArchivedChats } from '../../src/renderer/src/components/settings/SettingsArchivedChats'
import { useSessionStore } from '../../src/renderer/src/stores/useSessionStore'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'

const searchMock = vi.fn()
const restoreMock = vi.fn()

const activeArchivedSession: SessionWithWorktree = {
  id: 'session-active-archived',
  worktree_id: 'worktree-1',
  project_id: 'project-1',
  connection_id: null,
  name: 'Archived active session',
  status: 'archived',
  opencode_session_id: 'opc-1',
  agent_sdk: 'claude-code',
  mode: 'build',
  model_provider_id: 'anthropic',
  model_id: 'opus',
  model_variant: null,
  created_at: '2026-04-18T08:00:00.000Z',
  updated_at: '2026-04-18T09:00:00.000Z',
  completed_at: '2026-04-18T09:00:00.000Z',
  project_name: 'Xuanpu',
  worktree_name: 'fix-branch',
  worktree_branch_name: 'fix-branch',
  worktree_status: 'active'
}

const archivedWorktreeSession: SessionWithWorktree = {
  ...activeArchivedSession,
  id: 'session-archived-worktree',
  name: 'Archived worktree session',
  worktree_status: 'archived'
}

describe('SettingsArchivedChats', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    const setActiveSession = vi.fn()
    const loadSessions = vi.fn().mockResolvedValue(undefined)
    const loadConnectionSessions = vi.fn().mockResolvedValue(undefined)
    const closeSettings = vi.fn()

    const sessionStorePatch: Partial<ReturnType<typeof useSessionStore.getState>> = {
      setActiveSession,
      loadSessions,
      loadConnectionSessions
    }
    const settingsStorePatch: Partial<ReturnType<typeof useSettingsStore.getState>> = {
      locale: 'en',
      closeSettings
    }

    useSessionStore.setState(sessionStorePatch)
    useSettingsStore.setState(settingsStorePatch)

    Object.defineProperty(window, 'db', {
      value: {
        session: {
          search: searchMock,
          restore: restoreMock
        }
      },
      configurable: true
    })
  })

  it('disables restore when the parent worktree is archived', async () => {
    searchMock.mockResolvedValue([archivedWorktreeSession])

    render(<SettingsArchivedChats />)

    await waitFor(() => {
      expect(searchMock).toHaveBeenCalled()
    })

    expect(searchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        includeArchived: true,
        statusFilter: 'closed'
      })
    )

    expect(screen.getByText('Archived worktree session')).toBeTruthy()
    expect(screen.getByText('Parent worktree is archived')).toBeTruthy()
    expect(screen.getByTestId('archived-chat-restore-session-archived-worktree')).toBeDisabled()
  })

  it('restores archived sessions on active worktrees and removes them from the list', async () => {
    const user = userEvent.setup()
    searchMock.mockResolvedValue([activeArchivedSession])
    restoreMock.mockResolvedValue({
      ...activeArchivedSession,
      status: 'active'
    })

    render(<SettingsArchivedChats />)

    await waitFor(() => {
      expect(screen.getByText('Archived active session')).toBeTruthy()
    })

    await user.click(screen.getByTestId('archived-chat-restore-session-active-archived'))

    await waitFor(() => {
      expect(restoreMock).toHaveBeenCalledWith('session-active-archived')
    })
    expect(useSessionStore.getState().loadSessions).toHaveBeenCalledWith('worktree-1', 'project-1')
    await waitFor(() => {
      expect(screen.queryByText('Archived active session')).toBeNull()
    })
  })

  it('opens archived sessions in read-only mode without restoring them', async () => {
    const user = userEvent.setup()
    searchMock.mockResolvedValue([activeArchivedSession])

    render(<SettingsArchivedChats />)

    await waitFor(() => {
      expect(screen.getByText('Archived active session')).toBeTruthy()
    })

    await user.click(screen.getByTestId('archived-chat-open-session-active-archived'))

    expect(useSessionStore.getState().setActiveSession).toHaveBeenCalledWith(
      'session-active-archived'
    )
    expect(useSettingsStore.getState().closeSettings).toHaveBeenCalled()
    expect(restoreMock).not.toHaveBeenCalled()
  })
})
