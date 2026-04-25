import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useModelProfileStore } from '@/stores'
import { useConnectionStore } from '@/stores'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n/useI18n'

interface ConnectionMemberEnriched {
  id: string
  connection_id: string
  worktree_id: string
  project_id: string
  symlink_name: string
  added_at: string
  worktree_name: string
  worktree_branch: string
  worktree_path: string
  project_name: string
}

interface Connection {
  id: string
  name: string
  custom_name: string | null
  status: 'active' | 'archived'
  path: string
  color: string | null
  model_profile_id: string | null
  created_at: string
  updated_at: string
  members: ConnectionMemberEnriched[]
}

interface ConnectionSettingsDialogProps {
  connection: Connection
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ConnectionSettingsDialog({
  connection,
  open,
  onOpenChange
}: ConnectionSettingsDialogProps): React.JSX.Element {
  const { t } = useI18n()
  const profiles = useModelProfileStore((s) => s.profiles)
  const loadProfiles = useModelProfileStore((s) => s.loadProfiles)
  const updateConnectionModelProfile = useConnectionStore(
    (s) => s.updateConnectionModelProfile
  )

  // Local state
  const [connectionProfileId, setConnectionProfileId] = useState<string | null>(null)
  const [worktreeProfiles, setWorktreeProfiles] = useState<Map<string, string | null>>(new Map())
  const initialWorktreeProfiles = useRef<Map<string, string | null>>(new Map())
  const [saving, setSaving] = useState(false)

  // Load profiles when dialog opens
  useEffect(() => {
    if (open) {
      loadProfiles()
      setConnectionProfileId(connection.model_profile_id)

      // Initialize worktree profile overrides
      const fetchWorktreeProfiles = async (): Promise<void> => {
        const entries = await Promise.all(
          connection.members.map(async (member) => {
            try {
              const result = await window.db.worktree.get(member.worktree_id)
              return [member.worktree_id, result?.model_profile_id ?? null] as const
            } catch {
              return [member.worktree_id, null] as const
            }
          })
        )
        const map = new Map(entries)
        initialWorktreeProfiles.current = new Map(entries)
        setWorktreeProfiles(map)
      }
      fetchWorktreeProfiles()
    }
  }, [open, connection, loadProfiles])

  const handleWorktreeProfileChange = useCallback(
    (worktreeId: string, profileId: string | null) => {
      setWorktreeProfiles((prev) => {
        const next = new Map(prev)
        next.set(worktreeId, profileId)
        return next
      })
    },
    []
  )

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      // 1. Update connection model profile
      const success = await updateConnectionModelProfile(
        connection.id,
        connectionProfileId
      )
      if (!success) {
        setSaving(false)
        return
      }

      // 2. Update only changed worktree model profiles
      for (const member of connection.members) {
        const newProfileId = worktreeProfiles.get(member.worktree_id) ?? null
        const oldProfileId = initialWorktreeProfiles.current.get(member.worktree_id) ?? null
        if (newProfileId === oldProfileId) continue
        try {
          await window.db.worktree.update(member.worktree_id, {
            model_profile_id: newProfileId
          })
        } catch {
          toast.error(
            t('connectionSettings.worktreeUpdateError', {
              name: member.worktree_name
            })
          )
        }
      }

      toast.success(t('connectionSettings.saveSuccess'))

      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }, [
    connection,
    connectionProfileId,
    worktreeProfiles,
    updateConnectionModelProfile,
    onOpenChange,
    t
  ])

  const displayName = connection.custom_name || connection.name

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {t('connectionSettings.title', { name: displayName })}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Connection-level model profile */}
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('connectionSettings.connectionProfile')}</label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
              value={connectionProfileId ?? '__none__'}
              onChange={(e) =>
                setConnectionProfileId(
                  e.target.value === '__none__' ? null : e.target.value
                )
              }
            >
              <option value="__none__">
                {t('connectionSettings.useGlobalDefault')}
              </option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.provider})
                </option>
              ))}
            </select>
          </div>

          {/* Member worktree overrides */}
          {connection.members.length > 0 && (
            <>
              <div className="border-t" />
              <div className="space-y-3">
                <span className="text-muted-foreground text-xs uppercase tracking-wider font-medium">
                  {t('connectionSettings.memberWorktrees')}
                </span>
                {connection.members.map((member) => (
                  <div key={member.id} className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {member.worktree_name}
                      </span>
                      <span className="text-xs text-muted-foreground truncate">
                        {member.project_name}
                      </span>
                    </div>
                    <select
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                      value={
                        worktreeProfiles.get(member.worktree_id) ?? '__inherit__'
                      }
                      onChange={(e) =>
                        handleWorktreeProfileChange(
                          member.worktree_id,
                          e.target.value === '__inherit__' ? null : e.target.value
                        )
                      }
                    >
                      <option value="__inherit__">
                        {t('connectionSettings.inherit')}
                      </option>
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.provider})
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('connectionSettings.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving
              ? t('connectionSettings.saving')
              : t('connectionSettings.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
