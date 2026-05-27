import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  getSessionViewState,
  updateSessionViewState,
  type SessionViewState
} from '@/lib/session-view-registry'

const BOTTOM_AREA_COMPENSATE_THRESHOLD = 96
const DEFAULT_SCROLL_FAB_OFFSET = 16
const MIN_NEAR_BOTTOM_THRESHOLD = 80

export type TimelineScrollMode = 'history' | 'sticky-bottom' | 'round-focus'

interface UseSessionSmartScrollOptions {
  sessionId: string
  ready: boolean
  contentVersion: number
  mirrorVersion: number
  isStreaming: boolean
  bottomAreaRef?: React.RefObject<HTMLElement | null>
  composerRef?: React.RefObject<HTMLElement | null>
  /**
   * Ref to the focus filler height (px). During round-focus, the filler
   * provides scrollable space so the user message can sit at viewport top.
   * distanceToContentEnd subtracts this from scrollHeight.
   */
  focusFillerHeightRef?: React.RefObject<number>
  /**
   * Ref to the current scroll mode. Smart-scroll skips auto-scroll during
   * 'round-focus' to let the user message stay pinned at the top.
   */
  scrollModeRef?: React.RefObject<TimelineScrollMode>
  /**
   * Ref indicating the user manually scrolled during round-focus.
   * Once true, smart-scroll respects 'history' mode and doesn't re-enter.
   */
  manualScrollLockedRef?: React.RefObject<boolean>
}

interface UseSessionSmartScrollResult {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  showScrollFab: boolean
  scrollFabCount: number
  scrollFabBottomOffset: number
  bottomFloatingHeight: number
  handleScroll: () => void
  handleScrollWheel: () => void
  handleScrollPointerDown: () => void
  handleScrollPointerUp: () => void
  handleScrollPointerCancel: () => void
  handleScrollToBottomClick: () => void
  scrollToOffset: (top: number, behavior?: ScrollBehavior) => void
  cancelPendingScrollToBottom: () => void
  cancelPendingRestoreScroll: () => void
}

// ── Distance helpers ────────────────────────────────────────────────

/**
 * Distance to scrollable end (includes filler).
 * Used for native scroll boundary detection.
 */
function getDistanceToScrollableEnd(element: HTMLDivElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight
}

/**
 * Distance to real content end (excludes filler).
 * Used for FAB, sticky-bottom, streaming auto-follow, unread detection.
 */
function getDistanceToContentEnd(element: HTMLDivElement, fillerHeight: number): number {
  return element.scrollHeight - fillerHeight - element.scrollTop - element.clientHeight
}

function getBottomScrollTop(element: HTMLDivElement, fillerHeight: number): number {
  return Math.max(0, element.scrollHeight - element.clientHeight - fillerHeight)
}

function getNearBottomThreshold(): number {
  if (typeof window === 'undefined') return MIN_NEAR_BOTTOM_THRESHOLD
  return Math.max(MIN_NEAR_BOTTOM_THRESHOLD, Math.round(window.innerHeight * 0.06))
}

function scrollElementTo(element: HTMLDivElement, top: number, behavior: ScrollBehavior): void {
  if (typeof element.scrollTo === 'function') {
    try {
      element.scrollTo({ top, behavior })
      return
    } catch {
      // Fall back to direct assignment for test environments and older runtimes.
    }
  }

  element.scrollTop = top
}

