import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

let mockSettingsState: {
  initialSetupComplete: boolean
  isLoading: boolean
  updateSetting: ReturnType<typeof vi.fn>
}

let wizardProps: {
  result: OnboardingDoctorResult | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  onComplete: (sdk: 'claude-code' | 'codex' | 'opencode' | 'terminal') => void
} | null = null

vi.mock('@/stores/useSettingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector?: (s: unknown) => unknown) => {
      return selector ? selector(mockSettingsState) : mockSettingsState
    },
    {
      getState: () => mockSettingsState
    }
  )
}))

vi.mock('@/components/setup/AgentSetupWizard', () => ({
  AgentSetupWizard: (props: {
    result: OnboardingDoctorResult | null
    loading: boolean
    error: string | null
    onRefresh: () => void
    onComplete: (sdk: 'claude-code' | 'codex' | 'opencode' | 'terminal') => void
  }) => {
    wizardProps = props

    return (
      <div data-testid="agent-setup-wizard">
        <div data-testid="doctor-loading">{String(props.loading)}</div>
        <div data-testid="doctor-error">{props.error ?? ''}</div>
        <div data-testid="recommended-agent">{props.result?.recommendedAgent ?? ''}</div>
        <button data-testid="wizard-refresh" onClick={() => props.onRefresh()}>
          refresh
        </button>
        <button data-testid="wizard-complete-codex" onClick={() => props.onComplete('codex')}>
          complete codex
        </button>
      </div>
    )
  }
}))

const mockRunOnboardingDoctor = vi.fn()
const mockTrack = vi.fn()

const doctorResult: OnboardingDoctorResult = {
  platform: 'darwin',
  environmentChecks: [
    { id: 'git', status: 'ready', reason: 'installed', version: '2.44.0' },
    { id: 'node', status: 'ready', reason: 'installed', version: 'v20.12.0' }
  ],
  agents: [
    {
      id: 'claude-code',
      status: 'ready',
      reason: 'ready',
      installed: true,
      selectable: true,
      version: '1.2.3',
      authStatus: 'authenticated'
    },
    {
      id: 'codex',
      status: 'ready',
      reason: 'ready',
      installed: true,
      selectable: true,
      version: '0.36.0',
      authStatus: 'authenticated'
    },
    {
      id: 'opencode',
      status: 'warning',
      reason: 'login_required',
      installed: true,
      selectable: false,
      version: '0.9.0',
      authStatus: 'unknown'
    }
  ],
  recommendedAgent: 'codex'
}

describe('AgentSetupGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wizardProps = null

    mockSettingsState = {
      initialSetupComplete: false,
      isLoading: false,
      updateSetting: vi.fn()
    }

    Object.defineProperty(window, 'systemOps', {
      writable: true,
      configurable: true,
      value: {
        runOnboardingDoctor: mockRunOnboardingDoctor,
        quitApp: vi.fn()
      }
    })

    Object.defineProperty(window, 'analyticsOps', {
      writable: true,
      configurable: true,
      value: {
        track: mockTrack
      }
    })
  })

  it('requests onboarding doctor results and passes them to the wizard', async () => {
    mockRunOnboardingDoctor.mockResolvedValue(doctorResult)

    const { AgentSetupGuard } = await import('@/components/setup/AgentSetupGuard')
    render(<AgentSetupGuard />)

    await waitFor(() => {
      expect(screen.getByTestId('recommended-agent')).toHaveTextContent('codex')
    })

    expect(mockRunOnboardingDoctor).toHaveBeenCalledTimes(1)
    expect(wizardProps?.loading).toBe(false)
    expect(wizardProps?.result).toEqual(doctorResult)
  })

  it('completes setup through the wizard callback and records analytics', async () => {
    mockRunOnboardingDoctor.mockResolvedValue(doctorResult)

    const { AgentSetupGuard } = await import('@/components/setup/AgentSetupGuard')
    render(<AgentSetupGuard />)

    await waitFor(() => {
      expect(screen.getByTestId('recommended-agent')).toHaveTextContent('codex')
    })

    fireEvent.click(screen.getByTestId('wizard-complete-codex'))

    expect(mockSettingsState.updateSetting).toHaveBeenCalledWith('defaultAgentSdk', 'codex')
    expect(mockSettingsState.updateSetting).toHaveBeenCalledWith('initialSetupComplete', true)
    expect(mockTrack).toHaveBeenCalledWith('onboarding_completed', {
      sdk: 'codex',
      auto_selected: false,
      wizard: true,
      ready_agents: 2
    })
  })

  it('surfaces onboarding doctor errors and refreshes on demand', async () => {
    mockRunOnboardingDoctor
      .mockRejectedValueOnce(new Error('doctor failed'))
      .mockResolvedValueOnce(doctorResult)

    const { AgentSetupGuard } = await import('@/components/setup/AgentSetupGuard')
    render(<AgentSetupGuard />)

    await waitFor(() => {
      expect(screen.getByTestId('doctor-error')).toHaveTextContent('doctor failed')
    })

    fireEvent.click(screen.getByTestId('wizard-refresh'))

    await waitFor(() => {
      expect(screen.getByTestId('recommended-agent')).toHaveTextContent('codex')
    })

    expect(mockRunOnboardingDoctor).toHaveBeenCalledTimes(2)
  })

  it('renders nothing when setup is already complete', async () => {
    mockSettingsState.initialSetupComplete = true

    const { AgentSetupGuard } = await import('@/components/setup/AgentSetupGuard')
    const { container } = render(<AgentSetupGuard />)

    expect(container.innerHTML).toBe('')
    expect(mockRunOnboardingDoctor).not.toHaveBeenCalled()
  })
})
