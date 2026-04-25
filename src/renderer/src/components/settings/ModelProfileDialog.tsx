import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Eye, EyeOff } from 'lucide-react'
import { useI18n } from '@/i18n/useI18n'
import { useModelProfileStore } from '@/stores'
import { toast } from 'sonner'
import type { ModelProfile, ModelProvider } from '@shared/types/model-profile'

interface ModelProfileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  profile?: ModelProfile | null
}

export function ModelProfileDialog({ open, onOpenChange, profile }: ModelProfileDialogProps) {
  const { t } = useI18n()
  const { createProfile, updateProfile } = useModelProfileStore()
  const isEditing = !!profile

  const [name, setName] = useState('')
  const [provider, setProvider] = useState<ModelProvider>('claude')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [modelId, setModelId] = useState('')
  const [openaiApiKey, setOpenaiApiKey] = useState('')
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('')
  const [codexConfigToml, setCodexConfigToml] = useState('')
  const [settingsJson, setSettingsJson] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [showOpenaiApiKey, setShowOpenaiApiKey] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setName(profile?.name ?? '')
      setProvider(profile?.provider ?? 'claude')
      setApiKey(profile?.api_key ?? '')
      setBaseUrl(profile?.base_url ?? '')
      setModelId(profile?.model_id ?? '')
      setOpenaiApiKey(profile?.openai_api_key ?? '')
      setOpenaiBaseUrl(profile?.openai_base_url ?? '')
      setCodexConfigToml(profile?.codex_config_toml ?? '')
      setSettingsJson(
        profile?.settings_json && profile.settings_json !== '{}'
          ? profile.settings_json
          : ''
      )
      setShowApiKey(false)
      setShowOpenaiApiKey(false)
    }
  }, [open, profile])

  const handleSave = async () => {
    if (!name.trim()) return

    // Validate JSON if provided
    if (settingsJson.trim()) {
      try {
        JSON.parse(settingsJson)
      } catch {
        toast.error('Invalid JSON in advanced settings')
        return
      }
    }

    setSaving(true)
    try {
      const data = {
        name: name.trim(),
        provider,
        api_key: apiKey.trim() || null,
        base_url: baseUrl.trim() || null,
        model_id: modelId.trim() || null,
        openai_api_key: openaiApiKey.trim() || null,
        openai_base_url: openaiBaseUrl.trim() || null,
        codex_config_toml: codexConfigToml.trim() || null,
        settings_json: settingsJson.trim() || '{}'
      }

      if (isEditing && profile) {
        await updateProfile(profile.id, data)
      } else {
        await createProfile(data)
      }
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save profile')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? t('settings.models.profiles.edit')
              : t('settings.models.profiles.create')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t('settings.models.profiles.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('settings.models.profiles.name')}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings.models.profiles.namePlaceholder')}
            />
          </div>

          {/* Provider */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('settings.models.profiles.provider')}
            </label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as ModelProvider)}
              className="flex h-9 w-full rounded-lg border border-input/80 bg-background/70 px-3.5 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/15 focus-visible:border-ring/50"
            >
              <option value="claude">Claude (Anthropic)</option>
              <option value="codex">Codex (OpenAI)</option>
            </select>
          </div>

          {/* Claude (Anthropic) section */}
          {provider === 'claude' && (
            <fieldset className="space-y-4 rounded-lg border p-3">
              <legend className="px-1.5 text-xs font-medium text-muted-foreground">
                Claude (Anthropic)
              </legend>

              {/* API Key */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t('settings.models.profiles.apiKey')}
                </label>
                <div className="relative">
                  <Input
                    type={showApiKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={t('settings.models.profiles.apiKeyPlaceholder')}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* Base URL */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t('settings.models.profiles.baseUrl')}
                </label>
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={t('settings.models.profiles.baseUrlPlaceholder')}
                />
              </div>
            </fieldset>
          )}

          {/* Codex section */}
          {provider === 'codex' && (
            <fieldset className="space-y-4 rounded-lg border p-3">
              <legend className="px-1.5 text-xs font-medium text-muted-foreground">
                Codex
              </legend>

              {/* API Key */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t('settings.models.profiles.openaiApiKey')}
                </label>
                <div className="relative">
                  <Input
                    type={showOpenaiApiKey ? 'text' : 'password'}
                    value={openaiApiKey}
                    onChange={(e) => setOpenaiApiKey(e.target.value)}
                    placeholder={t('settings.models.profiles.openaiApiKeyPlaceholder')}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowOpenaiApiKey(!showOpenaiApiKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showOpenaiApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* config.toml */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t('settings.models.profiles.codexConfigToml')}
                </label>
                <p className="text-xs text-muted-foreground">
                  {t('settings.models.profiles.codexConfigTomlHint')}
                </p>
                <Textarea
                  value={codexConfigToml}
                  onChange={(e) => setCodexConfigToml(e.target.value)}
                  placeholder={'model = "o3"\nmodel_provider = "openai"\n\n[model_providers.openai]\nbase_url = "https://api.openai.com/v1"'}
                  rows={8}
                  className="font-mono text-xs resize-y"
                />
              </div>
            </fieldset>
          )}

          {/* Model ID */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('settings.models.profiles.modelId')}
            </label>
            <Input
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              placeholder={t('settings.models.profiles.modelIdPlaceholder')}
            />
          </div>

          {/* Advanced Settings */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('settings.models.profiles.advancedSettings')}
            </label>
            <Textarea
              value={settingsJson}
              onChange={(e) => setSettingsJson(e.target.value)}
              placeholder='{ "max_tokens": 8192 }'
              rows={3}
              className="font-mono text-sm resize-y"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? '...' : isEditing ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