export function useSessionSmartScroll({
  sessionId,
  ready,
  contentVersion,
  mirrorVersion,
  isStreaming,
  bottomAreaRef,
  composerRef,
  focusFillerHeightRef,
  scrollModeRef,
  manualScrollLockedRef
}: UseSessionSmartScrollOptions): UseSessionSmartScrollResult {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const programmaticScrollResetRef = useRef<number | null>(null)
  const bottomAreaScrollRafRef = useRef<number | null>(null)
  const isProgrammaticScrollRef = useRef(false)
  const manualScrollIntentRef = useRef(false)
  const pointerDownInScrollerRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  const hasRestoredInitialAnchorRef = useRef(false)
  const latestMirrorVersionRef = useRef(mirrorVersion)
  const isStreamingRef = useRef(isStreaming)
  const [dockHeight, setDockHeight] = useState(0)
  const [composerHeight, setComposerHeight] = useState(0)
  const [viewState, setViewState] = useState<SessionViewState>(() =>
    getSessionViewState(sessionId, mirrorVersion)
  )
  const viewStateRef = useRef(viewState)

  const getFillerHeight = (): number => focusFillerHeightRef?.current ?? 0
  const getScrollMode = (): TimelineScrollMode => scrollModeRef?.current ?? 'sticky-bottom'
  const isManualScrollLocked = (): boolean => manualScrollLockedRef?.current ?? false

  const writeViewState = useCallback(
    (
      updater: (current: SessionViewState) => Partial<SessionViewState>,
      options?: { syncState?: boolean }
    ): SessionViewState => {
      const next = updateSessionViewState(sessionId, updater, mirrorVersion)
      viewStateRef.current = next
      if (options?.syncState ?? true) {
        setViewState(next)
      }
      return next
    },
    [mirrorVersion, sessionId]
  )

  const persistCurrentAnchor = useCallback(
    (options?: { syncState?: boolean; forceStickyBottom?: boolean; markSeen?: boolean }) => {
      const element = scrollContainerRef.current
      const current = viewStateRef.current

      if (!element) {
        if (options?.syncState) {
          setViewState(current)
        }
        return current
      }

      // Use content end (excluding filler) for sticky-bottom detection
      const stickyBottom =
        options?.forceStickyBottom ??
        getDistanceToContentEnd(element, getFillerHeight()) < getNearBottomThreshold()
      const shouldMarkSeen = options?.markSeen ?? stickyBottom

      const next = writeViewState(
        () => ({
          scrollTop: element.scrollTop,
          stickyBottom,
          manualScrollLocked: stickyBottom ? false : true,
          lastSeenVersion: shouldMarkSeen ? mirrorVersion : current.lastSeenVersion
        }),
        { syncState: options?.syncState ?? false }
      )

      lastScrollTopRef.current = element.scrollTop
      return next
    },
    [mirrorVersion, writeViewState]
  )

  const markProgrammaticScroll = useCallback(() => {
    isProgrammaticScrollRef.current = true
    if (programmaticScrollResetRef.current !== null) {
      cancelAnimationFrame(programmaticScrollResetRef.current)
    }
    programmaticScrollResetRef.current = requestAnimationFrame(() => {
      programmaticScrollResetRef.current = requestAnimationFrame(() => {
        isProgrammaticScrollRef.current = false
        programmaticScrollResetRef.current = null
      })
    })
  }, [])

  const resetInteractionState = useCallback(() => {
    if (programmaticScrollResetRef.current !== null) {
      cancelAnimationFrame(programmaticScrollResetRef.current)
      programmaticScrollResetRef.current = null
    }
    isProgrammaticScrollRef.current = false
    manualScrollIntentRef.current = false
    pointerDownInScrollerRef.current = false

    const element = scrollContainerRef.current
    if (element) {
      lastScrollTopRef.current = element.scrollTop
    }
  }, [])

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = isStreaming ? 'instant' : 'smooth') => {
      const element = scrollContainerRef.current
      if (!element) return

      markProgrammaticScroll()
      scrollElementTo(element, getBottomScrollTop(element, getFillerHeight()), behavior)

      const current = viewStateRef.current
      const shouldSyncState =
        !current.stickyBottom ||
        current.manualScrollLocked ||
        current.lastSeenVersion !== mirrorVersion

      persistCurrentAnchor({
        syncState: shouldSyncState,
        forceStickyBottom: true,
        markSeen: true
      })
    },
    [isStreaming, markProgrammaticScroll, mirrorVersion, persistCurrentAnchor]
  )

  const scrollToOffset = useCallback(
    (top: number, behavior: ScrollBehavior = 'instant') => {
      const element = scrollContainerRef.current
      if (!element) return

      const nextTop = Math.max(0, Math.min(top, getBottomScrollTop(element, 0)))
      markProgrammaticScroll()
      scrollElementTo(element, nextTop, behavior)
      lastScrollTopRef.current = nextTop
      writeViewState(() => ({
        scrollTop: nextTop,
        stickyBottom: false,
        manualScrollLocked: false,
        lastSeenVersion: mirrorVersion
      }))
    },
    [markProgrammaticScroll, mirrorVersion, writeViewState]
  )

  const restoreScrollRafRef = useRef<number | null>(null)

  const restoreScrollAnchor = useCallback(() => {
    if (hasRestoredInitialAnchorRef.current || !ready) return

    const element = scrollContainerRef.current
    if (!element) return

    const current = viewStateRef.current
    hasRestoredInitialAnchorRef.current = true

    if (restoreScrollRafRef.current !== null) {
      cancelAnimationFrame(restoreScrollRafRef.current)
    }
    restoreScrollRafRef.current = requestAnimationFrame(() => {
      restoreScrollRafRef.current = null
      if (current.stickyBottom) {
        scrollToBottom('instant')
        return
      }

      markProgrammaticScroll()
      scrollElementTo(element, current.scrollTop, 'instant')
      persistCurrentAnchor({
        syncState: false,
        forceStickyBottom: false,
        markSeen: false
      })
    })
  }, [markProgrammaticScroll, persistCurrentAnchor, ready, scrollToBottom])

  const handleScroll = useCallback(() => {
    const element = scrollContainerRef.current
    if (!element) return

    const currentScrollTop = element.scrollTop
    lastScrollTopRef.current = currentScrollTop

    const current = {
      ...viewStateRef.current,
      scrollTop: currentScrollTop
    }
    viewStateRef.current = current

    // Use content end for near-bottom detection
    const distanceFromBottom = getDistanceToContentEnd(element, getFillerHeight())
    const isNearBottom = distanceFromBottom < getNearBottomThreshold()
    const hasManualIntent = manualScrollIntentRef.current || pointerDownInScrollerRef.current

    if (isProgrammaticScrollRef.current) {
      manualScrollIntentRef.current = false
      return
    }

    if (isNearBottom && hasManualIntent) {
      writeViewState(() => ({
        scrollTop: currentScrollTop,
        stickyBottom: true,
        manualScrollLocked: false,
        lastSeenVersion: mirrorVersion
      }))
      manualScrollIntentRef.current = false
      return
    }

    if (!hasManualIntent) {
      return
    }

    writeViewState(
      () => ({
        scrollTop: currentScrollTop,
        stickyBottom: false,
        manualScrollLocked: true,
        lastSeenVersion: current.lastSeenVersion
      }),
      { syncState: current.stickyBottom || !current.manualScrollLocked }
    )
    manualScrollIntentRef.current = false
  }, [mirrorVersion, writeViewState])

  const handleScrollToBottomClick = useCallback(() => {
    resetInteractionState()
    scrollToBottom('smooth')
  }, [resetInteractionState, scrollToBottom])

  const handleScrollWheel = useCallback(() => {
    manualScrollIntentRef.current = true
  }, [])

  const handleScrollPointerDown = useCallback(() => {
    pointerDownInScrollerRef.current = true
  }, [])

  const handleScrollPointerUp = useCallback(() => {
    pointerDownInScrollerRef.current = false
    manualScrollIntentRef.current = false
  }, [])

  const handleScrollPointerCancel = useCallback(() => {
    pointerDownInScrollerRef.current = false
    manualScrollIntentRef.current = false
  }, [])

  const cancelPendingScrollToBottom = useCallback(() => {
    if (bottomAreaScrollRafRef.current !== null) {
      cancelAnimationFrame(bottomAreaScrollRafRef.current)
      bottomAreaScrollRafRef.current = null
    }
  }, [])

  const cancelPendingRestoreScroll = useCallback(() => {
    if (restoreScrollRafRef.current !== null) {
      cancelAnimationFrame(restoreScrollRafRef.current)
      restoreScrollRafRef.current = null
    }
  }, [])

  useEffect(() => {
    latestMirrorVersionRef.current = mirrorVersion
  }, [mirrorVersion])

  useEffect(() => {
    isStreamingRef.current = isStreaming
  }, [isStreaming])

  useEffect(() => {
    const next = getSessionViewState(sessionId, latestMirrorVersionRef.current)
    viewStateRef.current = next
    setViewState(next)
    hasRestoredInitialAnchorRef.current = false
    resetInteractionState()
  }, [resetInteractionState, sessionId])

  useEffect(() => {
    const current = viewStateRef.current

    if (mirrorVersion < current.lastSeenVersion) {
      writeViewState(() => ({
        ...current,
        lastSeenVersion: mirrorVersion
      }))
      return
    }

    if (current.stickyBottom && mirrorVersion > current.lastSeenVersion) {
      writeViewState(() => ({
        ...current,
        lastSeenVersion: mirrorVersion
      }))
    }
  }, [mirrorVersion, writeViewState])

  useEffect(() => {
    restoreScrollAnchor()
  }, [contentVersion, ready, restoreScrollAnchor])

  // Streaming auto-follow + idle sticky-bottom.
  //
  // KEY: Skip auto-scroll during 'round-focus' mode. The user message is
  // pinned at the viewport top; assistant content grows below it, and the
  // filler shrinks. We should NOT scrollToBottom during this phase.
  useEffect(() => {
    if (!ready || !hasRestoredInitialAnchorRef.current) return

    // Round-focus: let the controller manage scroll position
    if (getScrollMode() === 'round-focus') return

    const element = scrollContainerRef.current
    if (!element) return

    if (isStreaming) {
      if (isManualScrollLocked()) return
      // Use content end (excluding filler) for streaming threshold
      const distance = getDistanceToContentEnd(element, getFillerHeight())
      const streamingThreshold = getNearBottomThreshold() * 3
      if (distance < streamingThreshold) {
        scrollToBottom('instant')
      }
      return
    }

    if (!viewStateRef.current.stickyBottom) return
    scrollToBottom()
  }, [contentVersion, isStreaming, mirrorVersion, ready, scrollToBottom])

  // Bottom area resize compensation.
  // Skip during round-focus to avoid pulling user message away from top.
  useLayoutEffect(() => {
    const dockElement = bottomAreaRef?.current
    const composerElement = composerRef?.current
    setDockHeight(dockElement?.getBoundingClientRect().height ?? 0)
    setComposerHeight(composerElement?.getBoundingClientRect().height ?? 0)
  }, [bottomAreaRef, composerRef])

  useEffect(() => {
    const dockElement = bottomAreaRef?.current
    const composerElement = composerRef?.current
    setDockHeight(dockElement?.getBoundingClientRect().height ?? 0)
    setComposerHeight(composerElement?.getBoundingClientRect().height ?? 0)

    if (typeof ResizeObserver === 'undefined') return

    const observers: ResizeObserver[] = []
    const handleResize = () => {
      const scrollElement = scrollContainerRef.current
      if (!scrollElement) return

      // Skip compensation during round-focus
      if (getScrollMode() === 'round-focus') return

      const distanceFromBottom = getDistanceToContentEnd(scrollElement, getFillerHeight())
      const shouldCompensate = isStreamingRef.current
        ? !viewStateRef.current.manualScrollLocked
        : viewStateRef.current.stickyBottom ||
          distanceFromBottom < BOTTOM_AREA_COMPENSATE_THRESHOLD

      if (!shouldCompensate) return

      if (bottomAreaScrollRafRef.current !== null) {
        cancelAnimationFrame(bottomAreaScrollRafRef.current)
      }

      bottomAreaScrollRafRef.current = requestAnimationFrame(() => {
        bottomAreaScrollRafRef.current = null
        resetInteractionState()
        scrollToBottom('instant')
      })
    }

    const observedTargets: Array<
      readonly [HTMLElement | null | undefined, (height: number) => void]
    > = [
      [dockElement, setDockHeight],
      [composerElement, setComposerHeight]
    ]

    for (const [target, updateHeight] of observedTargets) {
      if (!target) continue
      const observer = new ResizeObserver((entries) => {
        const nextHeight =
          entries[0]?.contentRect.height ?? target.getBoundingClientRect().height ?? 0
        updateHeight(nextHeight)
        handleResize()
      })
      observer.observe(target)
      observers.push(observer)
    }

    return () => {
      for (const observer of observers) {
        observer.disconnect()
      }
      if (bottomAreaScrollRafRef.current !== null) {
        cancelAnimationFrame(bottomAreaScrollRafRef.current)
        bottomAreaScrollRafRef.current = null
      }
    }
  }, [
    bottomAreaRef,
    composerRef,
    resetInteractionState,
    scrollToBottom,
    sessionId
  ])

  useEffect(() => {
    return () => {
      persistCurrentAnchor({
        syncState: false
      })
      resetInteractionState()
      if (bottomAreaScrollRafRef.current !== null) {
        cancelAnimationFrame(bottomAreaScrollRafRef.current)
        bottomAreaScrollRafRef.current = null
      }
      if (restoreScrollRafRef.current !== null) {
        cancelAnimationFrame(restoreScrollRafRef.current)
        restoreScrollRafRef.current = null
      }
    }
  }, [persistCurrentAnchor, resetInteractionState])

  const scrollFabCount = Math.max(0, mirrorVersion - viewState.lastSeenVersion)
  // Use content end for FAB visibility (exclude filler)
  const showScrollFab = (() => {
    const element = scrollContainerRef.current
    if (!element) return !viewState.stickyBottom && scrollFabCount > 0
    return getDistanceToContentEnd(element, getFillerHeight()) > getNearBottomThreshold() && scrollFabCount > 0
  })()

  const scrollFabBottomOffset = useMemo(() => {
    const bottomChromeHeight = dockHeight + composerHeight
    return bottomChromeHeight > 0 ? bottomChromeHeight + 32 : DEFAULT_SCROLL_FAB_OFFSET
  }, [composerHeight, dockHeight])

  return {
    scrollContainerRef,
    showScrollFab,
    scrollFabCount,
    scrollFabBottomOffset,
    bottomFloatingHeight: composerHeight + dockHeight,
    handleScroll,
    handleScrollWheel,
    handleScrollPointerDown,
    handleScrollPointerUp,
    handleScrollPointerCancel,
    handleScrollToBottomClick,
    scrollToOffset,
    cancelPendingScrollToBottom,
    cancelPendingRestoreScroll
  }
}
