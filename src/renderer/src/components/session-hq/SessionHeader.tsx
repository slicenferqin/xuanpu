/**
 * SessionHeader — thin-border capsule layout
 *
 * Left:  provider+lifecycle │ model selector
 */

import { useMemo, useState } from 'react'
import { Lock, TerminalSquare, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ModelSelector } from '../sessions/ModelSelector'
import { ContextIndicator } from '../sessions/ContextIndicator'
import { SessionCostPill } from '../sessions/SessionCostPill'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { useContextStore } from '@/stores/useContextStore'
import { useI18n } from '@/i18n/useI18n'
import { toast } from '@/lib/toast'
import type { SessionLifecycle } from '@/stores/useSessionRuntimeStore'
import type { UsageAnalyticsSessionSummary } from '@shared/types/usage-analytics'

type AgentSdk = 'opencode' | 'claude-code' | 'codex' | 'terminal' | 'xuanpu-agent'

const PROVIDER_LABELS: Record<string, string> = {
  'claude-code': 'Claude',
  opencode: 'OpenCode',
  codex: 'Codex'
}

function getProviderLabel(sdk: string, t: ReturnType<typeof useI18n>['t']): string {
  if (sdk === 'terminal') return t('bottomPanel.tabs.terminal')
  return PROVIDER_LABELS[sdk] ?? sdk
}

function getLifecycleLabel(
  lifecycle: SessionLifecycle,
  t: ReturnType<typeof useI18n>['t']
): string {
  switch (lifecycle) {
    case 'idle':
      return t('sessionHq.header.lifecycle.idle')
    case 'busy':
      return t('sessionHq.header.lifecycle.busy')
    case 'retry':
      return t('sessionHq.header.lifecycle.retry')
    case 'error':
      return t('sessionHq.header.lifecycle.error')
    case 'materializing':
      return t('sessionHq.header.lifecycle.materializing')
  }
}

const LIFECYCLE_META: Record<SessionLifecycle, { dotClass: string }> = {
  idle: { dotClass: 'bg-muted-foreground/50' },
  busy: { dotClass: 'bg-neon-mint crisp-status-dot animate-pulse' },
  retry: { dotClass: 'bg-neon-violet crisp-status-dot animate-pulse' },
  error: { dotClass: 'bg-neon-pink crisp-status-dot' },
  materializing: { dotClass: 'bg-tech-blue crisp-status-dot animate-pulse' }
}

function ProviderCapsule({
  sessionId,
  sdk,
  lifecycle,
  locked
}: {
  sessionId: string
  sdk: string
  lifecycle: SessionLifecycle
  locked: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const label = getProviderLabel(sdk, t)
  const lifecycleLabel = getLifecycleLabel(lifecycle, t)
  const meta = LIFECYCLE_META[lifecycle] ?? LIFECYCLE_META.idle
  const availableAgentSdks = useSettingsStore((s) => s.availableAgentSdks)
  const [open, setOpen] = useState(false)

  const enabledSdks = useMemo<AgentSdk[]>(() => {
    const list: AgentSdk[] = []
    if (availableAgentSdks?.opencode) list.push('opencode')
    if (availableAgentSdks?.claude) list.push('claude-code')
    if (availableAgentSdks?.codex) list.push('codex')
    list.push('terminal')
    return list
  }, [availableAgentSdks])

  if (locked) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex items-center gap-1.5 border border-border/40 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground cursor-default"
            data-testid="provider-capsule-locked"
            title={lifecycleLabel}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', meta.dotClass)} />
            {label}
            <Lock className="h-3 w-3 opacity-70" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6} className="max-w-[240px]">
          <div className="space-y-1">
            <div className="font-medium text-[11px]">{t('newSessionDialog.lock.header')}</div>
            <div className="text-[10px] opacity-80">{t('newSessionDialog.lock.description')}</div>
          </div>
        </TooltipContent>
      </Tooltip>
    )
  }

  async function handleSelectSdk(next: AgentSdk): Promise<void> {
    setOpen(false)
    if (next === sdk) return
    const result = await useSessionStore.getState().updateSessionAgent(sessionId, {
      agentSdk: next
    })
    if (!result.success) {
      toast.error(result.error || t('sessionHq.header.providerUpdateError'))
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 border border-border/40 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors cursor-pointer"
          data-testid="provider-capsule"
          title={lifecycleLabel}
        >
          <span className={cn('h-1.5 w-1.5 rounded-full', meta.dotClass)} />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-44 p-1">
        {enabledSdks.map((s) => {
          const active = s === sdk
          return (
            <button
              key={s}
              type="button"
              onClick={() => {
                void handleSelectSdk(s)
              }}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs transition-colors',
                active ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted/60'
              )}
            >
              <span className="flex items-center gap-1.5">
                {s === 'terminal' && <TerminalSquare className="h-3.5 w-3.5 text-tech-blue" />}
                {getProviderLabel(s, t)}
              </span>
              {active && <Check className="h-3.5 w-3.5" />}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

export interface SessionHeaderProps {
  sessionId: string
  session: {
    agent_sdk: string
    opencode_session_id: string | null
    model_id: string | null
    model_provider_id: string | null
    first_message_at?: number | null
  }
  lifecycle: SessionLifecycle
  usageSummary?: UsageAnalyticsSessionSummary | null
}

export function SessionHeader({
  sessionId,
  session,
  lifecycle,
  usageSummary
}: SessionHeaderProps): React.JSX.Element {
  const locked = session.first_message_at != null
  const isTerminal = session.agent_sdk === 'terminal'
  const sessionCostSnapshot = useContextStore((state) => state.costBySession[sessionId] ?? 0)
  const sessionTokenSnapshot = useContextStore((state) => state.tokensBySession[sessionId] ?? null)

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-border/60 shrink-0">
      <ProviderCapsule
        sessionId={sessionId}
        sdk={session.agent_sdk}
        lifecycle={lifecycle}
        locked={locked}
      />
      {!isTerminal && <ModelSelector sessionId={sessionId} compact showProviderPrefix={false} />}
      {!isTerminal && (
        <ContextIndicator
          sessionId={sessionId}
          modelId={session.model_id ?? ''}
          providerId={session.model_provider_id ?? undefined}
        />
      )}
      {!isTerminal && (
        <SessionCostPill
          summary={usageSummary}
          fallbackCost={sessionCostSnapshot}
          fallbackTokens={
            sessionTokenSnapshot
              ? {
                  input: sessionTokenSnapshot.input,
                  output: sessionTokenSnapshot.output,
                  cacheRead: sessionTokenSnapshot.cacheRead,
                  cacheWrite: sessionTokenSnapshot.cacheWrite
                }
              : null
          }
        />
      )}

      <div className="flex-1" />
    </div>
  )
}
