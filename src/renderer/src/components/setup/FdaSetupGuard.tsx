import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useI18n } from '@/i18n/useI18n'
import { toast } from 'sonner'

export function FdaSetupGuard(): React.JSX.Element | null {
  const { t } = useI18n()
  const initialSetupComplete = useSettingsStore((s) => s.initialSetupComplete)
  const dismissed = useSettingsStore((s) => s.fdaOnboardingDismissed)
  const updateSetting = useSettingsStore((s) => s.updateSetting)

  const [platform, setPlatform] = useState<string | null>(null)
  const [status, setStatus] = useState<{ supported: boolean; granted: boolean } | null>(null)
  const [checking, setChecking] = useState(false)

  const refreshStatus = useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      const [nextPlatform, nextStatus] = await Promise.all([
        window.systemOps.getPlatform(),
        window.systemOps.checkFullDiskAccess()
      ])
      setPlatform(nextPlatform)
      setStatus(nextStatus)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.privacy.fda.checkFailed'))
    } finally {
      setChecking(false)
    }
  }, [t])

  useEffect(() => {
    if (!initialSetupComplete || dismissed) return
    void refreshStatus()
  }, [dismissed, initialSetupComplete, refreshStatus])

  if (
    !initialSetupComplete ||
    dismissed ||
    platform !== 'darwin' ||
    !status?.supported ||
    status.granted
  ) {
    return null
  }

  const handleOpenSettings = async () => {
    const result = await window.systemOps.openFullDiskAccessSettings()
    if (!result.success) {
      toast.error(result.error || t('settings.privacy.fda.openFailed'))
    }
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 w-[360px] rounded-2xl border border-border/70 bg-background/95 p-4 shadow-2xl backdrop-blur-xl">
      <div className="space-y-2">
        <div className="text-sm font-semibold">{t('settings.privacy.fda.guardTitle')}</div>
        <p className="text-sm text-muted-foreground">{t('settings.privacy.fda.guardDescription')}</p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => void handleOpenSettings()}>
          {t('settings.privacy.fda.openSettings')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void refreshStatus()}>
          {checking ? t('settings.privacy.fda.checking') : t('settings.privacy.fda.checkAgain')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => updateSetting('fdaOnboardingDismissed', true)}
        >
          {t('settings.privacy.fda.skipForNow')}
        </Button>
      </div>
    </div>
  )
}
