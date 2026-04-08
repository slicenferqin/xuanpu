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
  const [settingsJson, setSettingsJson] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setName(profile?.name ?? '')
      setProvider(profile?.provider ?? 'claude')
      setApiKey(profile?.api_key ?? '')
      setBaseUrl(profile?.base_url ?? '')
      setModelId(profile?.model_id ?? '')
      setSettingsJson(
        profile?.settings_json && profile.settings_json !== '{}'
          ? profile.settings_json
          : ''
      )
      setShowApiKey(false)
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
      if (isEditing && profile) {
        await updateProfile(profile.id, {
          name: name.trim(),
          provider,
          api_key: apiKey.trim() || null,
          base_url: baseUrl.trim() || null,
          model_id: modelId.trim() || null,
          settings_json: settingsJson.trim() || '{}'
        })
      } else {
        await createProfile({
          name: name.trim(),
          provider,
          api_key: apiKey.trim() || null,
          base_url: baseUrl.trim() || null,
          model_id: modelId.trim() || null,
          settings_json: settingsJson.trim() || '{}'
        })
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
      <DialogContent className="max-w-md">
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
            </select>
          </div>

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
