import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { SettingsPrivacy } from '../../src/renderer/src/components/settings/SettingsPrivacy'
import { FdaSetupGuard } from '../../src/renderer/src/components/setup/FdaSetupGuard'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'

describe('Full Disk Access UI', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    useSettingsStore.setState({
      isLoading: false,
      initialSetupComplete: true,
      fdaOnboardingDismissed: false,
      locale: 'en',
      telemetryEnabled: true
    } as never)

    vi.mocked(window.analyticsOps.isEnabled).mockResolvedValue(true)
    vi.mocked(window.systemOps.getPlatform).mockResolvedValue('darwin')
    vi.mocked(window.systemOps.checkFullDiskAccess).mockResolvedValue({
      supported: true,
      granted: false
    })
    vi.mocked(window.systemOps.openFullDiskAccessSettings).mockResolvedValue({ success: true })
  })

  it('shows the onboarding guard on macOS when FDA is not granted', async () => {
    render(<FdaSetupGuard />)

    expect(await screen.findByText('Grant Full Disk Access')).toBeInTheDocument()
    expect(screen.getByText('Open System Settings')).toBeInTheDocument()
  })

  it('dismisses the onboarding guard when skipping for now', async () => {
    const user = userEvent.setup()
    render(<FdaSetupGuard />)

    await user.click(await screen.findByRole('button', { name: 'Skip for now' }))

    await waitFor(() => {
      expect(useSettingsStore.getState().fdaOnboardingDismissed).toBe(true)
    })
  })

  it('renders FDA status and actions inside SettingsPrivacy', async () => {
    const user = userEvent.setup()
    render(<SettingsPrivacy />)

    expect(await screen.findByText('Full Disk Access')).toBeInTheDocument()
    expect(screen.getByText('Full Disk Access is not granted.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Check Again' }))
    expect(window.systemOps.checkFullDiskAccess).toHaveBeenCalledTimes(2)

    await user.click(screen.getByRole('button', { name: 'Open System Settings' }))
    expect(window.systemOps.openFullDiskAccessSettings).toHaveBeenCalledTimes(1)
  })
})
