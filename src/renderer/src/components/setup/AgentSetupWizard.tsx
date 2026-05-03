import { useEffect, useMemo, useState, useRef } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Command,
  Copy,
  Download,
  ExternalLink,
  GitBranch,
  Hammer,
  Loader2,
  Monitor,
  Package,
  RefreshCw,
  Sparkles,
  TerminalSquare,
  WandSparkles
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n/useI18n'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogContent } from '@/components/ui/alert-dialog'
import { useShortcutStore } from '@/stores/useShortcutStore'
import { useThemeStore } from '@/stores/useThemeStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import {
  DEFAULT_SHORTCUTS,
  KEYMAP_PRESETS,
  KEYMAP_PRESET_ORDER,
  type KeyBinding,
  type KeymapPresetId,
  type ShortcutCategory
} from '@/lib/keyboard-shortcuts'
import { THEME_PRESETS, type ThemePreset } from '@/lib/themes'
import onboardingBg from '@/assets/onboarding-bg.png'
import onboardingBgDark from '@/assets/onboarding-bg-dark.png'

type WizardAgentId = 'claude-code' | 'codex' | 'opencode' | 'terminal'

interface AgentSetupWizardProps {
  result: OnboardingDoctorResult | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  onComplete: () => void
}

interface AgentMeta {
  icon: LucideIcon
  docsUrl: string
  installCommand?: string
  launchCommand?: string
}

const AGENT_ORDER: Exclude<WizardAgentId, 'terminal'>[] = ['claude-code', 'codex', 'opencode']

const AGENT_META: Record<Exclude<WizardAgentId, 'terminal'>, AgentMeta> = {
  'claude-code': {
    icon: Sparkles,
    docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/getting-started',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    launchCommand: 'claude'
  },
  codex: {
    icon: WandSparkles,
    docsUrl: 'https://github.com/openai/codex',
    installCommand: 'npm install -g @openai/codex',
    launchCommand: 'codex login'
  },
  opencode: {
    icon: Bot,
    docsUrl: 'https://opencode.ai/docs/',
    installCommand: 'curl -fsSL https://opencode.ai/install | bash',
    launchCommand: 'opencode'
  }
}

const TERMINAL_DOCS_URL = 'https://github.com/slicenferqin/xuanpu'

const ENVIRONMENT_META: Record<
  OnboardingEnvironmentCheck['id'],
  { icon: LucideIcon; titleKey: string }
> = {
  git: { icon: GitBranch, titleKey: 'onboardingWizard.environment.git.title' },
  node: { icon: Command, titleKey: 'onboardingWizard.environment.node.title' },
  homebrew: { icon: Package, titleKey: 'onboardingWizard.environment.homebrew.title' },
  'xcode-cli': { icon: Hammer, titleKey: 'onboardingWizard.environment.xcodeCli.title' }
}

const REFRESH_DELAY_MS = 5_000

// Shortcuts surfaced inline on each preset card to convey "what's different".
const PRESET_SAMPLE_SHORTCUTS: Array<{ id: string; labelKey: string }> = [
  { id: 'nav:command-palette', labelKey: 'onboardingWizard.keymap.samples.commandPalette' },
  { id: 'nav:file-search', labelKey: 'onboardingWizard.keymap.samples.fileSearch' }
]

