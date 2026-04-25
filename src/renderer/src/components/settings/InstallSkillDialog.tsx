import { useMemo, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n/useI18n'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useSkillStore } from '@/stores/useSkillStore'
import {
  ALL_PROVIDERS,
  PROVIDER_LABELS,
  SUPPORTED_SCOPES_BY_PROVIDER
} from '@shared/types/skill'
import type { Skill, SkillProvider, SkillScope } from '@shared/types/skill'

type ScopeKind = SkillScope['kind']

function getUserScopeHint(provider: SkillProvider): string {
  switch (provider) {
    case 'claude-code':
      return '~/.claude/skills'
    case 'codex':
      return '~/.codex/skills'
    case 'opencode':
      return '~/.config/opencode/skills'
  }
}

function getProjectScopeSubpath(provider: SkillProvider): string | null {
  switch (provider) {
    case 'claude-code':
      return '.claude/skills'
    case 'codex':
      return '.codex/skills'
    case 'opencode':
      return null
  }
}

function formatProviderPathHints(
  providers: SkillProvider[],
  kind: 'user' | 'project' | 'worktree'
): string {
  const hints = providers.flatMap((provider) => {
    if (kind === 'user') {
      return `${PROVIDER_LABELS[provider]}: ${getUserScopeHint(provider)}`
    }

    const subpath = getProjectScopeSubpath(provider)
    if (!subpath) return []
    return `${PROVIDER_LABELS[provider]}: ${subpath}`
  })

  return hints.join('  |  ')
}

interface Props {
  /** The skill the user clicked "Install" on. `null` hides the dialog. */
  skill: Skill | null
  hubId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** CLI install command shown when a provider isn't detected on $PATH. */
const INSTALL_CMD: Record<SkillProvider, string> = {
  'claude-code': 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
  opencode: 'npm i -g opencode-ai'
}

const SELECTED_OPTION_CLASS =
  'scale-[1.02] border-2 border-primary/60 bg-primary/14 text-primary shadow-[0_12px_28px_-16px_rgba(59,130,246,0.62)] ring-1 ring-primary/40'
const IDLE_OPTION_CLASS =
  'border-border/65 bg-muted/55 text-foreground/72 hover:border-border/90 hover:bg-muted/75 hover:text-foreground'
const SELECTED_CHIP_CLASS =
  'scale-[1.02] border-2 border-primary/60 bg-primary/14 text-primary shadow-[0_10px_24px_-14px_rgba(59,130,246,0.58)] ring-1 ring-primary/40'
const IDLE_CHIP_CLASS =
  'border-border/65 bg-muted/55 text-foreground/72 hover:border-border/90 hover:bg-muted/75 hover:text-foreground'

/**
 * InstallSkillDialog — collects the (providers × scope) install target in one
 * shot, so a single skill can land on up to three provider directories without
 * the user reopening the dialog. Replaces the older scope-pill UI on the main
 * Skills page and avoids the "project pill is disabled because main window
 * has no selection" UX bug: the dialog lets the user pick a project/worktree
 * inline.
 */
export function InstallSkillDialog({ skill, hubId, open, onOpenChange }: Props): JSX.Element {
  const { t } = useI18n()
  const availability = useSkillStore((s) => s.providerAvailability)
  const install = useSkillStore((s) => s.install)

  const projects = useProjectStore((s) => s.projects)
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)

  // Default prefs: prefer Claude Code user-scope, which always works when the
  // CLI is installed. Opening the dialog re-initialises state from `skill?.id`
  // via the `key` below.
  const [providers, setProviders] = useState<Record<SkillProvider, boolean>>({
    'claude-code': true,
    codex: false,
    opencode: false
  })
  const [scopeKind, setScopeKind] = useState<ScopeKind>('user')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [worktreeId, setWorktreeId] = useState<string | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)

  const selectedProviders = useMemo(
    () => ALL_PROVIDERS.filter((p) => providers[p]),
    [providers]
  )

  const allWorktrees = useMemo(() => {
    if (!projectId) return []
    return worktreesByProject.get(projectId) ?? []
  }, [projectId, worktreesByProject])

  const scopePath = useMemo(() => {
    if (scopeKind === 'user') return undefined
    if (scopeKind === 'project') {
      const p = projects.find((x) => x.id === projectId)
      return p?.path
    }
    const wt = allWorktrees.find((w) => w.id === worktreeId)
    return wt?.path
  }, [scopeKind, projectId, worktreeId, projects, allWorktrees])

  const selectedProvidersForHint = selectedProviders.length > 0 ? selectedProviders : ['claude-code']
  const supportedProjectProviders = selectedProvidersForHint.filter((provider) =>
    Boolean(getProjectScopeSubpath(provider))
  )
  const userScopeHint = formatProviderPathHints(selectedProvidersForHint, 'user')
  const projectScopeHint =
    supportedProjectProviders.length > 0
      ? t('settings.skills.install.projectPathHint', {
          path: formatProviderPathHints(supportedProjectProviders, 'project')
        })
      : t('settings.skills.install.providerUnsupportedScope')
  const worktreeScopeHint =
    supportedProjectProviders.length > 0
      ? t('settings.skills.install.worktreePathHint', {
          path: formatProviderPathHints(supportedProjectProviders, 'worktree')
        })
      : t('settings.skills.install.providerUnsupportedScope')

  // Gray out providers that don't support this scope level (OpenCode+project
  // today). We still keep unavailable-CLI checkboxes disabled with a distinct
  // tooltip so the two disabled reasons don't blur together.
  const scopeSupported = (p: SkillProvider): boolean =>
    SUPPORTED_SCOPES_BY_PROVIDER[p].includes(scopeKind)

  const canSubmit =
    selectedProviders.length > 0 &&
    (scopeKind === 'user' || Boolean(scopePath)) &&
    selectedProviders.every((p) => availability[p] && scopeSupported(p)) &&
    !busy

  const handleSubmit = async (): Promise<void> => {
    if (!skill || !hubId) return
    setBusy(true)
    try {
      const res = await install(
        hubId,
        skill.id,
        selectedProviders,
        scopeKind === 'user' ? { kind: 'user' } : { kind: scopeKind, path: scopePath ?? '' },
        overwrite
      )
      const ok = res.results.filter((r) => r.success)
      const failed = res.results.filter((r) => !r.success)
      if (ok.length > 0) {
        toast.success(
          t('settings.skills.install.successToast', {
            count: String(ok.length),
            names: ok.map((r) => PROVIDER_LABELS[r.provider]).join(', ')
          })
        )
      }
      for (const f of failed) {
        toast.error(
          `${PROVIDER_LABELS[f.provider]}: ${f.message ?? f.error ?? 'install failed'}`
        )
      }
      if (failed.length === 0) onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  const title = skill
    ? t('settings.skills.install.dialogTitle', { name: skill.frontmatter.name || skill.id })
    : ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-border/80 bg-card text-card-foreground shadow-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-[14px] font-medium leading-6 text-foreground/70">
            {t('settings.skills.install.dialogSubtitle')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 py-2">
          {/* Provider checkboxes */}
          <section className="flex flex-col gap-2">
            <h3 className="text-[13px] font-semibold uppercase tracking-wide text-foreground/62">
              {t('settings.skills.install.providerLabel')}
            </h3>
            <TooltipProvider>
              <div className="flex flex-col gap-1.5">
                {ALL_PROVIDERS.map((p) => {
                  const cliAvailable = availability[p]
                  const scopeOk = scopeSupported(p)
                  const disabled = !cliAvailable || !scopeOk
                  const selected = providers[p] && !disabled
                  const row = (
                    <label
                      key={p}
                      className={cn(
                        'relative flex items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-all',
                        selected ? SELECTED_OPTION_CLASS : IDLE_OPTION_CLASS,
                        disabled && 'opacity-50 cursor-not-allowed',
                        !disabled && 'cursor-pointer'
                      )}
                    >
                      {selected && (
                        <span className="absolute left-0 top-1.5 h-[calc(100%-12px)] w-1 rounded-r-full bg-primary" />
                      )}
                      <Checkbox
                        checked={providers[p]}
                        disabled={disabled}
                        onCheckedChange={(v) =>
                          setProviders((prev) => ({ ...prev, [p]: Boolean(v) }))
                        }
                      />
                      <span
                        className={cn(
                          'flex-1 text-[14px] font-semibold transition-colors',
                          selected ? 'text-primary' : 'text-current'
                        )}
                      >
                        {PROVIDER_LABELS[p]}
                      </span>
                      {!cliAvailable && (
                        <span className="text-[13px] font-medium text-foreground/58">
                          {t('settings.skills.install.providerNotInstalled')}
                        </span>
                      )}
                      {cliAvailable && !scopeOk && (
                        <span className="text-[13px] font-medium text-foreground/62">
                          {t('settings.skills.install.providerUnsupportedScope')}
                        </span>
                      )}
                      {cliAvailable && scopeOk && (
                        <Check
                          className={cn(
                            'h-3.5 w-3.5 transition-colors',
                            selected ? 'text-primary' : 'text-foreground/65'
                          )}
                        />
                      )}
                    </label>
                  )
                  if (!cliAvailable) {
                    return (
                      <Tooltip key={p} delayDuration={200}>
                        <TooltipTrigger asChild>{row}</TooltipTrigger>
                        <TooltipContent side="right" className="max-w-xs font-mono text-[13px]">
                          {INSTALL_CMD[p]}
                        </TooltipContent>
                      </Tooltip>
                    )
                  }
                  return row
                })}
              </div>
            </TooltipProvider>
          </section>

          {/* Scope selector */}
          <section className="flex flex-col gap-2">
            <h3 className="text-[13px] font-semibold uppercase tracking-wide text-foreground/62">
              {t('settings.skills.install.scopeLabel')}
            </h3>
            <div className="flex flex-col gap-1.5">
              {(['user', 'project', 'worktree'] as ScopeKind[]).map((k) => {
                const active = scopeKind === k
                return (
                  <div key={k} className="flex flex-col gap-1.5">
                    <button
                      type="button"
                      onClick={() => setScopeKind(k)}
                      className={cn(
                        'relative flex items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-all',
                        active ? SELECTED_OPTION_CLASS : IDLE_OPTION_CLASS
                      )}
                    >
                      {active && (
                        <span className="absolute left-0 top-1.5 h-[calc(100%-12px)] w-1 rounded-r-full bg-primary" />
                      )}
                      <div
                        className={cn(
                          'h-3.5 w-3.5 rounded-full border transition-colors',
                          active ? 'border-primary bg-primary' : 'border-muted-foreground/40'
                        )}
                      />
                      <span className="flex-1">
                        <div
                          className={cn(
                            'text-[14px] font-semibold capitalize transition-colors',
                            active ? 'text-primary' : 'text-current'
                          )}
                        >
                          {t(`settings.skills.scope.${k}` as const)}
                        </div>
                        <div className="text-[13px] font-medium leading-5 text-foreground/60">
                          {k === 'user' && userScopeHint}
                          {k === 'project' && projectScopeHint}
                          {k === 'worktree' && worktreeScopeHint}
                        </div>
                      </span>
                    </button>
                    {/* Project picker */}
                    {k === 'project' && active && (
                      <div className="ml-6 flex flex-wrap gap-1.5">
                        {projects.length === 0 && (
                          <span className="text-[13px] font-medium text-foreground/56">
                            {t('settings.skills.install.noProjects')}
                          </span>
                        )}
                        {projects.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setProjectId(p.id)}
                            className={cn(
                              'rounded-md border px-2.5 py-1 text-[13px] font-medium transition-all',
                              projectId === p.id ? SELECTED_CHIP_CLASS : IDLE_CHIP_CLASS
                            )}
                          >
                            {p.name}
                          </button>
                        ))}
                      </div>
                    )}
                    {/* Worktree picker (requires a project first) */}
                    {k === 'worktree' && active && (
                      <div className="ml-6 flex flex-col gap-1.5">
                        <div className="flex flex-wrap gap-1.5">
                          {projects.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => {
                                setProjectId(p.id)
                                setWorktreeId(null)
                              }}
                              className={cn(
                                'rounded-md border px-2.5 py-1 text-[13px] font-medium transition-all',
                                projectId === p.id ? SELECTED_CHIP_CLASS : IDLE_CHIP_CLASS
                              )}
                            >
                              {p.name}
                            </button>
                          ))}
                        </div>
                        {projectId && (
                          <div className="flex flex-wrap gap-1.5">
                            {allWorktrees.length === 0 && (
                              <span className="text-[13px] font-medium text-foreground/56">
                                {t('settings.skills.install.noWorktrees')}
                              </span>
                            )}
                            {allWorktrees.map((w) => (
                              <button
                                key={w.id}
                                type="button"
                                onClick={() => setWorktreeId(w.id)}
                                className={cn(
                                  'rounded-md border px-2.5 py-1 text-[13px] font-medium transition-all',
                                  worktreeId === w.id ? SELECTED_CHIP_CLASS : IDLE_CHIP_CLASS
                                )}
                              >
                                {w.name}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>

          <label className="flex items-center gap-2 text-[13px] font-medium text-foreground/64">
            <Checkbox
              checked={overwrite}
              onCheckedChange={(v) => setOverwrite(Boolean(v))}
            />
            <span>{t('settings.skills.install.overwriteIfExists')}</span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('settings.skills.install.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('settings.skills.install.submit', {
              count: String(selectedProviders.length)
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
