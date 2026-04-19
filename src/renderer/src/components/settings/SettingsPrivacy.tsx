import { useState, useEffect, useCallback } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

export function SettingsPrivacy(): React.JSX.Element {
  const updateSetting = useSettingsStore((s) => s.updateSetting)
  const [enabled, setEnabled] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [platform, setPlatform] = useState<string | null>(null)
  const [fdaStatus, setFdaStatus] = useState<{ supported: boolean; granted: boolean } | null>(null)
  const [fdaChecking, setFdaChecking] = useState(false)
  const { t } = useI18n()

  useEffect(() => {
    window.analyticsOps
      .isEnabled()
      .then((val) => {
        setEnabled(val)
        setLoaded(true)
      })
      .catch(() => {
        setLoaded(true) // Fall back to default (enabled=true)
      })
  }, [])

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

  const refreshFdaStatus = useCallback(async (): Promise<void> => {
    if (platform !== 'darwin') return

    setFdaChecking(true)
    try {
      const result = await window.systemOps.checkFullDiskAccess()
      setFdaStatus(result)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.privacy.fda.checkFailed'))
    } finally {
      setFdaChecking(false)
    }
  }, [platform, t])

  useEffect(() => {
    if (platform === 'darwin') {
      void refreshFdaStatus()
    }
  }, [platform, refreshFdaStatus])

  const handleToggle = () => {
    const newValue = !enabled
    setEnabled(newValue)
    updateSetting('telemetryEnabled', newValue)
    window.analyticsOps.setEnabled(newValue)
  }

  const handleOpenFdaSettings = async () => {
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

      {/* Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium">{t('settings.privacy.analytics.label')}</label>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('settings.privacy.analytics.description')}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          onClick={handleToggle}
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
            <Button type="button" variant="outline" size="sm" onClick={() => void refreshFdaStatus()}>
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
