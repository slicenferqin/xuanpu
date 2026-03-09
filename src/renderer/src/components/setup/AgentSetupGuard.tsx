import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { AgentNotFoundDialog } from './AgentNotFoundDialog'
import { AgentPickerDialog } from './AgentPickerDialog'

type SetupStatus = 'detecting' | 'none-found' | 'choose' | 'done'
type AvailableSdk = 'opencode' | 'claude-code' | 'codex'

export function AgentSetupGuard(): React.JSX.Element | null {
  const initialSetupComplete = useSettingsStore((s) => s.initialSetupComplete)
  const isLoading = useSettingsStore((s) => s.isLoading)
  const updateSetting = useSettingsStore((s) => s.updateSetting)

  const [status, setStatus] = useState<SetupStatus>('detecting')
  const [detected, setDetected] = useState<AvailableSdk[]>([])

  useEffect(() => {
    if (isLoading || initialSetupComplete) return

    let cancelled = false

    window.systemOps
      .detectAgentSdks()
      .then((result) => {
        if (cancelled) return

        const { opencode, claude, codex } = result
        const found = [
          opencode && ('opencode' as const),
          claude && ('claude-code' as const),
          codex && ('codex' as const)
        ].filter(Boolean) as AvailableSdk[]

        if (found.length === 0) {
          setStatus('none-found')
        } else if (found.length === 1) {
          // Auto-select the single found provider
          updateSetting('defaultAgentSdk', found[0])
          updateSetting('initialSetupComplete', true)
          window.analyticsOps.track('onboarding_completed', {
            sdk: found[0],
            auto_selected: true
          })
          setStatus('done')
        } else {
          // Multiple found — show picker
          setDetected(found)
          setStatus('choose')
        }
      })
      .catch((error) => {
        console.error('Agent SDK detection failed:', error)
        // Fail open: let user configure later in Settings
        updateSetting('initialSetupComplete', true)
        setStatus('done')
      })

    return () => {
      cancelled = true
    }
  }, [isLoading, initialSetupComplete, updateSetting])

  // Already set up, still loading, or detection in progress
  if (initialSetupComplete || isLoading || status === 'detecting' || status === 'done') {
    return null
  }

  if (status === 'none-found') {
    return <AgentNotFoundDialog />
  }

  if (status === 'choose') {
    return (
      <AgentPickerDialog
        available={detected}
        onSelect={(sdk) => {
          updateSetting('defaultAgentSdk', sdk)
          updateSetting('initialSetupComplete', true)
          window.analyticsOps.track('onboarding_completed', {
            sdk,
            auto_selected: false
          })
          setStatus('done')
        }}
      />
    )
  }

  return null
}
