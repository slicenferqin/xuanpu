import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mock ALL stores Header.tsx imports (must be before component import)
// ---------------------------------------------------------------------------

const layoutState = {
  rightSidebarCollapsed: false,
  toggleRightSidebar: vi.fn()
}

vi.mock('@/stores/useLayoutStore', () => {
  const useLayoutStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof layoutState) => unknown)(layoutState)
      : layoutState
  )
  useLayoutStore.getState = vi.fn(() => layoutState)
  useLayoutStore.subscribe = vi.fn(() => () => {})
  return { useLayoutStore }
})

const sessionHistoryState = { openPanel: vi.fn() }

vi.mock('@/stores/useSessionHistoryStore', () => {
  const useSessionHistoryStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof sessionHistoryState) => unknown)(sessionHistoryState)
      : sessionHistoryState
  )
  useSessionHistoryStore.getState = vi.fn(() => sessionHistoryState)
  useSessionHistoryStore.subscribe = vi.fn(() => () => {})
  return { useSessionHistoryStore }
})

const settingsState = {
  openSettings: vi.fn(),
  vimModeEnabled: true,
  keepAwakeEnabled: false,
  locale: 'en',
  defaultAgentSdk: 'codex',
  selectedModel: null,
  selectedModelByProvider: {},
  showModelProvider: false,
  favoriteModels: [] as string[],
  toggleFavoriteModel: vi.fn(),
  getModelVariantDefault: vi.fn(() => null),
  setModelVariantDefault: vi.fn(),
  setSelectedModelForSdk: vi.fn()
}

vi.mock('@/stores/useSettingsStore', () => {
  const useSettingsStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof settingsState) => unknown)(settingsState)
      : settingsState
  )
  useSettingsStore.getState = vi.fn(() => settingsState)
  useSettingsStore.subscribe = vi.fn(() => () => {})
  return {
    useSettingsStore,
    resolveModelForSdk: vi.fn(() => ({
      providerID: 'openai',
      modelID: 'gpt-5.4',
      variant: undefined
    }))
  }
})

const projectState = { selectedProjectId: null, projects: [] as unknown[] }

vi.mock('@/stores/useProjectStore', () => {
  const useProjectStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof projectState) => unknown)(projectState)
      : projectState
  )
  useProjectStore.getState = vi.fn(() => projectState)
  useProjectStore.subscribe = vi.fn(() => () => {})
  return { useProjectStore }
})

const worktreeState = {
  selectedWorktreeId: null,
  worktreesByProject: new Map()
}

vi.mock('@/stores/useWorktreeStore', () => {
  const useWorktreeStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof worktreeState) => unknown)(worktreeState)
      : worktreeState
  )
  useWorktreeStore.getState = vi.fn(() => worktreeState)
  useWorktreeStore.subscribe = vi.fn(() => () => {})
  return { useWorktreeStore }
})

const connectionState = {
  selectedConnectionId: null,
  connections: [] as unknown[]
}

vi.mock('@/stores/useConnectionStore', () => {
  const useConnectionStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof connectionState) => unknown)(connectionState)
      : connectionState
  )
  useConnectionStore.getState = vi.fn(() => connectionState)
  useConnectionStore.subscribe = vi.fn(() => () => {})
  return { useConnectionStore }
})

const sessionState = {
  createSession: vi.fn(),
  updateSessionName: vi.fn(),
  setPendingMessage: vi.fn(),
  setActiveSession: vi.fn(),
  setSessionModel: vi.fn(),
  activeSessionId: null as string | null,
  inlineConnectionSessionId: null as string | null,
  sessionsByWorktree: new Map<string, unknown[]>(),
  sessionsByConnection: new Map<string, unknown[]>()
}

vi.mock('@/stores/useSessionStore', () => {
  const useSessionStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof sessionState) => unknown)(sessionState)
      : sessionState
  )
  useSessionStore.getState = vi.fn(() => sessionState)
  useSessionStore.subscribe = vi.fn(() => () => {})
  return { useSessionStore }
})

const gitState = {
  conflictsByWorktree: {},
  remoteInfo: new Map(),
  prTargetBranch: new Map(),
  setPrTargetBranch: vi.fn(),
  reviewTargetBranch: new Map(),
  setReviewTargetBranch: vi.fn(),
  branchInfoByWorktree: new Map(),
  isPushing: false,
  isPulling: false,
  prInfo: new Map(),
  fileStatusesByWorktree: new Map(),
  refreshStatuses: vi.fn()
}

vi.mock('@/stores/useGitStore', () => {
  const useGitStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof gitState) => unknown)(gitState)
      : gitState
  )
  useGitStore.getState = vi.fn(() => gitState)
  useGitStore.subscribe = vi.fn(() => () => {})
  return { useGitStore }
})

const worktreeStatusState = { sessionStatuses: {} }

vi.mock('@/stores/useWorktreeStatusStore', () => {
  const useWorktreeStatusStore = vi.fn((selector?: unknown) =>
    typeof selector === 'function'
      ? (selector as (s: typeof worktreeStatusState) => unknown)(worktreeStatusState)
      : worktreeStatusState
  )
  useWorktreeStatusStore.getState = vi.fn(() => worktreeStatusState)
  useWorktreeStatusStore.subscribe = vi.fn(() => () => {})
  return { useWorktreeStatusStore }
})

// ---------------------------------------------------------------------------
// Mock non-store dependencies
// ---------------------------------------------------------------------------

vi.mock('@/hooks/usePRDetection', () => ({
  usePRDetection: vi.fn()
}))

