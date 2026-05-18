export const PUSH_TO_TALK_HOLD_DELAY_MS = 180

interface PushToTalkKeyEvent {
  key: string
  repeat?: boolean
  altKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}

export function isPushToTalkStartEvent(event: PushToTalkKeyEvent): boolean {
  return (
    event.key === 'Control' &&
    event.repeat !== true &&
    event.altKey !== true &&
    event.metaKey !== true &&
    event.shiftKey !== true
  )
}

export function isPushToTalkStopEvent(event: PushToTalkKeyEvent): boolean {
  return event.key === 'Control'
}

export function shouldCancelPushToTalkPendingStart(event: PushToTalkKeyEvent): boolean {
  return event.key !== 'Control'
}
