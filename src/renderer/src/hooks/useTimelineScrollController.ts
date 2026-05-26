import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from 'react'
import { useSessionSmartScroll } from '@/hooks/useSessionSmartScroll'
import {
  CLEAR_SCREEN_SPACER_SELECTOR,
  getClearScreenBottomInset,
  getTimelineSafeBottomPadding
} from '@/lib/session-timeline/geometry'

interface PendingRoundScroll {
  type: 'clear-screen'
  roundId: string
}

interface UseTimelineScrollControllerOptions {
  sessionId: string
  ready: boolean
  contentVersion: number
  metricsVersion?: number | string
  mirrorVersion: number
  isStreaming: boolean
  bottomAreaRef?: RefObject<HTMLElement | null>
  composerRef?: RefObject<HTMLElement | null>
}

interface UseTimelineScrollControllerResult {
  scrollContainerRef: RefObject<HTMLDivElement | null>
  timelineContentRef: RefObject<HTMLDivElement | null>
  showScrollFab: boolean
  scrollFabCount: number
  scrollFabBottomOffset: number
  bottomFloatingHeight: number
  clearScreenBottomInset: number
  activeRoundId: string | null
  handleScroll: () => void
  handleScrollWheel: () => void
  handleScrollPointerDown: () => void
  handleScrollPointerUp: () => void
  handleScrollPointerCancel: () => void
  handleScrollToBottomClick: () => void
  scrollToOffset: (top: number, behavior?: ScrollBehavior) => void
  scrollToRound: (roundId: string, options?: { behavior?: ScrollBehavior; topPadding?: number }) => void
  requestClearScreenScroll: (roundId: string) => void
}

function findRoundSection(container: HTMLElement, roundId: string): HTMLElement | null {
  const sections = Array.from(container.querySelectorAll<HTMLElement>('[data-round-id]'))
  return sections.find((section) => section.dataset.roundId === roundId) ?? null
}

function getRoundAnchorSections(container: HTMLElement): HTMLElement[] {
  const anchors = Array.from(
    container.querySelectorAll<HTMLElement>('[data-round-anchor="true"][data-round-id]')
  )
  if (anchors.length > 0) return anchors
  return Array.from(container.querySelectorAll<HTMLElement>('[data-round-id]'))
}

function getContainerRelativeTop(container: HTMLElement, target: HTMLElement): number {
  const containerRect = container.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  return container.scrollTop + targetRect.top - containerRect.top
}