vi.mock('@/assets/icon.png', () => ({
  default: 'test-icon.png'
}))

vi.mock('@/components/layout/QuickActions', () => ({
  QuickActions: () => <div data-testid="quick-actions" />
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }
}))

// ---------------------------------------------------------------------------
// Real store (what we're testing)
// ---------------------------------------------------------------------------

import { useVimModeStore } from '@/stores/useVimModeStore'
import { useContextStore } from '@/stores/useContextStore'

// ---------------------------------------------------------------------------
// Import component under test AFTER mocks
// ---------------------------------------------------------------------------

import { Header } from '@/components/layout/Header'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStores(): void {
  useVimModeStore.setState({
    mode: 'normal',
    helpOverlayOpen: false
  })
  sessionState.activeSessionId = null
  sessionState.inlineConnectionSessionId = null
  sessionState.sessionsByWorktree = new Map()
  sessionState.sessionsByConnection = new Map()
  useContextStore.setState({
    tokensBySession: {},
    modelBySession: {},
    contextSnapshotsBySession: {},
    costBySession: {},
    costEventKeysBySession: {},
    modelLimits: {}
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Header mode pill', () => {
  beforeEach(() => {
    resetStores()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders NORMAL pill when vim mode is normal', () => {
    useVimModeStore.setState({ mode: 'normal' })

    render(<Header />)

    const pill = screen.getByTestId('vim-mode-pill')
    expect(pill).toBeInTheDocument()
    expect(pill.textContent).toBe('NORMAL')
  })

  it('renders INSERT pill when vim mode is insert', () => {
    useVimModeStore.setState({ mode: 'insert' })

    render(<Header />)

    const pill = screen.getByTestId('vim-mode-pill')
    expect(pill).toBeInTheDocument()
    expect(pill.textContent).toBe('INSERT')
  })

  it('has muted styling classes in normal mode', () => {
    useVimModeStore.setState({ mode: 'normal' })

    render(<Header />)

    const pill = screen.getByTestId('vim-mode-pill')
    expect(pill.className).toContain('text-muted-foreground')
    expect(pill.className).toContain('bg-muted/50')
    expect(pill.className).toContain('border-border/50')
  })

  it('has primary styling classes in insert mode', () => {
    useVimModeStore.setState({ mode: 'insert' })

    render(<Header />)

    const pill = screen.getByTestId('vim-mode-pill')
    expect(pill.className).toContain('text-primary')
    expect(pill.className).toContain('bg-primary/10')
    expect(pill.className).toContain('border-primary/30')
  })

  it('keeps the header visible when an active session is present', async () => {
    Object.defineProperty(window, 'agentOps', {
      configurable: true,
      writable: true,
      value: {
        ...(window.agentOps ?? {}),
        listModels: vi.fn().mockResolvedValue({
          success: true,
          providers: [
            {
              id: 'openai',
              name: 'OpenAI',
              models: {
                'gpt-5.4': { id: 'gpt-5.4', name: 'GPT-5.4' }
              }
            }
          ]
        })
      }
    })

    sessionState.activeSessionId = 'session-1'
    sessionState.sessionsByWorktree = new Map([
      [
        'worktree-1',
        [
          {
            id: 'session-1',
            name: 'Infra session',
            agent_sdk: 'codex',
            model_id: 'gpt-5.4',
            model_provider_id: 'openai'
          }
        ]
      ]
    ])
    useContextStore.setState({
      tokensBySession: {
        'session-1': {
          input: 100_000,
          output: 20_000,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0
        }
      },
      costBySession: {
        'session-1': 1.2345
      },
      modelLimits: {
        'openai::gpt-5.4': 200_000
      }
    })

    render(<Header />)

    expect(screen.getByTestId('header')).toBeInTheDocument()
    expect(screen.getByText('Xuanpu')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('header-session-glance')).toBeInTheDocument()
      expect(screen.getByTestId('model-selector')).toBeInTheDocument()
    })
    expect(screen.getByTestId('header-context-meter')).toBeInTheDocument()
    expect(screen.getByTestId('header-context-meter-fill')).toHaveStyle({ width: '50%' })
    expect(screen.getByTestId('header-cost-pill')).toHaveTextContent('$1.2345')
    expect(screen.queryByText(/tokens/i)).not.toBeInTheDocument()
  })

  it('uses the default Claude context limit when model metadata has not arrived', async () => {
    Object.defineProperty(window, 'agentOps', {
      configurable: true,
      writable: true,
      value: {
        ...(window.agentOps ?? {}),
        listModels: vi.fn().mockResolvedValue({
          success: true,
          providers: [
            {
              id: 'anthropic',
              name: 'Anthropic',
              models: {
                opus: { id: 'opus', name: 'Opus 4.7' }
              }
            }
          ]
        })
      }
    })

    sessionState.activeSessionId = 'session-claude'
    sessionState.sessionsByWorktree = new Map([
      [
        'worktree-1',
        [
          {
            id: 'session-claude',
            name: 'Claude session',
            agent_sdk: 'claude-code',
            model_id: 'opus',
            model_provider_id: 'claude-code'
          }
        ]
      ]
    ])
    useContextStore.setState({
      tokensBySession: {
        'session-claude': {
          input: 183_100,
          output: 42_000,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0
        }
      }
    })

    render(<Header />)

    await waitFor(() => {
      expect(screen.getByTestId('header-context-meter')).toBeInTheDocument()
    })
    expect(screen.getByTestId('header-context-meter-fill')).toHaveStyle({ width: '92%' })
  })
})