export function AgentSetupWizard({
  result,
  loading,
  error,
  onRefresh,
  onComplete
}: AgentSetupWizardProps): React.JSX.Element {
  const { t } = useI18n()

  const defaultAgentSdk = useSettingsStore((s) => s.defaultAgentSdk)
  const updateSetting = useSettingsStore((s) => s.updateSetting)

  const activePreset = useShortcutStore((s) => s.activePreset)
  const setActivePreset = useShortcutStore((s) => s.setActivePreset)

  const themeId = useThemeStore((s) => s.themeId)
  const followSystem = useThemeStore((s) => s.followSystem)
  const setTheme = useThemeStore((s) => s.setTheme)
  const setFollowSystem = useThemeStore((s) => s.setFollowSystem)
  const previewTheme = useThemeStore((s) => s.previewTheme)
  const cancelPreview = useThemeStore((s) => s.cancelPreview)

  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [environmentExpanded, setEnvironmentExpanded] = useState(false)
  const refreshTimerRef = useRef<number | null>(null)

  const agentsById = useMemo(() => {
    return new Map((result?.agents ?? []).map((agent) => [agent.id, agent]))
  }, [result])

  const environmentChecks = result?.environmentChecks ?? []
  const environmentIssues = environmentChecks.filter((item) => item.status !== 'ready')

  // Open the environment block automatically when the doctor reports issues.
  useEffect(() => {
    if (!result) return
    setEnvironmentExpanded(environmentIssues.length > 0)
  }, [result, environmentIssues.length])

  // At-least-one-ready OR terminal fallback already chosen.
  const hasReadyAgent = useMemo(
    () =>
      AGENT_ORDER.some((id) => agentsById.get(id)?.status === 'ready') ||
      defaultAgentSdk === 'terminal',
    [agentsById, defaultAgentSdk]
  )
  const canFinish = hasReadyAgent

  // Cmd+Enter completes the wizard when allowed.
  useEffect(() => {
    function handleKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canFinish) {
        e.preventDefault()
        onComplete()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [canFinish, onComplete])

  // Cleanup any pending auto-refresh.
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current)
      }
    }
  }, [])

  function scheduleAutoRefresh(): void {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current)
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null
      onRefresh()
    }, REFRESH_DELAY_MS)
  }

  async function copyCommand(command: string): Promise<void> {
    try {
      await window.projectOps.copyToClipboard(command)
      toast.success(t('onboardingWizard.toasts.commandCopied'))
    } catch (err) {
      toast.error(resolveActionError(t, err))
    }
  }

  async function openDocs(url: string): Promise<void> {
    try {
      const response = await window.systemOps.openInChrome(url)
      if (!response.success) {
        throw new Error(response.error || 'Failed to open docs')
      }
      toast.success(t('onboardingWizard.toasts.docsOpened'))
    } catch (err) {
      toast.error(resolveActionError(t, err))
    }
  }

  async function runCommand(command: string, autoRefresh: boolean): Promise<void> {
    setBusyAction(command)
    try {
      const response = await window.systemOps.openCommandInTerminal(command)
      if (!response.success) {
        throw new Error(response.error || 'Failed to open terminal')
      }
      toast.success(t('onboardingWizard.toasts.terminalOpened'))
      if (autoRefresh) scheduleAutoRefresh()
    } catch (err) {
      toast.error(resolveActionError(t, err))
    } finally {
      setBusyAction(null)
    }
  }

  function handleSetDefault(id: WizardAgentId): void {
    updateSetting('defaultAgentSdk', id)
    if (id === 'terminal') {
      toast.success(t('onboardingWizard.toasts.terminalFallbackSet'))
    } else {
      toast.success(
        t('onboardingWizard.toasts.defaultAgentSet', {
          agent: t(getAgentTitleKey(id))
        })
      )
    }
  }

  function handleSelectPreset(id: KeymapPresetId): void {
    if (id === activePreset) return
    const { customCollisions } = setActivePreset(id)
    const presetLabel = t(KEYMAP_PRESETS[id].labelKey)
    if (customCollisions.length === 0) {
      toast.success(t('onboardingWizard.keymap.toast.switched', { preset: presetLabel }))
    } else {
      toast.warning(
        t('onboardingWizard.keymap.toast.conflicts', {
          preset: presetLabel,
          count: customCollisions.length
        })
      )
    }
  }

  return (
    <AlertDialog open={true}>
      <AlertDialogContent
        size="lg"
        className="h-[calc(100vh-2rem)] max-h-[860px] overflow-hidden border border-border/70 bg-background p-0 shadow-[0_24px_80px_-40px_rgba(15,23,42,0.35)] sm:max-w-[1080px]"
      >
        <img
          src={onboardingBg}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-40 dark:hidden"
        />
        <img
          src={onboardingBgDark}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 hidden h-full w-full object-cover opacity-50 dark:block"
        />

        <div className="relative flex h-full min-h-0 flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-border/60 px-6 py-5">
            <div className="min-w-0">
              <div className="text-[22px] font-semibold tracking-tight text-foreground">
                {t('onboardingWizard.headerTitle')}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                {t('onboardingWizard.headerDescription')}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onRefresh}
                disabled={loading}
                className="rounded-xl border-border/70 bg-background"
              >
                <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
                {t('onboardingWizard.actions.refresh')}
              </Button>

              <Button
                size="sm"
                onClick={onComplete}
                disabled={!canFinish}
                title={
                  canFinish
                    ? t('onboardingWizard.actions.finishHint')
                    : t('onboardingWizard.actions.finishDisabledHint')
                }
                className="rounded-xl"
              >
                {t('onboardingWizard.actions.finish')}
                <span className="ml-2 rounded-md border border-border/40 bg-background/40 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground">
                  {'⌘⏎'}
                </span>
              </Button>
            </div>
          </header>

          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="space-y-5 px-6 py-5">
              <EnvironmentSection
                checks={environmentChecks}
                issues={environmentIssues}
                expanded={environmentExpanded}
                onToggle={() => setEnvironmentExpanded((value) => !value)}
                loading={loading}
              />

              <ProvidersSection
                result={result}
                loading={loading}
                error={error}
                defaultAgentSdk={defaultAgentSdk}
                busyAction={busyAction}
                onSetDefault={handleSetDefault}
                onRunCommand={runCommand}
                onCopyCommand={copyCommand}
                onOpenDocs={openDocs}
                onRefresh={onRefresh}
              />

              <KeymapPresetSection activePreset={activePreset} onSelect={handleSelectPreset} />

              <AppearanceSection
                themeId={themeId}
                followSystem={followSystem}
                onSelect={setTheme}
                onPreview={previewTheme}
                onCancelPreview={cancelPreview}
                onToggleFollowSystem={setFollowSystem}
              />
            </div>
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-6 py-4">
            <div className="text-sm text-muted-foreground">
              {canFinish
                ? t('onboardingWizard.actions.finishHint')
                : t('onboardingWizard.actions.finishDisabledHint')}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                onClick={() => window.systemOps.quitApp()}
                className="rounded-xl text-muted-foreground"
              >
                {t('onboardingWizard.actions.quit')}
              </Button>
              <Button
                variant="outline"
                onClick={() => handleSetDefault('terminal')}
                className="rounded-xl border-border/70 bg-background"
                disabled={defaultAgentSdk === 'terminal'}
              >
                <TerminalSquare className="size-4" />
                {defaultAgentSdk === 'terminal'
                  ? t('onboardingWizard.providers.terminal.isFallback')
                  : t('onboardingWizard.actions.useTerminal')}
              </Button>
              <Button onClick={onComplete} disabled={!canFinish} className="rounded-xl">
                {t('onboardingWizard.actions.finish')}
                <Check className="size-4" />
              </Button>
            </div>
          </footer>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ============================================================================
