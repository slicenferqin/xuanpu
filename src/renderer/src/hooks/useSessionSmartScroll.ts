import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getSessionViewState,
  updateSessionViewState,
  type SessionViewState
} from '@/lib/session-view-registry'

const NEAR_BOTTOM_THRESHOLD = 80
const BOTTOM_AREA_COMPENSATE_THRESHOLD = 96
const DEFAULT_SCROLL_FAB_OFFSET = 16

interface UseSessionSmartScrollOptions {
  sessionId: string
  ready: boolean
  contentVersion: number
  mirrorVersion: number
  isStreaming: boolean
  bottomAreaRef?: React.RefObject<HTMLElement | null>
  composerRef?: React.RefObject<HTMLElement | null>
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
}

function getDistanceFromBottom(element: HTMLDivElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight
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
  composerRef
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
  const [dockHeight, setDockHeight] = useState(0)
  const [composerHeight, setComposerHeight] = useState(0)
  const [viewState, setViewState] = useState<SessionViewState>(() =>
    getSessionViewState(sessionId, mirrorVersion)
  )
  const viewStateRef = useRef(viewState)

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

      const stickyBottom =
        options?.forceStickyBottom ?? getDistanceFromBottom(element) < NEAR_BOTTOM_THRESHOLD
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
      scrollElementTo(element, element.scrollHeight, behavior)

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

  const restoreScrollAnchor = useCallback(() => {
    if (hasRestoredInitialAnchorRef.current || !ready) return

    const element = scrollContainerRef.current
    if (!element) return

    const current = viewStateRef.current
    hasRestoredInitialAnchorRef.current = true

    requestAnimationFrame(() => {
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

    const distanceFromBottom = getDistanceFromBottom(element)
    const isNearBottom = distanceFromBottom < NEAR_BOTTOM_THRESHOLD
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

  useEffect(() => {
    latestMirrorVersionRef.current = mirrorVersion
  }, [mirrorVersion])

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

  useEffect(() => {
    if (!ready || !hasRestoredInitialAnchorRef.current || !viewStateRef.current.stickyBottom) {
      return
    }
    scrollToBottom()
  }, [contentVersion, mirrorVersion, ready, scrollToBottom])

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

      const distanceFromBottom = getDistanceFromBottom(scrollElement)
      const shouldCompensate =
        viewStateRef.current.stickyBottom || distanceFromBottom < BOTTOM_AREA_COMPENSATE_THRESHOLD

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

    const observedTargets: Array<readonly [HTMLElement | null | undefined, (height: number) => void]> = [
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
  }, [bottomAreaRef, composerRef, resetInteractionState, scrollToBottom, sessionId])

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
    }
  }, [persistCurrentAnchor, resetInteractionState])

  const scrollFabCount = Math.max(0, mirrorVersion - viewState.lastSeenVersion)
  const showScrollFab = !viewState.stickyBottom && scrollFabCount > 0

  const scrollFabBottomOffset = useMemo(() => {
    const dockOffset = dockHeight > 0 ? dockHeight + 16 : DEFAULT_SCROLL_FAB_OFFSET
    const composerOffset = composerHeight > 0 ? composerHeight + 32 : DEFAULT_SCROLL_FAB_OFFSET
    return Math.max(DEFAULT_SCROLL_FAB_OFFSET, dockOffset, composerOffset)
  }, [composerHeight, dockHeight])

  return {
    scrollContainerRef,
    showScrollFab,
    scrollFabCount,
    scrollFabBottomOffset,
    /**
     * Measured pixel height of the floating ComposerBar (and any sibling
     * floating dock). Consumers should use this to size the bottom padding
     * of their scroll viewport so transcript content doesn't get hidden
     * behind the composer.
     */
    bottomFloatingHeight: Math.max(composerHeight, dockHeight),
    handleScroll,
    handleScrollWheel,
    handleScrollPointerDown,
    handleScrollPointerUp,
    handleScrollPointerCancel,
    handleScrollToBottomClick
  }
}
