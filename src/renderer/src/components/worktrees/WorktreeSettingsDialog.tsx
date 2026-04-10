import { useState, useEffect } from 'react'
import { toast } from '@/lib/toast'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useModelProfileStore } from '@/stores'
import { useI18n } from '@/i18n/useI18n'

interface WorktreeSettingsDialogProps {
  worktree: {
    id: string
    name: string
    path: string
    model_profile_id: string | null
  }
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function WorktreeSettingsDialog({
  worktree,
  open,
  onOpenChange
}: WorktreeSettingsDialogProps): React.JSX.Element {
  const { profiles, loadProfiles } = useModelProfileStore()
  const { t } = useI18n()

  const [modelProfileId, setModelProfileId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setModelProfileId(worktree.model_profile_id ?? null)
      loadProfiles()
    }
  }, [open, worktree.model_profile_id, loadProfiles])

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await window.db.worktree.update(worktree.id, {
        model_profile_id: modelProfileId
      })
      toast.success(t('dialogs.worktreeSettings.saveSuccess'))
      onOpenChange(false)
    } catch {
      toast.error(t('dialogs.worktreeSettings.saveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('dialogs.worktreeSettings.title')}</DialogTitle>
          <DialogDescription className="text-xs truncate">{worktree.path}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Model Profile */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('dialogs.worktreeSettings.modelProfile')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('dialogs.worktreeSettings.modelProfileDescription')}
            </p>
            <select
              value={modelProfileId ?? '__none__'}
              onChange={(e) =>
                setModelProfileId(e.target.value === '__none__' ? null : e.target.value)
              }
              className="flex h-9 w-full rounded-lg border border-input/80 bg-background/70 px-3.5 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/15 focus-visible:border-ring/50"
            >
              <option value="__none__">
                {t('settings.models.profiles.useProjectDefault')}
              </option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.provider})
                </option>
              ))}
            </select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('dialogs.worktreeSettings.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving
              ? t('dialogs.worktreeSettings.saving')
              : t('dialogs.worktreeSettings.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
