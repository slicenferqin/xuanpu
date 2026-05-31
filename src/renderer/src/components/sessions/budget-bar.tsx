/**
 * BudgetBar — M3 Context Budget indicator for Session HQ header.
 *
 * Shows:
 *   - Token fill bar (estimated / max)
 *   - Compression ratio (before → after bytes)
 *   - Budget profile label (focused / balanced / extended)
 *   - Emergency shrink flash
 *
 * Only renders when budget state is available (xuanpu-agent sessions).
 */
import type React from 'react'
import { useBudgetState, type BudgetState } from '@/hooks/useBudgetState'

interface BudgetBarProps {
  sessionId: string | null
}

export function BudgetBar({ sessionId }: BudgetBarProps): React.JSX.Element | null {
  const budget = useBudgetState(sessionId)

  if (!budget) return null

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <BudgetFillBar budget={budget} />
      <CompressionRatio budget={budget} />
      <ProfileLabel profile={budget.profile} />
    </div>
  )
}

// ── Fill bar ────────────────────────────────────────────────────────────────

function BudgetFillBar({ budget }: { budget: BudgetState }): React.JSX.Element {
  const pct = Math.min(budget.fillRatio * 100, 100).toFixed(0)
  const isHigh = budget.fillRatio >= 0.8
  const isMid = budget.fillRatio >= 0.4

  return (
    <div
      className="flex items-center gap-1.5"
      title={`${budget.estimatedTokens.toLocaleString()} / ${budget.maxTokens.toLocaleString()} tokens`}
    >
      <div className="w-16 h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            isHigh ? 'bg-red-500' : isMid ? 'bg-amber-400' : 'bg-emerald-400'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`font-mono tabular-nums ${isHigh ? 'text-red-400' : ''}`}>{pct}%</span>
    </div>
  )
}

// ── Compression ratio ───────────────────────────────────────────────────────

function CompressionRatio({ budget }: { budget: BudgetState }): React.JSX.Element | null {
  if (budget.totalBeforeBytes === 0) return null

  const ratio =
    budget.totalBeforeBytes > 0 ? (1 - budget.totalAfterBytes / budget.totalBeforeBytes) * 100 : 0

  const before = formatBytes(budget.totalBeforeBytes)
  const after = formatBytes(budget.totalAfterBytes)

  return (
    <span
      className="font-mono tabular-nums"
      title={`Compression: ${before} → ${after} (${ratio.toFixed(0)}% reduction)`}
    >
      {before}→{after}
    </span>
  )
}

// ── Profile label ───────────────────────────────────────────────────────────

function ProfileLabel({ profile }: { profile: string }): React.JSX.Element {
  const colors: Record<string, string> = {
    focused: 'text-blue-400',
    balanced: 'text-emerald-400',
    extended: 'text-purple-400'
  }

  return (
    <span
      className={`font-medium uppercase tracking-wider ${colors[profile] ?? 'text-muted-foreground'}`}
    >
      {profile}
    </span>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}