// Section: Environment (collapsible bar)
// ============================================================================

function EnvironmentSection({
  checks,
  issues,
  expanded,
  onToggle,
  loading
}: {
  checks: OnboardingEnvironmentCheck[]
  issues: OnboardingEnvironmentCheck[]
  expanded: boolean
  onToggle: () => void
  loading: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const ready = issues.length === 0
  const total = checks.length

  return (
    <section className="rounded-3xl border border-border/70 bg-card">
      <button
        type="button"
        onClick={onToggle}
        disabled={loading || total === 0}
        className={cn(
          'flex w-full items-center gap-3 rounded-3xl px-5 py-4 text-left transition-colors',
          'hover:bg-accent/15 disabled:cursor-default disabled:opacity-70'
        )}
      >
        <div
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-2xl',
            ready
              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
              : 'bg-amber-500/10 text-amber-600 dark:text-amber-300'
          )}
        >
          {ready ? <CheckCircle2 className="size-5" /> : <AlertTriangle className="size-5" />}
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">
            {loading
              ? t('onboardingWizard.loading.title')
              : ready
                ? t('onboardingWizard.environment.collapsed.allReady', {
                    count: total - issues.length,
                    total
                  })
                : t('onboardingWizard.environment.collapsed.needsAttention', {
                    count: issues.length
                  })}
          </div>
          {!loading && !ready && (
            <div className="mt-1 text-xs leading-5 text-muted-foreground">
              {issues.map((item) => t(ENVIRONMENT_META[item.id].titleKey)).join(' / ')}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center text-xs text-muted-foreground">
          {expanded
            ? t('onboardingWizard.environment.collapsed.collapse')
            : t('onboardingWizard.environment.collapsed.expand')}
          {expanded ? (
            <ChevronDown className="ml-1 size-4" />
          ) : (
            <ChevronRight className="ml-1 size-4" />
          )}
        </div>
      </button>

      {expanded && total > 0 && (
        <div className="border-t border-border/60 px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {checks.map((item) => (
              <EnvironmentCard key={item.id} item={item} />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function EnvironmentCard({ item }: { item: OnboardingEnvironmentCheck }): React.JSX.Element {
  const { t } = useI18n()
  const meta = ENVIRONMENT_META[item.id]
  const Icon = meta.icon

  return (
    <div className="rounded-2xl border border-border/70 bg-background px-4 py-4">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-card">
          <Icon className="size-[18px] text-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{t(meta.titleKey)}</span>
            <StatusPill className={getStatusBadgeClass(item.status)}>
              {t(getStatusLabelKey(item.status))}
            </StatusPill>
          </div>
          <div className="mt-2 text-sm leading-6 text-muted-foreground">
            {resolveEnvironmentText(t, item)}
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Section: AI providers (parallel cards, no longer single-select radio)
// ============================================================================

function ProvidersSection({
  result,
  loading,
  error,
  defaultAgentSdk,
  busyAction,
  onSetDefault,
  onRunCommand,
  onCopyCommand,
  onOpenDocs,
  onRefresh
}: {
  result: OnboardingDoctorResult | null
  loading: boolean
  error: string | null
  defaultAgentSdk: WizardAgentId
  busyAction: string | null
  onSetDefault: (id: WizardAgentId) => void
  onRunCommand: (command: string, autoRefresh: boolean) => Promise<void>
  onCopyCommand: (command: string) => Promise<void>
  onOpenDocs: (url: string) => Promise<void>
  onRefresh: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const agentsById = new Map(result?.agents.map((agent) => [agent.id, agent]) ?? [])

  const defaultLabel =
    defaultAgentSdk === 'terminal'
      ? t('onboardingWizard.agents.terminal.title')
      : t(getAgentTitleKey(defaultAgentSdk))

  return (
    <section className="rounded-3xl border border-border/70 bg-card p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-medium text-foreground">
            {t('onboardingWizard.providers.title')}
          </h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {t('onboardingWizard.providers.description')}
          </p>
        </div>
        <span className="rounded-full border border-border/70 bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
          {t('onboardingWizard.providers.defaultRuntimeReadout', { agent: defaultLabel })}
        </span>
      </header>

      {error ? (
        <div className="mt-4 rounded-2xl border border-amber-300/60 bg-amber-500/8 p-4 text-sm text-amber-700 dark:border-amber-400/30 dark:text-amber-200">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0">
              <div className="font-medium">{t('onboardingWizard.providers.errorBanner.title')}</div>
              <div className="mt-1 text-xs leading-5 opacity-90">{error}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={onRefresh} className="rounded-xl">
                  <RefreshCw className="size-4" />
                  {t('onboardingWizard.providers.errorBanner.retry')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onSetDefault('terminal')}
                  className="rounded-xl border-border/70 bg-background"
                >
                  <TerminalSquare className="size-4" />
                  {t('onboardingWizard.providers.errorBanner.fallback')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {AGENT_ORDER.map((id) => (
            <ProviderCard
              key={id}
              id={id}
              agent={agentsById.get(id)}
              isDefault={defaultAgentSdk === id}
              loading={loading}
              busyAction={busyAction}
              onSetDefault={onSetDefault}
              onRunCommand={onRunCommand}
              onCopyCommand={onCopyCommand}
              onOpenDocs={onOpenDocs}
              onRefresh={onRefresh}
            />
          ))}

          <TerminalProviderCard
            isDefault={defaultAgentSdk === 'terminal'}
            onSetDefault={() => onSetDefault('terminal')}
            onOpenDocs={onOpenDocs}
          />
        </div>
      )}
    </section>
  )
}

function ProviderCard({
  id,
  agent,
  isDefault,
  loading,
  busyAction,
  onSetDefault,
  onRunCommand,
  onCopyCommand,
  onOpenDocs,
  onRefresh
}: {
  id: Exclude<WizardAgentId, 'terminal'>
  agent: OnboardingAgentStatus | undefined
  isDefault: boolean
  loading: boolean
  busyAction: string | null
  onSetDefault: (id: WizardAgentId) => void
  onRunCommand: (command: string, autoRefresh: boolean) => Promise<void>
  onCopyCommand: (command: string) => Promise<void>
  onOpenDocs: (url: string) => Promise<void>
  onRefresh: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const meta = AGENT_META[id]
  const Icon = meta.icon
  const status = agent?.status ?? 'missing'
  const reason = agent?.reason

  const showSetDefault = status === 'ready' || reason === 'auth_unknown'

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-2xl border bg-background p-4',
        isDefault ? 'border-primary/45 bg-primary/5' : 'border-border/70'
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-card">
          <Icon className="size-[18px] text-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {t(getAgentTitleKey(id))}
            </span>
            {!loading && (
              <StatusPill className={getStatusBadgeClass(status)}>
                {t(getStatusLabelKey(status))}
              </StatusPill>
            )}
            {isDefault && (
              <StatusPill className="border-primary/30 bg-primary/10 text-primary">
                {t('onboardingWizard.providers.actions.isDefault')}
              </StatusPill>
            )}
            {agent?.version && (
              <span className="rounded-full border border-border/65 bg-background px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                {agent.version}
              </span>
            )}
          </div>

          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            {loading
              ? t('onboardingWizard.providers.loading.message')
              : resolveAgentStatusText(t, id, agent)}
          </p>
        </div>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-2">
        <ProviderPrimaryAction
          id={id}
          status={status}
          reason={reason}
          loading={loading}
          busyAction={busyAction}
          onRunCommand={onRunCommand}
          onRefresh={onRefresh}
        />

        {showSetDefault && !loading && (
          <Button
            size="sm"
            variant={isDefault ? 'outline' : 'default'}
            onClick={() => onSetDefault(id)}
            disabled={isDefault}
            className="rounded-xl"
            title={
              reason === 'auth_unknown'
                ? t('onboardingWizard.agents.claudeCode.authUnknown')
                : undefined
            }
          >
            {isDefault
              ? t('onboardingWizard.providers.actions.isDefault')
              : t('onboardingWizard.providers.actions.setDefault')}
          </Button>
        )}

        <Button
          size="sm"
          variant="ghost"
          onClick={() => onOpenDocs(meta.docsUrl)}
          className="rounded-xl text-muted-foreground"
        >
          <ExternalLink className="size-4" />
          {t('onboardingWizard.providers.actions.docs')}
        </Button>

        {(status === 'missing' || reason === 'login_required') && meta.installCommand && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              onCopyCommand(
                status === 'missing' ? meta.installCommand! : meta.launchCommand ?? meta.installCommand!
              )
            }
            className="rounded-xl text-muted-foreground"
          >
            <Copy className="size-4" />
            {t('onboardingWizard.actions.copyCommand')}
          </Button>
        )}
      </div>
    </div>
  )
}

function ProviderPrimaryAction({
  id,
  status,
  reason,
  loading,
  busyAction,
  onRunCommand,
  onRefresh
}: {
  id: Exclude<WizardAgentId, 'terminal'>
  status: 'ready' | 'warning' | 'missing'
  reason?: 'ready' | 'missing' | 'login_required' | 'auth_unknown'
  loading: boolean
  busyAction: string | null
  onRunCommand: (command: string, autoRefresh: boolean) => Promise<void>
  onRefresh: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const meta = AGENT_META[id]

  if (loading) {
    return (
      <Button size="sm" disabled className="rounded-xl">
        <Loader2 className="size-4 animate-spin" />
        {t('onboardingWizard.actions.refresh')}
      </Button>
    )
  }

  if (status === 'ready' && reason !== 'auth_unknown') {
    return (
      <Button size="sm" disabled className="rounded-xl">
        <CheckCircle2 className="size-4" />
        {t('onboardingWizard.badges.ready')}
      </Button>
    )
  }

  if (status === 'missing' && meta.installCommand) {
    const cmd = meta.installCommand
    return (
      <Button
        size="sm"
        onClick={() => onRunCommand(cmd, true)}
        disabled={busyAction === cmd}
        className="rounded-xl"
      >
        {busyAction === cmd ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Package className="size-4" />
        )}
        {t('onboardingWizard.providers.actions.install')}
      </Button>
    )
  }

  if (reason === 'login_required' && meta.launchCommand) {
    const cmd = meta.launchCommand
    return (
      <Button
        size="sm"
        onClick={() => onRunCommand(cmd, true)}
        disabled={busyAction === cmd}
        className="rounded-xl"
      >
        {busyAction === cmd ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <ExternalLink className="size-4" />
        )}
        {t('onboardingWizard.providers.actions.login')}
      </Button>
    )
  }

  if (reason === 'auth_unknown') {
    return (
      <Button size="sm" variant="outline" onClick={onRefresh} className="rounded-xl border-border/70 bg-background">
        <RefreshCw className="size-4" />
        {t('onboardingWizard.providers.actions.recheck')}
      </Button>
    )
  }

  return (
    <Button size="sm" variant="outline" onClick={onRefresh} className="rounded-xl border-border/70 bg-background">
      <RefreshCw className="size-4" />
      {t('onboardingWizard.providers.actions.recheck')}
    </Button>
  )
}

function TerminalProviderCard({
  isDefault,
  onSetDefault,
  onOpenDocs
}: {
  isDefault: boolean
  onSetDefault: () => void
  onOpenDocs: (url: string) => Promise<void>
}): React.JSX.Element {
  const { t } = useI18n()

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-2xl border bg-background p-4',
        isDefault ? 'border-primary/45 bg-primary/5' : 'border-border/70'
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-card">
          <TerminalSquare className="size-[18px] text-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {t('onboardingWizard.providers.terminal.fallbackTitle')}
            </span>
            {isDefault && (
              <StatusPill className="border-primary/30 bg-primary/10 text-primary">
                {t('onboardingWizard.providers.terminal.isFallback')}
              </StatusPill>
            )}
          </div>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            {t('onboardingWizard.providers.terminal.fallbackDescription')}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={isDefault ? 'outline' : 'default'}
          disabled={isDefault}
          onClick={onSetDefault}
          className="rounded-xl"
        >
          <TerminalSquare className="size-4" />
          {isDefault
            ? t('onboardingWizard.providers.terminal.isFallback')
            : t('onboardingWizard.providers.terminal.setFallback')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onOpenDocs(TERMINAL_DOCS_URL)}
          className="rounded-xl text-muted-foreground"
        >
          <ExternalLink className="size-4" />
          {t('onboardingWizard.providers.actions.docs')}
        </Button>
      </div>
    </div>
  )
}

// ============================================================================
// Section: Keymap presets
// ============================================================================

function KeymapPresetSection({
  activePreset,
  onSelect
}: {
  activePreset: KeymapPresetId
  onSelect: (id: KeymapPresetId) => void
}): React.JSX.Element {
  const { t } = useI18n()

  return (
    <section className="rounded-3xl border border-border/70 bg-card p-5">
      <header>
        <h3 className="text-base font-medium text-foreground">
          {t('onboardingWizard.keymap.title')}
        </h3>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {t('onboardingWizard.keymap.description')}
        </p>
      </header>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {KEYMAP_PRESET_ORDER.map((presetId) => {
          const meta = KEYMAP_PRESETS[presetId]
          const isActive = presetId === activePreset
          const samples = PRESET_SAMPLE_SHORTCUTS.map(({ id, labelKey }) => {
            // Always show the preset's *native* binding for the sample shortcut,
            // ignoring custom overrides. Custom bindings keep winning at runtime,
            // but the card is meant to convey "what this preset would change."
            const presetBinding = meta.overrides[id]
            const fallback = DEFAULT_SHORTCUTS.find((s) => s.id === id)?.defaultBinding ?? null
            const binding = presetBinding ?? fallback
            return {
              id,
              label: t(labelKey),
              display: binding ? formatBindingForPreview(binding) : ''
            }
          })

          return (
            <button
              key={presetId}
              type="button"
              onClick={() => onSelect(presetId)}
              className={cn(
                'flex flex-col gap-3 rounded-2xl border p-4 text-left transition-colors',
                isActive
                  ? 'border-primary/45 bg-primary/8'
                  : 'border-border/70 bg-background hover:border-border hover:bg-accent/15'
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-sm font-medium text-foreground">{t(meta.labelKey)}</div>
                {isActive && <Check className="size-4 text-primary" />}
              </div>
              <div className="text-xs leading-5 text-muted-foreground">{t(meta.descriptionKey)}</div>
              <div className="mt-auto flex flex-col gap-1">
                {samples.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-card px-2 py-1 text-[11px]"
                  >
                    <span className="truncate text-muted-foreground">{s.label}</span>
                    <span className="font-mono text-foreground/80">{s.display}</span>
                  </div>
                ))}
              </div>
            </button>
          )
        })}
      </div>

      <ImportFromEditor />
    </section>
  )
}

function ImportFromEditor(): React.JSX.Element {
  const { t } = useI18n()
  const applyImportEntries = useShortcutStore((s) => s.applyImportEntries)
  const [sources, setSources] = useState<
    Array<{
      id: 'vscode' | 'cursor'
      path: string
      exists: boolean
      available: boolean
    }>
  >([])
  const [busySource, setBusySource] = useState<'vscode' | 'cursor' | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.systemOps
      .detectKeybindingImportSources()
      .then((result) => {
        if (cancelled) return
        setSources(result)
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const sourceLabels: Record<'vscode' | 'cursor', string> = {
    vscode: t('onboardingWizard.keymap.importSourceVscode'),
    cursor: t('onboardingWizard.keymap.importSourceCursor')
  }

  async function handleImport(sourceId: 'vscode' | 'cursor'): Promise<void> {
    setBusySource(sourceId)
    try {
      const parsed = await window.systemOps.parseKeybindingImportSource(sourceId)
      const sourceLabel = sourceLabels[sourceId]

      if (parsed.errors.length > 0 && parsed.entries.length === 0) {
        const message = parsed.errors[0]
        if (message?.startsWith('Failed to read')) {
          toast.warning(t('onboardingWizard.keymap.importToast.notFound', { source: sourceLabel }))
        } else {
          toast.error(
            t('onboardingWizard.keymap.importToast.error', {
              source: sourceLabel,
              message: message ?? ''
            })
          )
        }
        return
      }

      if (parsed.entries.length === 0) {
        toast.warning(t('onboardingWizard.keymap.importToast.empty', { source: sourceLabel }))
        return
      }

      const { applied, conflicts } = applyImportEntries(parsed.entries)

      if (conflicts.length === 0) {
        toast.success(
          t('onboardingWizard.keymap.importToast.success', {
            source: sourceLabel,
            count: applied
          })
        )
      } else {
        toast.warning(
          t('onboardingWizard.keymap.importToast.partial', {
            source: sourceLabel,
            applied,
            skipped: conflicts.length
          })
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(
        t('onboardingWizard.keymap.importToast.error', {
          source: sourceLabels[sourceId],
          message
        })
      )
    } finally {
      setBusySource(null)
    }
  }

  if (!loaded) return <></>

  const anyAvailable = sources.some((s) => s.available)

  return (
    <div className="mt-4 rounded-2xl border border-border/60 bg-background/40 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">
            {t('onboardingWizard.keymap.importTitle')}
          </div>
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {anyAvailable
              ? t('onboardingWizard.keymap.importDescription')
              : t('onboardingWizard.keymap.importEmpty')}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {sources.map((source) => {
            const label = sourceLabels[source.id]
            const isBusy = busySource === source.id
            const disabled = !source.available || busySource !== null

            return (
              <Button
                key={source.id}
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => handleImport(source.id)}
                title={
                  source.available
                    ? source.path
                    : t('onboardingWizard.keymap.importNotFound', { path: source.path })
                }
                className="rounded-xl border-border/70 bg-background"
              >
                {isBusy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Download className="size-4" />
                )}
                {isBusy
                  ? t('onboardingWizard.keymap.importBusy')
                  : t('onboardingWizard.keymap.importApply', { source: label })}
              </Button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Section: Appearance
// ============================================================================

function AppearanceSection({
  themeId,
  followSystem,
  onSelect,
  onPreview,
  onCancelPreview,
  onToggleFollowSystem
}: {
  themeId: string
  followSystem: boolean
  onSelect: (id: string) => void
  onPreview: (id: string) => void
  onCancelPreview: () => void
  onToggleFollowSystem: (follow: boolean) => void
}): React.JSX.Element {
  const { t } = useI18n()

  return (
    <section className="rounded-3xl border border-border/70 bg-card p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-medium text-foreground">
            {t('onboardingWizard.appearance.title')}
          </h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {t('onboardingWizard.appearance.description')}
          </p>
        </div>

        <button
          type="button"
          onClick={() => onToggleFollowSystem(!followSystem)}
          className={cn(
            'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
            followSystem
              ? 'border-primary/35 bg-primary/10 text-primary'
              : 'border-border/70 bg-background text-muted-foreground hover:bg-accent/20'
          )}
        >
          <Monitor className="size-3.5" />
          {t('onboardingWizard.appearance.followSystem')}
        </button>
      </header>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {THEME_PRESETS.map((preset) => (
          <ThemeOption
            key={preset.id}
            preset={preset}
            isActive={!followSystem && preset.id === themeId}
            disabled={followSystem}
            onSelect={() => onSelect(preset.id)}
            onPreview={() => onPreview(preset.id)}
            onCancelPreview={onCancelPreview}
          />
        ))}
      </div>
    </section>
  )
}

function ThemeOption({
  preset,
  isActive,
  disabled,
  onSelect,
  onPreview,
  onCancelPreview
}: {
  preset: ThemePreset
  isActive: boolean
  disabled: boolean
  onSelect: () => void
  onPreview: () => void
  onCancelPreview: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const typeLabel =
    preset.type === 'dark'
      ? t('onboardingWizard.appearance.dark')
      : t('onboardingWizard.appearance.light')

  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={onPreview}
      onMouseLeave={onCancelPreview}
      onFocus={onPreview}
      onBlur={onCancelPreview}
      disabled={disabled}
      className={cn(
        'group relative flex items-center gap-3 rounded-2xl border p-3 text-left transition-colors',
        isActive
          ? 'border-primary/45 bg-primary/8'
          : 'border-border/70 bg-background hover:border-border hover:bg-accent/15',
        disabled && 'cursor-default opacity-60'
      )}
    >
      <div
        className="size-12 shrink-0 rounded-xl border border-border/40"
        style={{
          background: `linear-gradient(135deg, ${preset.colors.background} 0%, ${preset.colors.background} 50%, ${preset.colors.card} 50%, ${preset.colors.card} 100%)`
        }}
      >
        <div
          className="m-2 h-2 rounded-full"
          style={{ background: preset.colors.primary }}
          aria-hidden="true"
        />
        <div
          className="mx-2 h-1 rounded-full"
          style={{ background: preset.colors.foreground, opacity: 0.5 }}
          aria-hidden="true"
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{preset.name}</span>
          <span className="rounded-full border border-border/65 bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {typeLabel}
          </span>
        </div>
      </div>

      {isActive && <Check className="size-4 shrink-0 text-primary" />}
    </button>
  )
}

// ============================================================================
// Helpers
// ============================================================================

function StatusPill({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
        className
      )}
    >
      {children}
    </span>
  )
}

function getStatusBadgeClass(status: 'ready' | 'warning' | 'missing'): string {
  switch (status) {
    case 'ready':
      return 'border-emerald-300/75 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/30 dark:text-emerald-200'
    case 'warning':
      return 'border-amber-300/75 bg-amber-500/10 text-amber-700 dark:border-amber-400/30 dark:text-amber-200'
    case 'missing':
    default:
      return 'border-border/70 bg-background text-muted-foreground'
  }
}

function getStatusLabelKey(status: 'ready' | 'warning' | 'missing'): string {
  switch (status) {
    case 'ready':
      return 'onboardingWizard.badges.ready'
    case 'warning':
      return 'onboardingWizard.badges.warning'
    case 'missing':
    default:
      return 'onboardingWizard.badges.missing'
  }
}

function resolveEnvironmentText(
  t: ReturnType<typeof useI18n>['t'],
  item: OnboardingEnvironmentCheck
): string {
  switch (item.id) {
    case 'git':
      return item.status === 'ready'
        ? t('onboardingWizard.environment.git.ready', { version: item.version || '' })
        : t('onboardingWizard.environment.git.missing')
    case 'node':
      if (item.reason === 'outdated') {
        return t('onboardingWizard.environment.node.outdated', { version: item.version || '' })
      }
      return item.status === 'ready'
        ? t('onboardingWizard.environment.node.ready', { version: item.version || '' })
        : t('onboardingWizard.environment.node.missing')
    case 'homebrew':
      return item.status === 'ready'
        ? t('onboardingWizard.environment.homebrew.ready', { version: item.version || '' })
        : t('onboardingWizard.environment.homebrew.missing')
    case 'xcode-cli':
      return item.status === 'ready'
        ? t('onboardingWizard.environment.xcodeCli.ready')
        : t('onboardingWizard.environment.xcodeCli.missing')
    default:
      return ''
  }
}

function getAgentTitleKey(agentId: WizardAgentId): string {
  switch (agentId) {
    case 'claude-code':
      return 'onboardingWizard.agents.claudeCode.title'
    case 'codex':
      return 'onboardingWizard.agents.codex.title'
    case 'opencode':
      return 'onboardingWizard.agents.opencode.title'
    case 'terminal':
      return 'onboardingWizard.agents.terminal.title'
  }
}

function getAgentBaseKey(agentId: Exclude<WizardAgentId, 'terminal'>): string {
  switch (agentId) {
    case 'claude-code':
      return 'onboardingWizard.agents.claudeCode'
    case 'codex':
      return 'onboardingWizard.agents.codex'
    case 'opencode':
      return 'onboardingWizard.agents.opencode'
  }
}

function resolveAgentStatusText(
  t: ReturnType<typeof useI18n>['t'],
  agentId: Exclude<WizardAgentId, 'terminal'>,
  agent: OnboardingAgentStatus | null | undefined
): string {
  if (!agent || agent.status === 'missing') {
    return t(`${getAgentBaseKey(agentId)}.missing`)
  }
  if (agent.reason === 'login_required') {
    return t(`${getAgentBaseKey(agentId)}.loginRequired`)
  }
  if (agent.reason === 'auth_unknown') {
    return t(`${getAgentBaseKey(agentId)}.authUnknown`)
  }
  return t(`${getAgentBaseKey(agentId)}.ready`)
}

function resolveActionError(t: ReturnType<typeof useI18n>['t'], error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `${t('onboardingWizard.toasts.actionFailed')}: ${message}`
}

// Format a binding without going through the active store — used for preview
// chips on the keymap preset cards.
function formatBindingForPreview(binding: KeyBinding): string {
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
  const symbols: string[] = []
  for (const mod of binding.modifiers) {
    if (mod === 'meta') symbols.push(isMac ? '⌘' : 'Ctrl')
    else if (mod === 'ctrl') symbols.push(isMac ? '⌃' : 'Ctrl')
    else if (mod === 'alt') symbols.push(isMac ? '⌥' : 'Alt')
    else if (mod === 'shift') symbols.push(isMac ? '⇧' : 'Shift')
  }
  const keyDisplay = binding.key.length === 1 ? binding.key.toUpperCase() : binding.key
  return [...symbols, keyDisplay].join(isMac ? '' : '+')
}

// Re-exported so other modules retain the same import surface.
export type { ShortcutCategory }
