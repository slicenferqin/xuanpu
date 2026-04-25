import { useState, useEffect } from 'react'
import { useSettingsStore, resolveModelForSdk } from '@/stores/useSettingsStore'
import { useModelProfileStore } from '@/stores'
import { ModelSelector } from '@/components/sessions/ModelSelector'
import { ModelProfileDialog } from './ModelProfileDialog'
import { Info, Plus, Pencil, Trash2, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/useI18n'
import { toast } from 'sonner'
import type { ModelProfile } from '@shared/types/model-profile'

export function SettingsModels(): React.JSX.Element {
  const defaultAgentSdk = useSettingsStore((s) => s.defaultAgentSdk) ?? 'opencode'
  const supportsModes = defaultAgentSdk === 'claude-code' || defaultAgentSdk === 'codex'
  const { t } = useI18n()
  // Show the effective model for the current SDK (what new sessions will actually use)
  const effectiveModel = useSettingsStore((s) =>
    resolveModelForSdk(defaultAgentSdk === 'terminal' ? 'opencode' : defaultAgentSdk, s)
  )
  const defaultModels = useSettingsStore((state) => state.defaultModels)
  const setSelectedModel = useSettingsStore((state) => state.setSelectedModel)
  const setSelectedModelForSdk = useSettingsStore((state) => state.setSelectedModelForSdk)
  const setModeDefaultModel = useSettingsStore((state) => state.setModeDefaultModel)

  // Model Profiles state
  const { profiles, loading, loadProfiles, setDefaultProfile, deleteProfile } =
    useModelProfileStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingProfile, setEditingProfile] = useState<ModelProfile | null>(null)

  useEffect(() => {
    loadProfiles()
  }, [loadProfiles])

  const handleEditProfile = (profile: ModelProfile) => {
    setEditingProfile(profile)
    setDialogOpen(true)
  }

  const handleAddProfile = () => {
    setEditingProfile(null)
    setDialogOpen(true)
  }

  const handleDeleteProfile = async (profile: ModelProfile) => {
    if (!confirm(t('settings.models.profiles.deleteConfirm'))) return
    try {
      await deleteProfile(profile.id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete')
    }
  }

  const handleToggleDefault = async (profile: ModelProfile) => {
    try {
      if (profile.is_default) {
        await useModelProfileStore.getState().updateProfile(profile.id, { is_default: false })
      } else {
        await setDefaultProfile(profile.id)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update')
    }
  }

  const maskApiKey = (key: string | null): string => {
    if (!key) return '—'
    if (key.length <= 12) return '••••••••'
    return key.slice(0, 7) + '••••' + key.slice(-4)
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-medium mb-1">{t('settings.models.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('settings.models.description')}</p>
      </div>

      {/* Model Profiles */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium">
              {t('settings.models.profiles.title')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('settings.models.profiles.description')}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleAddProfile}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t('settings.models.profiles.add')}
          </Button>
        </div>

        {profiles.length === 0 && !loading ? (
          <div className="text-sm text-muted-foreground py-4 text-center border border-dashed rounded-md">
            {t('settings.models.profiles.noProfiles')}
          </div>
        ) : (
          <div className="space-y-2">
            {profiles.map((profile) => (
              <div
                key={profile.id}
                className="flex items-center justify-between p-3 rounded-md border bg-card"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{profile.name}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      {profile.provider}
                    </span>
                    {profile.is_default && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                        {t('settings.models.profiles.default')}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 flex gap-3">
                    <span>Key: {maskApiKey(profile.api_key)}</span>
                    {profile.base_url && <span>URL: {profile.base_url}</span>}
                    {profile.model_id && <span>Model: {profile.model_id}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1 ml-2">
                  <button
                    onClick={() => handleToggleDefault(profile)}
                    className={`p-1.5 rounded-md transition-colors ${
                      profile.is_default
                        ? 'text-primary hover:text-primary/80'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    title={
                      profile.is_default
                        ? t('settings.models.profiles.removeDefault')
                        : t('settings.models.profiles.setDefault')
                    }
                  >
                    <Star
                      className="h-3.5 w-3.5"
                      fill={profile.is_default ? 'currentColor' : 'none'}
                    />
                  </button>
                  <button
                    onClick={() => handleEditProfile(profile)}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleDeleteProfile(profile)}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t pt-4" />

      {/* Info box explaining priority */}
      <div className="flex gap-2 p-3 rounded-md bg-muted/30 border border-border">
        <Info className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
        <div className="text-xs text-muted-foreground space-y-1">
          <p>
            <strong>{t('settings.models.priority.title')}</strong>
          </p>
          <ol className="list-decimal list-inside space-y-0.5 ml-2">
            <li>{t('settings.models.priority.worktree')}</li>
            {supportsModes && <li>{t('settings.models.priority.mode')}</li>}
            <li>{t('settings.models.priority.global')}</li>
            <li>{t('settings.models.priority.fallback')}</li>
          </ol>
        </div>
      </div>

      {/* Global default */}
      <div className="space-y-2">
        <label className="text-sm font-medium">{t('settings.models.global.label')}</label>
        <p className="text-xs text-muted-foreground">
          {supportsModes
            ? t('settings.models.global.fallbackDescription')
            : t('settings.models.global.sessionDescription')}
        </p>
        <div className="flex items-center gap-2">
          <ModelSelector
            value={effectiveModel}
            onChange={(model) => {
              // Update both legacy selectedModel and per-SDK entry so
              // resolveModelForSdk returns the new model for new sessions
              const sdk = defaultAgentSdk === 'terminal' ? 'opencode' : defaultAgentSdk
              setSelectedModel(model)
              setSelectedModelForSdk(sdk, model)
            }}
          />
          {effectiveModel && (
            <button
              onClick={() => {
                const sdk = defaultAgentSdk === 'terminal' ? 'opencode' : defaultAgentSdk
                setSelectedModel(null)
                setSelectedModelForSdk(sdk, null)
              }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('settings.models.global.clear')}
            </button>
          )}
        </div>
      </div>

      {supportsModes && (
        <>
          <div className="border-t pt-4" />

          {/* Build mode */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('settings.models.build.label')}</label>
            <p className="text-xs text-muted-foreground">
              {t('settings.models.build.description')}
            </p>
            <div className="flex items-center gap-2">
              <ModelSelector
                value={defaultModels?.build || null}
                onChange={(model) => setModeDefaultModel('build', model)}
              />
              {defaultModels?.build && (
                <button
                  onClick={() => setModeDefaultModel('build', null)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('settings.models.useGlobal')}
                </button>
              )}
            </div>
          </div>

          {/* Plan mode */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('settings.models.plan.label')}</label>
            <p className="text-xs text-muted-foreground">{t('settings.models.plan.description')}</p>
            <div className="flex items-center gap-2">
              <ModelSelector
                value={defaultModels?.plan || null}
                onChange={(model) => setModeDefaultModel('plan', model)}
              />
              {defaultModels?.plan && (
                <button
                  onClick={() => setModeDefaultModel('plan', null)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('settings.models.useGlobal')}
                </button>
              )}
            </div>
          </div>

          {/* Ask command */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('settings.models.ask.label')}</label>
            <p className="text-xs text-muted-foreground">{t('settings.models.ask.description')}</p>
            <div className="flex items-center gap-2">
              <ModelSelector
                value={defaultModels?.ask || null}
                onChange={(model) => setModeDefaultModel('ask', model)}
              />
              {defaultModels?.ask && (
                <button
                  onClick={() => setModeDefaultModel('ask', null)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('settings.models.useGlobal')}
                </button>
              )}
            </div>
          </div>
        </>
      )}

      <ModelProfileDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        profile={editingProfile}
      />
    </div>
  )
}
