import { useEffect } from 'react'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n/useI18n'
import { useSessionStore } from '@/stores/useSessionStore'

/** Map profile provider to model-selector providerID */
function mapProviderID(provider: string): string {
  if (provider === 'codex') return 'openai'
  return 'anthropic'
}

/**
 * Global listener for model-profile:changed events from the main process.
 * When a model profile is assigned, edited, or deleted, the main process
 * writes updated settings.local.json and fires this event so the renderer
 * can notify the user and update the model selector if the profile specifies
 * a model_id.
 */
export function useModelProfileSync(): void {
  const { t } = useI18n()

  useEffect(() => {
    if (!window.settingsOps?.onModelProfileChanged) return
    const unsubscribe = window.settingsOps.onModelProfileChanged(async (data) => {
      toast.success(t('dialogs.worktreeSettings.profileSynced'))

      // Resolve profile for each affected worktree and push model_id to active sessions
      const { worktreeIds } = data
      for (const worktreeId of worktreeIds) {
        try {
          const worktree = await window.db.worktree.get(worktreeId)
          if (!worktree) continue

          const profile = await window.modelProfileOps.resolve(worktreeId, worktree.project_id)
          if (!profile?.model_id) continue

          const providerID = mapProviderID(profile.provider)
          const modelID = profile.model_id

          // Update active sessions whose model differs from the profile's model
          const sessions = useSessionStore.getState().sessionsByWorktree.get(worktreeId) ?? []
          for (const session of sessions) {
            if (session.status !== 'active') continue
            if (session.model_id === modelID && session.model_provider_id === providerID) continue
            await useSessionStore.getState().setSessionModel(
              session.id,
              { providerID, modelID },
              { skipGlobalUpdate: true }
            )
          }
        } catch (err) {
          console.error('Failed to apply model from profile:', err)
        }
      }
    })
    return unsubscribe
  }, [t])
}
