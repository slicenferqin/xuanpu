export const CLEAR_SCREEN_SPACER_SELECTOR = '[data-clear-screen-spacer="true"]'

export function getTimelineSafeBottomPadding(bottomFloatingHeight: number): number {
  return bottomFloatingHeight > 0
    ? Math.min(96, Math.max(56, Math.round(bottomFloatingHeight * 0.3) + 32))
    : 72
}

export interface ClearScreenBottomInsetInput {
  viewportHeight: number
  contentHeight: number
  activeRoundOffsetTop?: number | null
  safeBottomPadding: number
  topBreathingRoom?: number
}

export function getClearScreenBottomInset({
  viewportHeight,
  contentHeight,
  activeRoundOffsetTop = 0,
  safeBottomPadding,
  topBreathingRoom = 24
}: ClearScreenBottomInsetInput): number {
  if (viewportHeight <= 0 || contentHeight <= 0) return 0

  const roundOffset = Math.max(0, Math.round(activeRoundOffsetTop ?? 0))
  const remainingContentHeight = Math.max(0, contentHeight - roundOffset)

  return Math.max(0, viewportHeight - remainingContentHeight - safeBottomPadding - topBreathingRoom)
}
