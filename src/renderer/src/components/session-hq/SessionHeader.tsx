/**
 * SessionHeader — Phase 4
 *
 * Compact header bar showing session metadata:
 *   provider badge │ model │ lifecycle │ tokens │ cost
 *
 * Pure display component — receives all data via props.
 */

import React from 'react'
import { cn } from '@/lib/utils'
import { ContextIndicator } from '../sessions/ContextIndicator'
import { SessionCostPill } from '../sessions/SessionCostPill'
import type { SessionLifecycle } from '@/stores/useSessionRuntimeStore'

// ---------------------------------------------------------------------------
// Provider badge
// ---------------------------------------------------------------------------

const PROVIDER_COLORS: Record<string, string> = {
  'claude-code': 'bg-[#fab387]/15 text-[#fab387] border-[#fab387]/30',
  opencode: 'bg-[#94e2d5]/15 text-[#94e2d5] border-[#94e2d5]/30',
  codex: 'bg-[#74c7ec]/15 text-[#74c7ec] border-[#74c7ec]/30',
  terminal: 'bg-[#7f849c]/15 text-[#7f849c] border-[#7f849c]/30'
}

const PROVIDER_LABELS: Record<string, string> = {
  'claude-code': 'Claude',
  opencode: 'OpenCode',
  codex: 'Codex',
  terminal: 'Terminal'
}

function ProviderBadge({ sdk }: { sdk: string }): React.JSX.Element {
  const colorClass = PROVIDER_COLORS[sdk] ?? PROVIDER_COLORS.terminal
  const label = PROVIDER_LABELS[sdk] ?? sdk

  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-medium border',
        colorClass
      )}
    >
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Lifecycle indicator
// ---------------------------------------------------------------------------

const LIFECYCLE_META: Record<
  SessionLifecycle,
  { label: string; dotClass: string }
> = {
  idle: { label: 'Idle', dotClass: 'bg-muted-foreground/50' },
  busy: { label: 'Working', dotClass: 'bg-green-500 animate-pulse' },
  retry: { label: 'Retrying', dotClass: 'bg-yellow-500 animate-pulse' },
  error: { label: 'Error', dotClass: 'bg-red-500' },
  materializing: { label: 'Starting', dotClass: 'bg-blue-500 animate-pulse' }
}

function LifecycleIndicator({ lifecycle }: { lifecycle: SessionLifecycle }): React.JSX.Element {
  const meta = LIFECYCLE_META[lifecycle] ?? LIFECYCLE_META.idle
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn('h-1.5 w-1.5 rounded-full', meta.dotClass)} />
      {meta.label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Main header
// ---------------------------------------------------------------------------

export interface SessionHeaderProps {
  sessionId: string
  session: {
    agent_sdk: string
    model_id: string | null
    model_provider_id: string | null
    name: string | null
  }
  lifecycle: SessionLifecycle
  modelId?: string
  providerId?: string
}

export function SessionHeader({
  sessionId,
  session,
  lifecycle,
  modelId,
  providerId
}: SessionHeaderProps): React.JSX.Element {
  const effectiveModelId = modelId ?? session.model_id ?? ''
  const effectiveProviderId = providerId ?? session.model_provider_id ?? ''

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-background/80 backdrop-blur-sm shrink-0">
      {/* Provider badge */}
      <ProviderBadge sdk={session.agent_sdk} />

      {/* Session title */}
      <span className="text-sm font-medium truncate max-w-[200px]">
        {session.name ?? 'Untitled'}
      </span>

      {/* Lifecycle dot */}
      <LifecycleIndicator lifecycle={lifecycle} />

      {/* Spacer */}
      <div className="flex-1" />

      {/* Context / tokens */}
      {effectiveModelId && (
        <ContextIndicator
          sessionId={sessionId}
          modelId={effectiveModelId}
          providerId={effectiveProviderId}
        />
      )}

      {/* Cost pill */}
      <SessionCostPill sessionId={sessionId} />
    </div>
  )
}