export function useTimelineScrollController({
  sessionId,
  ready,
  contentVersion,
  metricsVersion = contentVersion,
  mirrorVersion,
  isStreaming,
  bottomAreaRef,
  composerRef
}: UseTimelineScrollControllerOptions): UseTimelineScrollControllerResult {
  const clearScreenBottomInsetRef = useRef(0)
  const timelineContentRef = useRef<HTMLDivElement | null>(null)
  const pendingRoundScrollRef = useRef<PendingRoundScroll | null>(null)
  const activeRoundIdRef = useRef<string | null>(null)
  const suppressActiveRoundFromScrollRef = useRef(false)
  const [timelineViewportHeight, setTimelineViewportHeight] = useState(0)
  const [timelineContentHeight, setTimelineContentHeight] = useState(0)
  const [activeRoundOffsetTop, setActiveRoundOffsetTop] = useState(0)
  const [activeRoundId, setActiveRoundIdState] = useState<string | null>(null)
  const [clearScreenRequestVersion, setClearScreenRequestVersion] = useState(0)

  const smartScroll = useSessionSmartScroll({
    sessionId,
    ready,
    contentVersion,
    mirrorVersion,
    isStreaming,
    bottomAreaRef,
    composerRef,
    clearScreenBottomInsetRef
  })
  const {
    scrollContainerRef,
    showScrollFab,
    scrollFabCount,
    scrollFabBottomOffset,
    bottomFloatingHeight,
    handleScroll,
    handleScrollWheel,
    handleScrollPointerDown,
    handleScrollPointerUp,
    handleScrollPointerCancel,
    handleScrollToBottomClick,
    scrollToOffset
  } = smartScroll

  const setActiveRoundId = useCallback((roundId: string | null) => {
    activeRoundIdRef.current = roundId
    setActiveRoundIdState((current) => (current === roundId ? current : roundId))
  }, [])

  const requestClearScreenScroll = useCallback((roundId: string) => {
    pendingRoundScrollRef.current = { type: 'clear-screen', roundId }
    suppressActiveRoundFromScrollRef.current = true
    setActiveRoundId(roundId)
    setClearScreenRequestVersion((current) => current + 1)
  }, [setActiveRoundId])

  const scrollToRound = useCallback(
    (roundId: string, options?: { behavior?: ScrollBehavior; topPadding?: number }) => {
      const container = scrollContainerRef.current
      if (!container) return

      const section = findRoundSection(container, roundId)
      if (!section) return

      setActiveRoundId(roundId)
      suppressActiveRoundFromScrollRef.current = true
      const targetTop = Math.max(
        getContainerRelativeTop(container, section) - (options?.topPadding ?? 24),
        0
      )
      scrollToOffset(targetTop, options?.behavior ?? 'smooth')
    },
    [scrollContainerRef, scrollToOffset, setActiveRoundId]
  )

  useEffect(() => {
    pendingRoundScrollRef.current = null
    setActiveRoundId(null)
  }, [sessionId, setActiveRoundId])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const getRoundIds = (): string[] =>
      getRoundAnchorSections(container)
        .map((section) => section.dataset.roundId)
        .filter((roundId): roundId is string => !!roundId)

    const setLastRoundIfNeeded = (): void => {
      const roundIds = getRoundIds()
      if (roundIds.length === 0) {
        setActiveRoundId(null)
        return
      }

      const current = activeRoundIdRef.current
      const lastRoundId = roundIds[roundIds.length - 1]
      if (isStreaming || !current || !roundIds.includes(current)) {
        setActiveRoundId(lastRoundId)
      }
    }

    const updateActiveRoundFromScroll = (): void => {
      if (pendingRoundScrollRef.current) return
      if (isStreaming) return
      if (suppressActiveRoundFromScrollRef.current) {
        suppressActiveRoundFromScrollRef.current = false
        return
      }

      const sections = getRoundAnchorSections(container)
      if (sections.length === 0) {
        setActiveRoundId(null)
        return
      }

      const containerRect = container.getBoundingClientRect()
      const targetY = containerRect.top + Math.min(container.clientHeight * 0.28, 180)
      let bestId: string | null = null
      let bestDistance = Number.POSITIVE_INFINITY

      for (const section of sections) {
        const rect = section.getBoundingClientRect()
        const distance = Math.abs(rect.top - targetY)
        if (distance < bestDistance) {
          bestDistance = distance
          bestId = section.dataset.roundId ?? null
        }
      }

      if (bestId) {
        setActiveRoundId(bestId)
      }
    }

    setLastRoundIfNeeded()
    updateActiveRoundFromScroll()
    container.addEventListener('scroll', updateActiveRoundFromScroll, { passive: true })
    return () => container.removeEventListener('scroll', updateActiveRoundFromScroll)
  }, [isStreaming, metricsVersion, scrollContainerRef, setActiveRoundId])

  useLayoutEffect(() => {
    const scrollElement = scrollContainerRef.current
    const contentElement = timelineContentRef.current
    if (!scrollElement || !contentElement) return

    let frame: number | null = null
    const updateMetrics = (): void => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }

      frame = requestAnimationFrame(() => {
        frame = null
        const contentRect = contentElement.getBoundingClientRect()
        const spacerElement = contentElement.querySelector<HTMLElement>(
          CLEAR_SCREEN_SPACER_SELECTOR
        )
        const spacerHeight = spacerElement
          ? Math.round(spacerElement.getBoundingClientRect().height)
          : 0
        const activeRoundElement = findRoundSection(contentElement, activeRoundId ?? '')

        setTimelineViewportHeight(Math.round(scrollElement.clientHeight))
        setTimelineContentHeight(Math.max(0, Math.round(contentRect.height) - spacerHeight))
        setActiveRoundOffsetTop(
          activeRoundElement
            ? Math.max(
                0,
                Math.round(activeRoundElement.getBoundingClientRect().top - contentRect.top)
              )
            : 0
        )
      })
    }

    updateMetrics()

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        if (frame !== null) {
          cancelAnimationFrame(frame)
        }
      }
    }

    const observer = new ResizeObserver(updateMetrics)
    observer.observe(scrollElement)
    observer.observe(contentElement)
    return () => {
      observer.disconnect()
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [activeRoundId, metricsVersion, scrollContainerRef])

  const safeBottomPadding = getTimelineSafeBottomPadding(bottomFloatingHeight)
  const clearScreenBottomInset =
    timelineViewportHeight > 0 && timelineContentHeight > 0
      ? getClearScreenBottomInset({
          viewportHeight: timelineViewportHeight,
          contentHeight: timelineContentHeight,
          activeRoundOffsetTop,
          safeBottomPadding
        })
      : 0

  useEffect(() => {
    clearScreenBottomInsetRef.current = clearScreenBottomInset
  }, [clearScreenBottomInset])

  useLayoutEffect(() => {
    const pendingScroll = pendingRoundScrollRef.current
    const container = scrollContainerRef.current
    if (pendingScroll?.type !== 'clear-screen' || !container) return

    const roundElement = findRoundSection(container, pendingScroll.roundId)
    if (!roundElement) return

    const targetTop = getContainerRelativeTop(container, roundElement)
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
    if (targetTop > maxScrollTop && clearScreenBottomInset <= 0) return

    scrollToOffset(targetTop, 'instant')
    pendingRoundScrollRef.current = null
  }, [
    activeRoundId,
    clearScreenBottomInset,
    clearScreenRequestVersion,
    contentVersion,
    scrollContainerRef,
    scrollToOffset
  ])

  return {
    scrollContainerRef,
    timelineContentRef,
    showScrollFab,
    scrollFabCount,
    scrollFabBottomOffset,
    bottomFloatingHeight,
    clearScreenBottomInset,
    activeRoundId,
    handleScroll,
    handleScrollWheel,
    handleScrollPointerDown,
    handleScrollPointerUp,
    handleScrollPointerCancel,
    handleScrollToBottomClick,
    scrollToOffset,
    scrollToRound,
    requestClearScreenScroll
  }
}
