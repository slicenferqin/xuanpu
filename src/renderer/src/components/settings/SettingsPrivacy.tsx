import { useState, useEffect } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'

const FIELD_COLLECTION_SETTING_KEY = 'field_collection_enabled'
const MEMORY_INJECTION_SETTING_KEY = 'include_memory_in_prompts'

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
  const [loaded, setLoaded] = useState(false)
  const { t } = useI18n()

  useEffect(() => {
    void Promise.all([
      window.analyticsOps.isEnabled().catch(() => true),
      window.db.setting.get(FIELD_COLLECTION_SETTING_KEY).catch(() => null),
      window.db.setting.get(MEMORY_INJECTION_SETTING_KEY).catch(() => null)
    ]).then(([analytics, fieldRaw, memoryRaw]) => {
      setAnalyticsEnabled(analytics)
      // Default ON when absent or any value other than the literal 'false'
      setFieldCollectionEnabled(fieldRaw !== 'false')
      setMemoryInjectionEnabled(memoryRaw !== 'false')
      setLoaded(true)
    })
  }, [])

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
    </div>
  )
}
