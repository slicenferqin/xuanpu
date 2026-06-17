import type { EpochCloseReason } from '@shared/types/agent-task-run'
import type { BudgetProfile } from './context/budget-manager'

export const GATEWAY_FOCUSED_CONTEXT_TOKENS = 80_000
export const GATEWAY_BALANCED_CONTEXT_TOKENS = 150_000
export const GATEWAY_EXTENDED_CONTEXT_TOKENS = 200_000
export const GATEWAY_MAINTENANCE_TOKEN_LIMIT = 220_000
export const GATEWAY_HARD_TOKEN_LIMIT = 250_000

export type GatewayBudgetAction = 'continue' | 'degrade-profile' | 'compact' | 'pause'

export interface GatewayBudgetProfileLimits {
  focused: number
  balanced: number
  extended: number
}

export interface GatewayBudgetDecision {
  action: GatewayBudgetAction
  reason: string
  requestedProfile: BudgetProfile
  effectiveProfile: BudgetProfile
  profileMaxTokens: number
  maintenanceTokenLimit: number
  hardTokenLimit: number
  providerEstimatedInputTokens: number
  providerContextWindowTokens: number
  fillRatio: number
}

export interface GatewayBudgetInput {
  requestedProfile: BudgetProfile
  providerEstimatedInputTokens: number
  providerContextWindowTokens: number
  profileLimits?: Partial<GatewayBudgetProfileLimits>
  maintenanceTokenLimit?: number
  hardTokenLimit?: number
}

const DEFAULT_GATEWAY_PROFILE_LIMITS: GatewayBudgetProfileLimits = {
  focused: GATEWAY_FOCUSED_CONTEXT_TOKENS,
  balanced: GATEWAY_BALANCED_CONTEXT_TOKENS,
  extended: GATEWAY_EXTENDED_CONTEXT_TOKENS
}

export function getGatewayProfileTokenLimit(profile: BudgetProfile): number {
  return DEFAULT_GATEWAY_PROFILE_LIMITS[profile]
}

export function evaluateGatewayBudget(input: GatewayBudgetInput): GatewayBudgetDecision {
  const profileLimits = { ...DEFAULT_GATEWAY_PROFILE_LIMITS, ...input.profileLimits }
  const maintenanceTokenLimit = input.maintenanceTokenLimit ?? GATEWAY_MAINTENANCE_TOKEN_LIMIT
  const hardTokenLimit = input.hardTokenLimit ?? GATEWAY_HARD_TOKEN_LIMIT
  const providerEstimatedInputTokens = Math.max(0, Math.ceil(input.providerEstimatedInputTokens))
  const providerContextWindowTokens = Math.max(1, Math.floor(input.providerContextWindowTokens))
  const effectiveProfile = resolveEffectiveProfile(
    input.requestedProfile,
    providerEstimatedInputTokens
  )
  const profileMaxTokens = profileLimits[effectiveProfile]
  const fillRatio = providerEstimatedInputTokens / profileMaxTokens

  if (providerEstimatedInputTokens >= hardTokenLimit) {
    return {
      action: 'pause',
      reason: `provider estimated input ${providerEstimatedInputTokens} reached hard gateway limit ${hardTokenLimit}`,
      requestedProfile: input.requestedProfile,
      effectiveProfile,
      profileMaxTokens,
      maintenanceTokenLimit,
      hardTokenLimit,
      providerEstimatedInputTokens,
      providerContextWindowTokens,
      fillRatio
    }
  }

  if (providerEstimatedInputTokens >= maintenanceTokenLimit) {
    return {
      action: 'compact',
      reason: `provider estimated input ${providerEstimatedInputTokens} reached maintenance limit ${maintenanceTokenLimit}`,
      requestedProfile: input.requestedProfile,
      effectiveProfile,
      profileMaxTokens,
      maintenanceTokenLimit,
      hardTokenLimit,
      providerEstimatedInputTokens,
      providerContextWindowTokens,
      fillRatio
    }
  }

  return {
    action: 'continue',
    reason:
      effectiveProfile === input.requestedProfile
        ? 'within gateway profile'
        : `gateway profile bucket adjusted from ${input.requestedProfile} to ${effectiveProfile}`,
    requestedProfile: input.requestedProfile,
    effectiveProfile,
    profileMaxTokens,
    maintenanceTokenLimit,
    hardTokenLimit,
    providerEstimatedInputTokens,
    providerContextWindowTokens,
    fillRatio
  }
}

function resolveEffectiveProfile(
  requestedProfile: BudgetProfile,
  providerEstimatedInputTokens: number
): BudgetProfile {
  if (providerEstimatedInputTokens <= GATEWAY_FOCUSED_CONTEXT_TOKENS) return 'focused'
  if (providerEstimatedInputTokens <= GATEWAY_BALANCED_CONTEXT_TOKENS) return 'balanced'
  return 'extended'
}

export interface EpochBoundaryInput {
  fillRatio: number
  providerCallCount: number
  elapsedMs: number
}

export interface EpochBoundaryDecision {
  close: boolean
  reason: EpochCloseReason
}

export function shouldCloseEpoch(input: EpochBoundaryInput): EpochBoundaryDecision {
  if (input.fillRatio >= 0.4) return { close: true, reason: 'compact' }
  if (input.providerCallCount >= 12) return { close: true, reason: 'checkpoint' }
  return { close: false, reason: 'turn_end' }
}

export type LeaseDecision =
  | { action: 'renew'; nextExpiresAt: string }
  | { action: 'pause'; reason: string }
  | { action: 'ask'; prompt: string }

export interface LeaseBoundaryInput {
  noProgressCalls: number
  costSinceStart: number
  hasPendingRiskyWrite: boolean
  nowMs?: number
  leaseWindowMs?: number
}

export const NO_PROGRESS_LIMIT = 4
export const TASK_RUN_COST_CEILING = 2
export const DEFAULT_LEASE_WINDOW_MS = 20 * 60 * 1000

export function evaluateLeaseAtBoundary(input: LeaseBoundaryInput): LeaseDecision {
  if (input.noProgressCalls >= NO_PROGRESS_LIMIT) {
    return { action: 'pause', reason: 'no progress' }
  }

  if (input.costSinceStart >= TASK_RUN_COST_CEILING) {
    return { action: 'ask', prompt: 'cost ceiling reached, continue?' }
  }

  if (input.hasPendingRiskyWrite) {
    return { action: 'ask', prompt: 'risky write pending approval' }
  }

  const now = input.nowMs ?? Date.now()
  const leaseWindow = input.leaseWindowMs ?? DEFAULT_LEASE_WINDOW_MS
  return { action: 'renew', nextExpiresAt: new Date(now + leaseWindow).toISOString() }
}
