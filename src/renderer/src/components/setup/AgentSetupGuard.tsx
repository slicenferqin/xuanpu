import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { AgentSetupWizard } from './AgentSetupWizard'

type WizardAgentId = 'opencode' | 'claude-code' | 'codex' | 'terminal'

export function AgentSetupGuard(): React.JSX.Element | null {
  const initialSetupComplete = useSettingsStore((s) => s.initialSetupComplete)
  const isLoading = useSettingsStore((s) => s.isLoading)
  const updateSetting = useSettingsStore((s) => s.updateSetting)

  const [doctorResult, setDoctorResult] = useState<OnboardingDoctorResult | null>(null)
  const [doctorLoading, setDoctorLoading] = useState(true)
  const [doctorError, setDoctorError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    if (isLoading || initialSetupComplete) return

    let cancelled = false

    async function runDoctor(): Promise<void> {
      setDoctorLoading(true)
      setDoctorError(null)

      try {
        const result = await window.systemOps.runOnboardingDoctor()
        if (cancelled) return
        setDoctorResult(result)
      } catch (error) {
        if (cancelled) return
        setDoctorResult(null)
        setDoctorError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) {
          setDoctorLoading(false)
        }
      }
    }

    void runDoctor()

    return () => {
      cancelled = true
    }
  }, [isLoading, initialSetupComplete, refreshTick])

  if (initialSetupComplete || isLoading) {
    return null
  }

  function completeSetup(sdk: WizardAgentId): void {
    updateSetting('defaultAgentSdk', sdk)
    updateSetting('initialSetupComplete', true)

    const readyAgents = doctorResult?.agents.filter((agent) => agent.selectable).length ?? 0

    window.analyticsOps.track('onboarding_completed', {
      sdk,
      auto_selected: false,
      wizard: true,
      ready_agents: readyAgents
    })
  }

  return (
    <AgentSetupWizard
      result={doctorResult}
      loading={doctorLoading}
      error={doctorError}
      onRefresh={() => setRefreshTick((value) => value + 1)}
      onComplete={completeSetup}
    />
  )
}
