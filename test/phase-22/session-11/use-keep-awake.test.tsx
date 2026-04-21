import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

let settingsState = { keepAwakeEnabled: false }
let worktreeStatusState: {
  sessionStatuses: Record<string, { status: string; timestamp: number } | null>
} = {
  sessionStatuses: {}
}
let sessionState: {
  sessionsByWorktree: Map<string, Array<{ id: string }>>
  sessionsByConnection: Map<string, Array<{ id: string }>>
} = {
  sessionsByWorktree: new Map(),
  sessionsByConnection: new Map()
}

const mockSetKeepAwakeEnabled = vi.fn()

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector?: (state: typeof settingsState) => unknown) =>
      selector ? selector(settingsState) : settingsState,
    {
      getState: () => settingsState
    }
  )
}))

vi.mock('@/stores/useWorktreeStatusStore', () => ({
  useWorktreeStatusStore: Object.assign(
    (selector?: (state: typeof worktreeStatusState) => unknown) =>
      selector ? selector(worktreeStatusState) : worktreeStatusState,
    {
      getState: () => worktreeStatusState
    }
  )
}))

vi.mock('@/stores/useSessionStore', () => ({
  useSessionStore: Object.assign(
    (selector?: (state: typeof sessionState) => unknown) =>
      selector ? selector(sessionState) : sessionState,
    {
      getState: () => sessionState
    }
  )
}))

import { useKeepAwake } from '../../../src/renderer/src/hooks/useKeepAwake'

function Harness(): React.JSX.Element | null {
  useKeepAwake()
  return null
}

describe('useKeepAwake', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settingsState = { keepAwakeEnabled: false }
    worktreeStatusState = { sessionStatuses: {} }
    sessionState = {
      sessionsByWorktree: new Map(),
      sessionsByConnection: new Map()
    }

    Object.defineProperty(window, 'systemOps', {
      writable: true,
      configurable: true,
      value: {
        setKeepAwakeEnabled: mockSetKeepAwakeEnabled.mockResolvedValue({ success: true })
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('disables keep-awake when the setting is off', async () => {
    render(<Harness />)

    await waitFor(() => {
      expect(mockSetKeepAwakeEnabled).toHaveBeenCalledWith(false)
    })
  })

  it('enables keep-awake when a worktree session is planning', async () => {
    settingsState.keepAwakeEnabled = true
    sessionState.sessionsByWorktree = new Map([['wt-1', [{ id: 'session-1' }]]])
    worktreeStatusState.sessionStatuses = {
      'session-1': { status: 'planning', timestamp: Date.now() }
    }

    render(<Harness />)

    await waitFor(() => {
      expect(mockSetKeepAwakeEnabled).toHaveBeenCalledWith(true)
    })
  })

  it('enables keep-awake when a connection session is working', async () => {
    settingsState.keepAwakeEnabled = true
    sessionState.sessionsByConnection = new Map([['conn-1', [{ id: 'session-2' }]]])
    worktreeStatusState.sessionStatuses = {
      'session-2': { status: 'working', timestamp: Date.now() }
    }

    render(<Harness />)

    await waitFor(() => {
      expect(mockSetKeepAwakeEnabled).toHaveBeenCalledWith(true)
    })
  })

  it('ignores non-blocking statuses like permission and completed', async () => {
    settingsState.keepAwakeEnabled = true
    sessionState.sessionsByWorktree = new Map([
      ['wt-1', [{ id: 'session-3' }, { id: 'session-4' }]]
    ])
    worktreeStatusState.sessionStatuses = {
      'session-3': { status: 'permission', timestamp: Date.now() },
      'session-4': { status: 'completed', timestamp: Date.now() }
    }

    render(<Harness />)

    await waitFor(() => {
      expect(mockSetKeepAwakeEnabled).toHaveBeenCalledWith(false)
    })
  })
})
