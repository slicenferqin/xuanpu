/**
 * NewSessionDialog — capture session name + provider + model before creation.
 *
 * Provider/model can still be edited from the SessionHeader after creation,
 * but only until the first message is sent (after which they lock).
 */

import { useEffect, useMemo, useState } from 'react'
import { TerminalSquare, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ModelSelector } from './ModelSelector'
import { useSettingsStore, resolveModelForSdk } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useI18n } from '@/i18n/useI18n'
import { toast } from '@/lib/toast'

type AgentSdk = 'opencode' | 'claude-code' | 'codex' | 'terminal'

const PROVIDER_LABELS: Record<AgentSdk, string> = {
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
  terminal: 'Terminal'
}

interface NewSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Exactly one of these must be set.
  worktreeId?: string | null
  projectId?: string | null
  connectionId?: string | null
  // Number that will be used to generate the default name (e.g. "Session 3")
  defaultIndex: number
}

export function NewSessionDialog({
  open,
  onOpenChange,
  worktreeId,
  projectId,
  connectionId,
  defaultIndex
}: NewSessionDialogProps): React.JSX.Element {
  const { t } = useI18n()
  const availableAgentSdks = useSettingsStore((s) => s.availableAgentSdks)
  const defaultAgentSdk = useSettingsStore((s) => s.defaultAgentSdk)

  // Worktree's last-used SDK (if creating in worktree mode) — wins over global default
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const worktreeLastAgentSdk = useMemo<AgentSdk | null>(() => {
    if (!worktreeId) return null
    for (const worktrees of worktreesByProject.values()) {
      const w = worktrees.find((w) => w.id === worktreeId)
      if (w) return (w.last_agent_sdk as AgentSdk | null) ?? null
    }
    return null
  }, [worktreeId, worktreesByProject])

  const enabledSdks = useMemo<AgentSdk[]>(() => {
    const list: AgentSdk[] = []
    if (availableAgentSdks?.opencode) list.push('opencode')
    if (availableAgentSdks?.claude) list.push('claude-code')
    if (availableAgentSdks?.codex) list.push('codex')
    list.push('terminal')
    return list
  }, [availableAgentSdks])

  const initialSdk = useMemo<AgentSdk>(() => {
    const fallback = defaultAgentSdk ?? 'opencode'
    const candidate = worktreeLastAgentSdk ?? fallback
    return enabledSdks.includes(candidate) ? candidate : enabledSdks[0] ?? 'opencode'
  }, [worktreeLastAgentSdk, defaultAgentSdk, enabledSdks])

  const [name, setName] = useState('')
  const [agentSdk, setAgentSdk] = useState<AgentSdk>(initialSdk)
  const [model, setModel] = useState<{
    providerID: string
    modelID: string
    variant?: string
  } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Reset state every time the dialog opens
  useEffect(() => {
    if (!open) return
    setName('')
    setAgentSdk(initialSdk)
    setModel(null)
    setSubmitting(false)
  }, [open, initialSdk])

  // Auto-resolve a default model when SDK changes (skip terminal)
  useEffect(() => {
    if (!open) return
    if (agentSdk === 'terminal') {
      setModel(null)
      return
    }
    const resolved = resolveModelForSdk(agentSdk)
    if (resolved) {
      setModel({
        providerID: resolved.providerID,
        modelID: resolved.modelID,
        variant: resolved.variant ?? undefined
      })
      return
    }
    // No default stored for this SDK — fetch the first available model so the
    // selector doesn't fall back to the hard-coded anthropic/claude-opus fallback.
    let cancelled = false
    setModel(null)
    window.agentOps
      ?.listModels({ runtimeId: agentSdk })
      .then((result) => {
        if (cancelled || !result?.success) return
        const providers = Array.isArray(result.providers)
          ? result.providers
          : (result.providers as { providers?: unknown[] } | null)?.providers ?? []
        for (const provider of providers as Array<Record<string, unknown>>) {
          const providerID = (provider?.id as string) ?? null
          const models = provider?.models as Record<string, Record<string, unknown>> | undefined
          if (!providerID || !models) continue
          const firstKey = Object.keys(models)[0]
          if (!firstKey) continue
          const modelID = (models[firstKey]?.id as string) ?? firstKey
          const variants = models[firstKey]?.variants as Record<string, unknown> | undefined
          const firstVariant = variants ? Object.keys(variants)[0] : undefined
          setModel({
            providerID,
            modelID,
            variant: firstVariant
          })
          return
        }
      })
      .catch(() => {
        // Non-fatal — ModelSelector will show its built-in loading/empty state.
      })
    return () => {
      cancelled = true
    }
  }, [agentSdk, open])

  const isTerminal = agentSdk === 'terminal'
  const placeholder = isTerminal
    ? `Terminal ${defaultIndex}`
    : `Session ${defaultIndex}`

  async function handleCreate(): Promise<void> {
    if (submitting) return
    setSubmitting(true)
    try {
      const trimmed = name.trim()
      const store = useSessionStore.getState()
      let result: { success: boolean; error?: string }

      if (connectionId) {
        result = await store.createConnectionSession(connectionId, agentSdk, undefined, {
          name: trimmed || undefined,
          model: isTerminal ? null : model
        })
      } else if (worktreeId && projectId) {
        result = await store.createSession(worktreeId, projectId, agentSdk, undefined, {
          name: trimmed || undefined,
          model: isTerminal ? null : model
        })
      } else {
        result = { success: false, error: 'Missing scope for new session' }
      }

      if (!result.success) {
        toast.error(result.error || t('sessionTabs.errors.createSession'))
        setSubmitting(false)
        return
      }
      onOpenChange(false)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('sessionTabs.errors.createSession')
      )
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('newSessionDialog.title')}</DialogTitle>
          <DialogDescription>{t('newSessionDialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {/* Name */}
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('newSessionDialog.fields.name')}
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void handleCreate()
                }
              }}
              placeholder={placeholder}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          {/* Provider */}
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('newSessionDialog.fields.provider')}
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {enabledSdks.map((sdk) => {
                const active = sdk === agentSdk
                return (
                  <button
                    key={sdk}
                    type="button"
                    onClick={() => setAgentSdk(sdk)}
                    className={cn(
                      'flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-colors',
                      active
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                    )}
                  >
                    {sdk === 'terminal' && (
                      <TerminalSquare className="h-3.5 w-3.5 text-emerald-500" />
                    )}
                    {PROVIDER_LABELS[sdk]}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Model */}
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('newSessionDialog.fields.model')}
            </label>
            {isTerminal ? (
              <div className="flex items-center gap-1.5 rounded-md border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
                <Lock className="h-3 w-3" />
                {t('newSessionDialog.terminalNoModel')}
              </div>
            ) : (
              <ModelSelector
                value={model}
                onChange={(m) => setModel(m)}
                agentSdkOverride={agentSdk === 'terminal' ? 'opencode' : agentSdk}
                showProviderPrefix={false}
                compact
              />
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('newSessionDialog.actions.cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={submitting}>
            {submitting
              ? t('newSessionDialog.actions.creating')
              : t('newSessionDialog.actions.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
