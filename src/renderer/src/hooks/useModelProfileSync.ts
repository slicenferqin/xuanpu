import { useEffect } from 'react'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n/useI18n'

/**
 * Global listener for model-profile:changed events from the main process.
 * When a model profile is assigned, edited, or deleted, the main process
 * writes updated settings.local.json and fires this event so the renderer
 * can notify the user. The next SDK query will pick up the new settings.
 */
export function useModelProfileSync(): void {
  const { t } = useI18n()

  useEffect(() => {
    if (!window.settingsOps?.onModelProfileChanged) return
    const unsubscribe = window.settingsOps.onModelProfileChanged(() => {
      toast.success(t('dialogs.worktreeSettings.profileSynced'))
    })
    return unsubscribe
  }, [t])
}
