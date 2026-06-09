import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LEASE_WINDOW_MS,
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
          elapsedMs: 1000,
          autonomy: 'long'
        })
      ).toEqual({ close: true, reason: 'compact' })
    })

    it('closes for checkpoint when provider call count reaches the epoch cap', () => {
      expect(
        shouldCloseEpoch({
          fillRatio: 0.1,
          providerCallCount: 12,
          elapsedMs: 1000,
          autonomy: 'overnight'
        })
      ).toEqual({ close: true, reason: 'checkpoint' })
    })

    it('closes short tasks at the turn boundary even without compaction pressure', () => {
      expect(
        shouldCloseEpoch({
          fillRatio: 0.1,
          providerCallCount: 1,
          elapsedMs: 1000,
          autonomy: 'short'
        })
      ).toEqual({ close: true, reason: 'turn_end' })
    })

    it('keeps long tasks open when no epoch boundary is reached', () => {
      expect(
        shouldCloseEpoch({
          fillRatio: 0.1,
          providerCallCount: 1,
          elapsedMs: 1000,
          autonomy: 'long'
        })
      ).toEqual({ close: false, reason: 'turn_end' })
    })
  })

  describe('evaluateLeaseAtBoundary', () => {
    it('pauses short tasks at a lease boundary', () => {
      expect(
        evaluateLeaseAtBoundary({
          autonomy: 'short',
          noProgressCalls: 0,
          costSinceStart: 0,
          hasPendingRiskyWrite: false
        })
      ).toEqual({ action: 'pause', reason: 'short task exceeded one lease window' })
    })

    it('pauses long tasks that stop making progress', () => {
      expect(
        evaluateLeaseAtBoundary({
          autonomy: 'long',
          noProgressCalls: 4,
          costSinceStart: 0,
          hasPendingRiskyWrite: false
        })
      ).toEqual({ action: 'pause', reason: 'no progress' })
    })

    it('asks before continuing when a long task reaches the cost ceiling', () => {
      expect(
        evaluateLeaseAtBoundary({
          autonomy: 'long',
          noProgressCalls: 0,
          costSinceStart: 2,
          hasPendingRiskyWrite: false
        })
      ).toEqual({ action: 'ask', prompt: 'cost ceiling reached, continue?' })
    })

    it('renews eligible long and overnight tasks', () => {
      const nowMs = Date.UTC(2026, 5, 5, 0, 0, 0)

      expect(
        evaluateLeaseAtBoundary({
          autonomy: 'long',
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

    it('renews eligible long tasks across successive lease windows', () => {
      const firstBoundaryMs = Date.UTC(2026, 5, 5, 0, 20, 0)
      const secondBoundaryMs = firstBoundaryMs + DEFAULT_LEASE_WINDOW_MS

      expect(
        evaluateLeaseAtBoundary({
          autonomy: 'long',
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
          autonomy: 'long',
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
})
