import { describe, expect, it } from 'vitest'
import {
  getClearScreenBottomInset,
  getTimelineSafeBottomPadding
} from '../../src/renderer/src/lib/session-timeline/geometry'

describe('session timeline geometry', () => {
  it('keeps the safe bottom padding formula shared and bounded', () => {
    expect(getTimelineSafeBottomPadding(0)).toBe(72)
    expect(getTimelineSafeBottomPadding(60)).toBe(56)
    expect(getTimelineSafeBottomPadding(160)).toBe(80)
    expect(getTimelineSafeBottomPadding(280)).toBe(96)
  })

  it('preserves the old short-content spacer semantics when the active round is at top', () => {
    expect(
      getClearScreenBottomInset({
        viewportHeight: 600,
        contentHeight: 200,
        activeRoundOffsetTop: 0,
        safeBottomPadding: 72
      })
    ).toBe(304)
  })

  it('computes spacer from active round remaining height in long sessions', () => {
    expect(
      getClearScreenBottomInset({
        viewportHeight: 600,
        contentHeight: 1200,
        activeRoundOffsetTop: 900,
        safeBottomPadding: 72
      })
    ).toBe(204)
  })

  it('does not add spacer when content after the active round already fills the viewport', () => {
    expect(
      getClearScreenBottomInset({
        viewportHeight: 600,
        contentHeight: 1200,
        activeRoundOffsetTop: 200,
        safeBottomPadding: 72
      })
    ).toBe(0)
  })
})
