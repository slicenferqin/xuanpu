/**
 * Test that the Xuanpu system context spells out the contract clearly enough
 * that any future change reviewers can spot when the protective hint goes
 * missing. This is essentially a contract-locking test — we don't try to
 * verify the model behaves correctly (that needs an integration test), only
 * that the agreed wording is present and stable.
 */
import { describe, it, expect } from 'vitest'
import { XUANPU_SYSTEM_CONTEXT } from '../src/main/services/xuanpu-system-context'

describe('XUANPU_SYSTEM_CONTEXT', () => {
  it('explains the [Field Context] / [User Message] wrapper is informational', () => {
    expect(XUANPU_SYSTEM_CONTEXT).toMatch(/\[Field Context.*\]/)
    expect(XUANPU_SYSTEM_CONTEXT).toMatch(/\[User Message\]/)
    expect(XUANPU_SYSTEM_CONTEXT.toLowerCase()).toMatch(/informational|not.*contract/)
  })

  it('forbids silent-exit on bare user messages', () => {
    expect(XUANPU_SYSTEM_CONTEXT).toContain('Continue from where you left off.')
    // Must explicitly tell the model "No response requested." is wrong.
    expect(XUANPU_SYSTEM_CONTEXT).toMatch(/No response requested/)
  })

  it('asks the model to resume the prior task on bare resume markers', () => {
    expect(XUANPU_SYSTEM_CONTEXT.toLowerCase()).toMatch(/resume.*(task|prior)/)
  })

  it('flags Field Context as observed data, not authoritative instructions', () => {
    expect(XUANPU_SYSTEM_CONTEXT.toLowerCase()).toMatch(
      /observed.*data|not.*authoritative/
    )
  })

  it('is short enough to be cheap on every turn (< 1500 chars)', () => {
    expect(XUANPU_SYSTEM_CONTEXT.length).toBeLessThan(1500)
  })

  it('is non-empty and contains no trailing whitespace', () => {
    expect(XUANPU_SYSTEM_CONTEXT.length).toBeGreaterThan(100)
    expect(XUANPU_SYSTEM_CONTEXT).toBe(XUANPU_SYSTEM_CONTEXT.trim())
  })
})
