import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useShortcutStore } from '@/stores/useShortcutStore'
import { useThemeStore } from '@/stores/useThemeStore'
import { AgentSetupWizard } from './AgentSetupWizard'

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

  function completeSetup(): void {
    // The wizard has already persisted every other choice (default agent,
    // keymap preset, theme) the moment the user made them. Flipping
    // `initialSetupComplete` is the only thing left to do here.
    updateSetting('initialSetupComplete', true)

    const settings = useSettingsStore.getState()
    const shortcuts = useShortcutStore.getState()
    const theme = useThemeStore.getState()
    const readyAgents = doctorResult?.agents.filter((agent) => agent.selectable).length ?? 0

    window.analyticsOps.track('onboarding_completed', {
      // Original schema (kept stable for downstream BI)
      sdk: settings.defaultAgentSdk,
      auto_selected: false,
      wizard: true,
      ready_agents: readyAgents,
      // Schema v2 additions
      event_version: 2,
      default_runtime: settings.defaultAgentSdk,
      keymap_preset: shortcuts.activePreset,
      theme_id: theme.themeId,
      theme_follow_system: theme.followSystem
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
