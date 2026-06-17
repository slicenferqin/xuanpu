import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LEASE_WINDOW_MS,
  GATEWAY_HARD_TOKEN_LIMIT,
  GATEWAY_MAINTENANCE_TOKEN_LIMIT,
  evaluateGatewayBudget,
  evaluateLeaseAtBoundary,
  shouldCloseEpoch
} from '../../src/main/services/xuanpu-agent/task-run-policy'

describe('xuanpu-agent task-run policy', () => {
  describe('shouldCloseEpoch', () => {
    it('closes for compaction when fill ratio reaches the soft-shrink boundary', () => {
      expect(
        shouldCloseEpoch({
          fillRatio: 0.4,
          providerCallCount: 1,
          elapsedMs: 1000
        })
      ).toEqual({ close: true, reason: 'compact' })
    })

    it('closes for checkpoint when provider call count reaches the epoch cap', () => {
      expect(
        shouldCloseEpoch({
          fillRatio: 0.1,
          providerCallCount: 12,
          elapsedMs: 1000
        })
      ).toEqual({ close: true, reason: 'checkpoint' })
    })

    it('keeps the epoch open when no boundary is reached', () => {
      expect(
        shouldCloseEpoch({
          fillRatio: 0.1,
          providerCallCount: 1,
          elapsedMs: 1000
        })
      ).toEqual({ close: false, reason: 'turn_end' })
    })
  })

  describe('evaluateLeaseAtBoundary', () => {
    it('pauses tasks that stop making progress', () => {
      expect(
        evaluateLeaseAtBoundary({
          noProgressCalls: 4,
          costSinceStart: 0,
          hasPendingRiskyWrite: false
        })
      ).toEqual({ action: 'pause', reason: 'no progress' })
    })

    it('asks before continuing when a task reaches the cost ceiling', () => {
      expect(
        evaluateLeaseAtBoundary({
          noProgressCalls: 0,
          costSinceStart: 2,
          hasPendingRiskyWrite: false
        })
      ).toEqual({ action: 'ask', prompt: 'cost ceiling reached, continue?' })
    })

    it('asks before continuing when a risky write is pending', () => {
      expect(
        evaluateLeaseAtBoundary({
          noProgressCalls: 0,
          costSinceStart: 0,
          hasPendingRiskyWrite: true
        })
      ).toEqual({ action: 'ask', prompt: 'risky write pending approval' })
    })

    it('renews eligible tasks', () => {
      const nowMs = Date.UTC(2026, 5, 5, 0, 0, 0)

      expect(
        evaluateLeaseAtBoundary({
          noProgressCalls: 0,
          costSinceStart: 0,
          hasPendingRiskyWrite: false,
          nowMs
        })
      ).toEqual({
        action: 'renew',
        nextExpiresAt: new Date(nowMs + DEFAULT_LEASE_WINDOW_MS).toISOString()
      })
    })

    it('renews eligible tasks across successive lease windows', () => {
      const firstBoundaryMs = Date.UTC(2026, 5, 5, 0, 20, 0)
      const secondBoundaryMs = firstBoundaryMs + DEFAULT_LEASE_WINDOW_MS

      expect(
        evaluateLeaseAtBoundary({
          noProgressCalls: 0,
          costSinceStart: 0.1,
          hasPendingRiskyWrite: false,
          nowMs: firstBoundaryMs
        })
      ).toEqual({
        action: 'renew',
        nextExpiresAt: new Date(firstBoundaryMs + DEFAULT_LEASE_WINDOW_MS).toISOString()
      })

      expect(
        evaluateLeaseAtBoundary({
          noProgressCalls: 0,
          costSinceStart: 0.2,
          hasPendingRiskyWrite: false,
          nowMs: secondBoundaryMs
        })
      ).toEqual({
        action: 'renew',
        nextExpiresAt: new Date(secondBoundaryMs + DEFAULT_LEASE_WINDOW_MS).toISOString()
      })
    })
  })

  describe('evaluateGatewayBudget', () => {
    it('continues under the gateway maintenance limit without using the provider 1M window', () => {
      const decision = evaluateGatewayBudget({
        requestedProfile: 'balanced',
        providerEstimatedInputTokens: 180_000,
        providerContextWindowTokens: 1_000_000
      })

      expect(decision.action).toBe('continue')
      expect(decision.providerContextWindowTokens).toBe(1_000_000)
      expect(decision.hardTokenLimit).toBe(GATEWAY_HARD_TOKEN_LIMIT)
      expect(decision.effectiveProfile).toBe('extended')
    })

    it('asks the runtime to compact when the estimate reaches the 220K maintenance band', () => {
      expect(
        evaluateGatewayBudget({
          requestedProfile: 'extended',
          providerEstimatedInputTokens: GATEWAY_MAINTENANCE_TOKEN_LIMIT,
          providerContextWindowTokens: 1_000_000
        })
      ).toMatchObject({
        action: 'compact',
        maintenanceTokenLimit: GATEWAY_MAINTENANCE_TOKEN_LIMIT,
        hardTokenLimit: GATEWAY_HARD_TOKEN_LIMIT
      })
    })

    it('pauses before sending a request at the 250K hard gateway limit', () => {
      expect(
        evaluateGatewayBudget({
          requestedProfile: 'extended',
          providerEstimatedInputTokens: GATEWAY_HARD_TOKEN_LIMIT,
          providerContextWindowTokens: 1_000_000
        })
      ).toMatchObject({
        action: 'pause',
        hardTokenLimit: GATEWAY_HARD_TOKEN_LIMIT
      })
    })
  })
})
