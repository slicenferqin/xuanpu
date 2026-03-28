import { useEffect, useMemo, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronLeft,
  Command,
  Copy,
  ExternalLink,
  GitBranch,
  Hammer,
  Loader2,
  Package,
  Play,
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

type WizardAgentId = 'claude-code' | 'codex' | 'opencode' | 'terminal'
type WizardStepId = 'environment' | 'agent'

interface AgentSetupWizardProps {
  result: OnboardingDoctorResult | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  onComplete: (sdk: WizardAgentId) => void
}

interface AgentMeta {
  icon: LucideIcon
  docsUrl: string
  installCommand?: string
  launchCommand?: string
}

const AGENT_ORDER: WizardAgentId[] = ['claude-code', 'codex', 'opencode', 'terminal']

const AGENT_META: Record<WizardAgentId, AgentMeta> = {
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
  },
  terminal: {
    icon: TerminalSquare,
    docsUrl: 'https://github.com/morapelker/hive'
  }
}

const ENVIRONMENT_META: Record<
  OnboardingEnvironmentCheck['id'],
  { icon: LucideIcon; titleKey: string }
> = {
  git: {
    icon: GitBranch,
    titleKey: 'onboardingWizard.environment.git.title'
  },
  node: {
    icon: Command,
    titleKey: 'onboardingWizard.environment.node.title'
  },
  homebrew: {
    icon: Package,
    titleKey: 'onboardingWizard.environment.homebrew.title'
  },
  'xcode-cli': {
    icon: Hammer,
    titleKey: 'onboardingWizard.environment.xcodeCli.title'
  }
}

