import type { EpochCloseReason, TaskRunAutonomy } from '@shared/types/agent-task-run'

export interface EpochBoundaryInput {
  fillRatio: number
  providerCallCount: number
  elapsedMs: number
  autonomy: TaskRunAutonomy
}

export interface EpochBoundaryDecision {
  close: boolean
  reason: EpochCloseReason
}

export function shouldCloseEpoch(input: EpochBoundaryInput): EpochBoundaryDecision {
  if (input.fillRatio >= 0.4) return { close: true, reason: 'compact' }
  if (input.providerCallCount >= 12) return { close: true, reason: 'checkpoint' }
  if (input.autonomy === 'short') return { close: true, reason: 'turn_end' }
  return { close: false, reason: 'turn_end' }
}

export type LeaseDecision =
  | { action: 'renew'; nextExpiresAt: string }
  | { action: 'pause'; reason: string }
  | { action: 'ask'; prompt: string }

export interface LeaseBoundaryInput {
  autonomy: TaskRunAutonomy
  noProgressCalls: number
  costSinceStart: number
  hasPendingRiskyWrite: boolean
  nowMs?: number
  leaseWindowMs?: number
}

export const NO_PROGRESS_LIMIT = 4
export const LONG_COST_CEILING = 2
export const OVERNIGHT_COST_CEILING = 10
export const DEFAULT_LEASE_WINDOW_MS = 20 * 60 * 1000

export function evaluateLeaseAtBoundary(input: LeaseBoundaryInput): LeaseDecision {
  if (input.autonomy === 'short') {
    return { action: 'pause', reason: 'short task exceeded one lease window' }
  }

  if (input.autonomy === 'long') {
    if (input.noProgressCalls >= NO_PROGRESS_LIMIT) {
      return { action: 'pause', reason: 'no progress' }
    }
    if (input.costSinceStart >= LONG_COST_CEILING) {
      return { action: 'ask', prompt: 'cost ceiling reached, continue?' }
    }
    if (input.hasPendingRiskyWrite) {
      return { action: 'ask', prompt: 'risky write pending approval' }
    }
  }

  if (input.autonomy === 'overnight' && input.costSinceStart >= OVERNIGHT_COST_CEILING) {
    return { action: 'ask', prompt: 'overnight cost ceiling reached' }
  }

  const now = input.nowMs ?? Date.now()
  const leaseWindow = input.leaseWindowMs ?? DEFAULT_LEASE_WINDOW_MS
  return { action: 'renew', nextExpiresAt: new Date(now + leaseWindow).toISOString() }
}
