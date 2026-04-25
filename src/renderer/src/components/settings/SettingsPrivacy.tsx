import { useState, useEffect, useCallback } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

const FIELD_COLLECTION_SETTING_KEY = 'field_collection_enabled'
const MEMORY_INJECTION_SETTING_KEY = 'include_memory_in_prompts'
const BASH_OUTPUT_CAPTURE_SETTING_KEY = 'agent_bash_capture_output'

interface ToggleProps {
  label: string
  description: string
  enabled: boolean
  onToggle: () => void
}

function Toggle({ label, description, enabled, onToggle }: ToggleProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <div className="pr-4">
        <label className="text-sm font-medium">{label}</label>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={enabled}
        onClick={onToggle}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
          enabled ? 'bg-primary' : 'bg-muted'
        )}
      >
        <span
          className={cn(
            'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
            enabled ? 'translate-x-4' : 'translate-x-0'
          )}
        />
      </button>
    </div>
  )
}

export function SettingsPrivacy(): React.JSX.Element {
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const [analyticsEnabled, setAnalyticsEnabled] = useState(true)
  const [fieldCollectionEnabled, setFieldCollectionEnabled] = useState(true)
  const [memoryInjectionEnabled, setMemoryInjectionEnabled] = useState(true)
  const [bashOutputCaptureEnabled, setBashOutputCaptureEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [platform, setPlatform] = useState<string | null>(null)
  const [fdaStatus, setFdaStatus] = useState<{ supported: boolean; granted: boolean } | null>(null)
  const [fdaChecking, setFdaChecking] = useState(false)
  const { t } = useI18n()

  useEffect(() => {
    void Promise.all([
      window.analyticsOps.isEnabled().catch(() => true),
      window.db.setting.get(FIELD_COLLECTION_SETTING_KEY).catch(() => null),
      window.db.setting.get(MEMORY_INJECTION_SETTING_KEY).catch(() => null),
      window.db.setting.get(BASH_OUTPUT_CAPTURE_SETTING_KEY).catch(() => null)
    ]).then(([analytics, fieldRaw, memoryRaw, bashRaw]) => {
      setAnalyticsEnabled(analytics)
      // Default ON when absent or any value other than the literal 'false'
      setFieldCollectionEnabled(fieldRaw !== 'false')
      setMemoryInjectionEnabled(memoryRaw !== 'false')
      // Phase 21.5: default OFF — must be literally 'true' to enable, since
      // bash output can contain secrets (API keys, env dumps, error tokens).
      setBashOutputCaptureEnabled(bashRaw === 'true')
      setLoaded(true)
    })
  }, [])

  // Phase: macOS Full Disk Access detection (from main)
  useEffect(() => {
    let cancelled = false

    window.systemOps
      .getPlatform()
      .then((value) => {
        if (!cancelled) {
          setPlatform(value)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPlatform(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const refreshFdaStatus = useCallback(
    async (force = false): Promise<void> => {
      if (platform !== 'darwin') return

      setFdaChecking(true)
      try {
        const result = await window.systemOps.checkFullDiskAccess(force)
        setFdaStatus(result)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('settings.privacy.fda.checkFailed'))
      } finally {
        setFdaChecking(false)
      }
    },
    [platform, t]
  )

  // On mount we read the *cached* status only (no force), so we never
  // surface the macOS "App wants to access data from other apps" prompt
  // unless the user explicitly clicks "Check again". The first ever probe
  // (per app launch) still fires once when the cache is empty — that's
  // acceptable; subsequent mounts are silent.
  useEffect(() => {
    if (platform === 'darwin') {
      void refreshFdaStatus(false)
    }
  }, [platform, refreshFdaStatus])

  const handleAnalyticsToggle = (): void => {
    const newValue = !analyticsEnabled
    setAnalyticsEnabled(newValue)
    updateSetting('telemetryEnabled', newValue)
    window.analyticsOps.setEnabled(newValue)
  }

  const handleFieldCollectionToggle = (): void => {
    const newValue = !fieldCollectionEnabled
    setFieldCollectionEnabled(newValue)
    void window.db.setting.set(FIELD_COLLECTION_SETTING_KEY, String(newValue))
  }

  const handleMemoryInjectionToggle = (): void => {
    const newValue = !memoryInjectionEnabled
    setMemoryInjectionEnabled(newValue)
    void window.db.setting.set(MEMORY_INJECTION_SETTING_KEY, String(newValue))
  }

  const handleBashOutputCaptureToggle = (): void => {
    const newValue = !bashOutputCaptureEnabled
    setBashOutputCaptureEnabled(newValue)
    void window.db.setting.set(BASH_OUTPUT_CAPTURE_SETTING_KEY, String(newValue))
  }

  const handleOpenFdaSettings = async (): Promise<void> => {
    const result = await window.systemOps.openFullDiskAccessSettings()
    if (!result.success) {
      toast.error(result.error || t('settings.privacy.fda.openFailed'))
    }
  }

  if (!loaded) return <div />

  return (
    <div className="space-y-6">
      {/* Section header */}
      <div>
        <h3 className="text-base font-medium mb-1">{t('settings.privacy.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('settings.privacy.description')}</p>
      </div>

      {/* Toggles */}
      <div className="space-y-5">
        <Toggle
          label={t('settings.privacy.analytics.label')}
          description={t('settings.privacy.analytics.description')}
          enabled={analyticsEnabled}
          onToggle={handleAnalyticsToggle}
        />
        <Toggle
          label={t('settings.privacy.fieldEvents.label')}
          description={t('settings.privacy.fieldEvents.description')}
          enabled={fieldCollectionEnabled}
          onToggle={handleFieldCollectionToggle}
        />
        <Toggle
          label={t('settings.privacy.memoryInjection.label')}
          description={t('settings.privacy.memoryInjection.description')}
          enabled={memoryInjectionEnabled}
          onToggle={handleMemoryInjectionToggle}
        />
        <Toggle
          label={t('settings.privacy.bashOutputCapture.label')}
          description={t('settings.privacy.bashOutputCapture.description')}
          enabled={bashOutputCaptureEnabled}
          onToggle={handleBashOutputCaptureToggle}
        />
      </div>

      {/* Info box */}
      <div className="rounded-md border border-border bg-muted/30 p-3">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{t('settings.privacy.collect.title')}</span>{' '}
          {t('settings.privacy.collect.description')}
        </p>
        <p className="text-xs text-muted-foreground mt-2">
          <span className="font-medium text-foreground">
            {t('settings.privacy.neverCollect.title')}
          </span>{' '}
          {t('settings.privacy.neverCollect.description')}
        </p>
      </div>

      {platform === 'darwin' && (
        <div className="rounded-md border border-border bg-background/50 p-4 space-y-3">
          <div>
            <div className="text-sm font-medium">{t('settings.privacy.fda.title')}</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('settings.privacy.fda.description')}
            </p>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="text-sm">
              {fdaStatus?.granted
                ? t('settings.privacy.fda.statusGranted')
                : t('settings.privacy.fda.statusNotGranted')}
            </div>
            <div
              className={cn(
                'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium',
                fdaStatus?.granted
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
              )}
            >
              {fdaChecking
                ? t('settings.privacy.fda.checking')
                : fdaStatus?.granted
                  ? t('settings.privacy.fda.grantedBadge')
                  : t('settings.privacy.fda.notGrantedBadge')}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void refreshFdaStatus(true)}>
              {t('settings.privacy.fda.checkAgain')}
            </Button>
            <Button type="button" size="sm" onClick={() => void handleOpenFdaSettings()}>
              {t('settings.privacy.fda.openSettings')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => updateSetting('fdaOnboardingDismissed', false)}
            >
              {t('settings.privacy.fda.showOnboardingAgain')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