export function AgentSetupWizard({
  result,
  loading,
  error,
  onRefresh,
  onComplete
}: AgentSetupWizardProps): React.JSX.Element {
  const { t } = useI18n()
  const [currentStep, setCurrentStep] = useState<WizardStepId>('environment')
  const [focusedAgentId, setFocusedAgentId] = useState<WizardAgentId>('claude-code')
  const [selectedAgentId, setSelectedAgentId] = useState<WizardAgentId | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)

  const agentsById = useMemo(() => {
    return new Map((result?.agents ?? []).map((agent) => [agent.id, agent]))
  }, [result])

  useEffect(() => {
    if (!result) return

    const firstSelectable =
      AGENT_ORDER.find(
        (id) =>
          id !== 'terminal' &&
          agentsById.get(id as Exclude<WizardAgentId, 'terminal'>)?.selectable === true
      ) ?? null

    setFocusedAgentId((current) => {
      if (current === 'terminal') return current
      if (agentsById.has(current)) return current
      return result.recommendedAgent
    })

    setSelectedAgentId((current) => {
      if (current === 'terminal') return current
      if (current && current !== 'terminal' && agentsById.get(current)?.selectable) {
        return current
      }
      return firstSelectable
    })
  }, [agentsById, result])

  const environmentChecks = result?.environmentChecks ?? []
  const environmentIssues = environmentChecks.filter((item) => item.status !== 'ready')

  const canStart =
    selectedAgentId === 'terminal' ||
    (!!selectedAgentId &&
      selectedAgentId !== 'terminal' &&
      agentsById.get(selectedAgentId)?.selectable === true)

  const selectedAgentTitle =
    selectedAgentId === 'terminal'
      ? t('onboardingWizard.agents.terminal.title')
      : selectedAgentId
        ? t(getAgentTitleKey(selectedAgentId))
        : null

  async function copyCommand(command: string): Promise<void> {
    try {
      await window.projectOps.copyToClipboard(command)
      toast.success(t('onboardingWizard.toasts.commandCopied'))
    } catch (error) {
      toast.error(resolveActionError(t, error))
    }
  }

  async function openDocs(url: string): Promise<void> {
    try {
      const response = await window.systemOps.openInChrome(url)
      if (!response.success) {
        throw new Error(response.error || 'Failed to open docs')
      }
      toast.success(t('onboardingWizard.toasts.docsOpened'))
    } catch (error) {
      toast.error(resolveActionError(t, error))
    }
  }

  async function runCommand(command: string): Promise<void> {
    setBusyAction(command)
    try {
      const response = await window.systemOps.openCommandInTerminal(command)
      if (!response.success) {
        throw new Error(response.error || 'Failed to open terminal')
      }
      toast.success(t('onboardingWizard.toasts.terminalOpened'))
    } catch (error) {
      toast.error(resolveActionError(t, error))
    } finally {
      setBusyAction(null)
    }
  }

  function handleFocusAgent(id: WizardAgentId): void {
    setFocusedAgentId(id)

    if (id === 'terminal') {
      setSelectedAgentId('terminal')
      return
    }

    if (agentsById.get(id)?.selectable) {
      setSelectedAgentId(id)
    }
  }

  function handlePrimaryAction(): void {
    if (currentStep === 'environment') {
      setCurrentStep('agent')
      return
    }

    if (!canStart || !selectedAgentId) {
      toast.warning(t('onboardingWizard.toasts.selectedAgentRequired'))
      return
    }

    onComplete(selectedAgentId)
  }

  const footerHint =
    currentStep === 'environment'
      ? environmentIssues.length === 0
        ? t('onboardingWizard.helper.environmentReady')
        : t('onboardingWizard.helper.environmentNeedsAttention', {
            count: environmentIssues.length
          })
      : selectedAgentTitle
        ? t('onboardingWizard.helper.selectedReady', { agent: selectedAgentTitle })
        : t('onboardingWizard.summary.pendingDescription')

  return (
    <AlertDialog open={true}>
      <AlertDialogContent
        size="lg"
        className="h-[calc(100vh-2rem)] max-h-[760px] overflow-hidden border border-border/70 bg-background p-0 shadow-[0_24px_80px_-40px_rgba(15,23,42,0.35)] sm:max-w-[1040px]"
      >
        <div className="flex h-full min-h-0 flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-border/60 px-6 py-5">
            <div>
              <div className="text-[22px] font-semibold tracking-tight text-foreground">
                {t('onboardingWizard.headerTitle')}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                {t('onboardingWizard.headerDescription')}
              </div>
            </div>

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
          </header>

          <div className="border-b border-border/60 px-6 py-4">
            <WizardStepper
              currentStep={currentStep}
              onStepChange={setCurrentStep}
              disabled={loading || !!error || !result}
            />
          </div>

          {loading ? (
            <div className="flex flex-1 items-center justify-center px-6 py-10">
              <div className="flex max-w-md flex-col items-center rounded-3xl border border-border/70 bg-card px-8 py-10 text-center">
                <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Loader2 className="size-6 animate-spin" />
                </div>
                <div className="mt-4 text-lg font-medium text-foreground">
                  {t('onboardingWizard.loading.title')}
                </div>
                <div className="mt-2 text-sm leading-6 text-muted-foreground">
                  {t('onboardingWizard.loading.description')}
                </div>
              </div>
            </div>
          ) : error ? (
            <div className="flex flex-1 items-center justify-center px-6 py-10">
              <div className="max-w-xl rounded-3xl border border-amber-300/60 bg-card p-6">
                <div className="flex items-start gap-3">
                  <div className="flex size-10 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600">
                    <AlertTriangle className="size-5" />
                  </div>
                  <div>
                    <div className="text-base font-medium text-foreground">
                      {t('onboardingWizard.error.title')}
                    </div>
                    <div className="mt-1 text-sm leading-6 text-muted-foreground">
                      {t('onboardingWizard.error.description')}
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-border/70 bg-background px-4 py-3 text-sm text-muted-foreground">
                  {error}
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-2">
                  <Button onClick={onRefresh} className="rounded-xl">
                    <RefreshCw className="size-4" />
                    {t('onboardingWizard.actions.retry')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => onComplete('terminal')}
                    className="rounded-xl border-border/70 bg-background"
                  >
                    <TerminalSquare className="size-4" />
                    {t('onboardingWizard.actions.useTerminal')}
                  </Button>
                </div>
              </div>
            </div>
          ) : result ? (
            <>
              <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
                {currentStep === 'environment' ? (
                  <EnvironmentStep checks={environmentChecks} issues={environmentIssues} />
                ) : (
                  <AgentStep
                    result={result}
                    focusedAgentId={focusedAgentId}
                    selectedAgentId={selectedAgentId}
                    busyAction={busyAction}
                    onFocusAgent={handleFocusAgent}
                    onCopyCommand={copyCommand}
                    onRunCommand={runCommand}
                    onOpenDocs={openDocs}
                  />
                )}
              </div>

              <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-6 py-4">
                <div className="text-sm text-muted-foreground">{footerHint}</div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => window.systemOps.quitApp()}
                    className="rounded-xl text-muted-foreground"
                  >
                    {t('onboardingWizard.actions.quit')}
                  </Button>

                  {currentStep === 'agent' && (
                    <Button
                      variant="outline"
                      onClick={() => setCurrentStep('environment')}
                      className="rounded-xl border-border/70 bg-background"
                    >
                      <ChevronLeft className="size-4" />
                      {t('onboardingWizard.actions.back')}
                    </Button>
                  )}

                  {currentStep === 'agent' && (
                    <Button
                      variant="outline"
                      onClick={() => handleFocusAgent('terminal')}
                      className="rounded-xl border-border/70 bg-background"
                    >
                      <TerminalSquare className="size-4" />
                      {t('onboardingWizard.actions.useTerminal')}
                    </Button>
                  )}

                  <Button
                    onClick={handlePrimaryAction}
                    disabled={currentStep === 'agent' && !canStart}
                    className="rounded-xl"
                  >
                    {currentStep === 'environment' ? (
                      <>
                        {t('onboardingWizard.actions.next')}
                        <ArrowRight className="size-4" />
                      </>
                    ) : (
                      <>
                        {t('onboardingWizard.actions.start')}
                        <ArrowRight className="size-4" />
                      </>
                    )}
                  </Button>
                </div>
              </footer>
            </>
          ) : null}
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function WizardStepper({
  currentStep,
  onStepChange,
  disabled
}: {
  currentStep: WizardStepId
  onStepChange: (step: WizardStepId) => void
  disabled: boolean
}): React.JSX.Element {
  const { t } = useI18n()

  const steps: Array<{ id: WizardStepId; title: string; description: string }> = [
    {
      id: 'environment',
      title: t('onboardingWizard.steps.inspect'),
      description: t('onboardingWizard.steps.inspectDescription')
    },
    {
      id: 'agent',
      title: t('onboardingWizard.steps.choose'),
      description: t('onboardingWizard.steps.chooseDescription')
    }
  ]

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {steps.map((step, index) => {
        const isActive = step.id === currentStep

        return (
          <button
            key={step.id}
            type="button"
            disabled={disabled}
            onClick={() => onStepChange(step.id)}
            className={cn(
              'flex items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-colors',
              isActive
                ? 'border-primary/35 bg-primary/6'
                : 'border-border/70 bg-background hover:border-border hover:bg-accent/20',
              disabled && 'cursor-default opacity-80'
            )}
          >
            <div
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              )}
            >
              {index + 1}
            </div>

            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{step.title}</div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                {step.description}
              </div>
            </div>
          </button>
        )
      })}
    </div>
  )
}

