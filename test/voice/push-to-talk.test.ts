import {
  isPushToTalkStartEvent,
  isPushToTalkStopEvent,
  shouldCancelPushToTalkPendingStart
} from '../../src/renderer/src/lib/voice/push-to-talk'

describe('voice push-to-talk keyboard helpers', () => {
  it('starts only on a non-repeated bare Control key press', () => {
    expect(isPushToTalkStartEvent({ key: 'Control' })).toBe(true)
    expect(isPushToTalkStartEvent({ key: 'Control', repeat: true })).toBe(false)
    expect(isPushToTalkStartEvent({ key: 'Control', shiftKey: true })).toBe(false)
    expect(isPushToTalkStartEvent({ key: 'a' })).toBe(false)
  })

  it('stops when Control is released', () => {
    expect(isPushToTalkStopEvent({ key: 'Control' })).toBe(true)
    expect(isPushToTalkStopEvent({ key: 'Meta' })).toBe(false)
  })

  it('cancels a pending hold when the user is forming another shortcut', () => {
    expect(shouldCancelPushToTalkPendingStart({ key: 'a' })).toBe(true)
    expect(shouldCancelPushToTalkPendingStart({ key: 'Shift' })).toBe(true)
    expect(shouldCancelPushToTalkPendingStart({ key: 'Control' })).toBe(false)
  })
})