function EnvironmentStep({
  checks,
  issues
}: {
  checks: OnboardingEnvironmentCheck[]
  issues: OnboardingEnvironmentCheck[]
}): React.JSX.Element {
  const { t } = useI18n()

  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-border/70 bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-medium text-foreground">
              {t('onboardingWizard.environment.title')}
            </h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {t('onboardingWizard.environment.description')}
            </p>
          </div>
          <span className="rounded-full border border-border/70 bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
            {checks.length - issues.length}/{checks.length}
          </span>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {checks.map((item) => (
            <EnvironmentCard key={item.id} item={item} />
          ))}
        </div>
      </section>

      <div
        className={cn(
          'rounded-2xl border px-4 py-3 text-sm',
          issues.length === 0
            ? 'border-emerald-300/60 bg-emerald-500/8 text-emerald-700 dark:border-emerald-400/30 dark:text-emerald-200'
            : 'border-amber-300/60 bg-amber-500/8 text-amber-700 dark:border-amber-400/30 dark:text-amber-200'
        )}
      >
        <div className="flex items-start gap-2">
          {issues.length === 0 ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          )}
          <div>
            <div className="font-medium">
              {issues.length === 0
                ? t('onboardingWizard.helper.environmentReady')
                : t('onboardingWizard.helper.environmentNeedsAttention', { count: issues.length })}
            </div>
            {issues.length > 0 && (
              <div className="mt-1 leading-6">
                {issues.map((item) => t(ENVIRONMENT_META[item.id].titleKey)).join(' / ')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function AgentStep({
  result,
  focusedAgentId,
  selectedAgentId,
  busyAction,
  onFocusAgent,
  onCopyCommand,
  onRunCommand,
  onOpenDocs
}: {
  result: OnboardingDoctorResult
  focusedAgentId: WizardAgentId
  selectedAgentId: WizardAgentId | null
  busyAction: string | null
  onFocusAgent: (id: WizardAgentId) => void
  onCopyCommand: (command: string) => Promise<void>
  onRunCommand: (command: string) => Promise<void>
  onOpenDocs: (url: string) => Promise<void>
}): React.JSX.Element {
  const { t } = useI18n()
  const agentsById = new Map(result.agents.map((agent) => [agent.id, agent]))
  const activeAgent =
    focusedAgentId === 'terminal'
      ? null
      : agentsById.get(focusedAgentId as Exclude<WizardAgentId, 'terminal'>) ?? null

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
      <section className="rounded-3xl border border-border/70 bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-medium text-foreground">
              {t('onboardingWizard.agents.title')}
            </h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {t('onboardingWizard.agents.description')}
            </p>
          </div>
          <span className="rounded-full border border-border/70 bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
            {result.agents.filter((agent) => agent.selectable).length}/{result.agents.length}
          </span>
        </div>

        <div className="mt-4 space-y-3">
          {AGENT_ORDER.map((agentId) => {
            const agent = agentId === 'terminal' ? null : agentsById.get(agentId)
            const meta = AGENT_META[agentId]
            const Icon = meta.icon
            const isFocused = focusedAgentId === agentId
            const isSelected = selectedAgentId === agentId
            const isSelectable = agentId === 'terminal' || agent?.selectable === true
            const status = agentId === 'terminal' ? 'ready' : agent?.status ?? 'missing'

            return (
              <button
                key={agentId}
                type="button"
                onClick={() => onFocusAgent(agentId)}
                className={cn(
                  'flex w-full items-start gap-4 rounded-2xl border px-4 py-4 text-left transition-colors',
                  isFocused
                    ? 'border-primary/35 bg-primary/6'
                    : 'border-border/70 bg-background hover:border-border hover:bg-accent/20',
                  isSelected && 'border-emerald-300/65 bg-emerald-500/8'
                )}
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-card">
                  <Icon className="size-[18px] text-foreground" />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {t(getAgentTitleKey(agentId))}
                    </span>
                    <StatusPill className={getStatusBadgeClass(status)}>
                      {t(getStatusLabelKey(status))}
                    </StatusPill>
                    {result.recommendedAgent === agentId && (
                      <StatusPill className="border-primary/25 bg-primary/8 text-primary">
                        {t('onboardingWizard.badges.recommended')}
                      </StatusPill>
                    )}
                    {isSelected && (
                      <StatusPill className="border-emerald-300/70 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/30 dark:text-emerald-200">
                        {t('onboardingWizard.badges.selected')}
                      </StatusPill>
                    )}
                    {agentId !== 'terminal' && agent?.version && (
                      <span className="rounded-full border border-border/65 bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
                        {agent.version}
                      </span>
                    )}
                  </div>

                  <div className="mt-2 text-sm leading-6 text-muted-foreground">
                    {resolveAgentStatusText(t, agentId, agent)}
                  </div>

                  {!isSelectable && (
                    <div className="mt-2 text-xs text-muted-foreground">
                      {t('onboardingWizard.helper.agentNotReady')}
                    </div>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </section>

      <section className="rounded-3xl border border-border/70 bg-card p-5 lg:sticky lg:top-0">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-2xl border border-border/70 bg-background">
            {(() => {
              const Icon = AGENT_META[focusedAgentId].icon
              return <Icon className="size-[18px] text-foreground" />
            })()}
          </div>
          <div>
            <div className="text-base font-medium text-foreground">
              {focusedAgentId === 'terminal'
                ? t('onboardingWizard.agents.terminal.title')
                : t(getAgentTitleKey(focusedAgentId))}
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              {resolveHelperDescription(t, focusedAgentId, activeAgent)}
            </div>
          </div>
        </div>

        {focusedAgentId === 'terminal' ? (
          <div className="mt-4 rounded-2xl border border-border/70 bg-background px-4 py-4 text-sm leading-6 text-muted-foreground">
            {t('onboardingWizard.agents.terminal.detail')}
          </div>
        ) : (
          renderCommandBlock(
            t,
            focusedAgentId,
            activeAgent,
            busyAction,
            onCopyCommand,
            onRunCommand,
            onOpenDocs
          )
        )}
      </section>
    </div>
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
        'inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium whitespace-nowrap',
        className
      )}
    >
      {children}
    </span>
  )
}

function renderCommandBlock(
  t: ReturnType<typeof useI18n>['t'],
  agentId: Exclude<WizardAgentId, 'terminal'>,
  agent: OnboardingAgentStatus | null,
  busyAction: string | null,
  copyCommand: (command: string) => Promise<void>,
  runCommand: (command: string) => Promise<void>,
  openDocs: (url: string) => Promise<void>
): React.JSX.Element {
  const meta = AGENT_META[agentId]
  const installCommand = meta.installCommand
  const launchCommand = meta.launchCommand

  const primaryCommand =
    !agent || agent.status === 'missing' ? installCommand : agent.reason === 'login_required' ? launchCommand : null

  const commandHint =
    !agent || agent.status === 'missing'
      ? t('onboardingWizard.helper.installDescription', {
          agent: t(getAgentTitleKey(agentId))
        })
      : agent.reason === 'login_required'
        ? resolveLoginHint(t, agentId)
        : resolveHelperDescription(t, agentId, agent)

  return (
    <div className="mt-4 rounded-2xl border border-border/70 bg-background p-4">
      <div className="text-sm leading-6 text-muted-foreground">{commandHint}</div>

      {primaryCommand ? (
        <>
          <div className="mt-4 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
            {t('onboardingWizard.helper.commandLabel')}
          </div>
          <code className="mt-2 block overflow-x-auto rounded-xl border border-border/70 bg-card px-3 py-2 text-xs text-foreground">
            {primaryCommand}
          </code>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="sm" className="rounded-xl" onClick={() => runCommand(primaryCommand)}>
              {busyAction === primaryCommand ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              {t('onboardingWizard.actions.runInTerminal')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => copyCommand(primaryCommand)}
              className="rounded-xl border-border/70 bg-background"
            >
              <Copy className="size-4" />
              {t('onboardingWizard.actions.copyCommand')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => openDocs(meta.docsUrl)}
              className="rounded-xl border-border/70 bg-background"
            >
              <ExternalLink className="size-4" />
              {t('onboardingWizard.actions.openDocs')}
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => openDocs(meta.docsUrl)}
            className="rounded-xl border-border/70 bg-background"
          >
            <ExternalLink className="size-4" />
            {t('onboardingWizard.actions.openDocs')}
          </Button>
        </div>
      )}
    </div>
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

function resolveAgentStatusText(
  t: ReturnType<typeof useI18n>['t'],
  agentId: WizardAgentId,
  agent: OnboardingAgentStatus | null | undefined
): string {
  if (agentId === 'terminal') {
    return t('onboardingWizard.agents.terminal.description')
  }

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

function resolveHelperDescription(
  t: ReturnType<typeof useI18n>['t'],
  agentId: WizardAgentId,
  agent: OnboardingAgentStatus | null
): string {
  if (agentId === 'terminal') {
    return t('onboardingWizard.helper.terminalDescription')
  }

  if (!agent || agent.status === 'missing') {
    return t('onboardingWizard.helper.installDescription', {
      agent: t(getAgentTitleKey(agentId))
    })
  }

  if (agent.reason === 'login_required') {
    return t('onboardingWizard.helper.loginDescription', {
      agent: t(getAgentTitleKey(agentId))
    })
  }

  if (agent.reason === 'auth_unknown') {
    return t('onboardingWizard.helper.authUnknownDescription', {
      agent: t(getAgentTitleKey(agentId))
    })
  }

  return t('onboardingWizard.helper.agentReadyDescription', {
    agent: t(getAgentTitleKey(agentId))
  })
}

function resolveLoginHint(
  t: ReturnType<typeof useI18n>['t'],
  agentId: Exclude<WizardAgentId, 'terminal'>
): string {
  switch (agentId) {
    case 'claude-code':
      return t('onboardingWizard.helper.loginHintClaude')
    case 'codex':
      return t('onboardingWizard.helper.loginHintCodex')
    case 'opencode':
      return t('onboardingWizard.helper.loginHintOpencode')
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

function resolveActionError(t: ReturnType<typeof useI18n>['t'], error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `${t('onboardingWizard.toasts.actionFailed')}: ${message}`
}
