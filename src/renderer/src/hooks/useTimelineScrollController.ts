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

/**
 * Scroll mode state machine.
 *
 * - 'history': user is browsing past messages; program does not take over scroll
 * - 'sticky-bottom': normal pinned-to-bottom for streaming / idle follow
 * - 'round-focus': new turn just sent; user message pinned to viewport top
 *                   with tail filler providing scrollable space
 */
export type TimelineScrollMode = 'history' | 'sticky-bottom' | 'round-focus'

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
  scrollMode: TimelineScrollMode
  showScrollFab: boolean
  scrollFabCount: number
  scrollFabBottomOffset: number
  bottomFloatingHeight: number
  focusFillerHeight: number
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

/**
 * Compute the filler height needed to make `roundTop` a valid scrollTop.
 *
 * fillerHeight = max(0, viewportHeight - topGap - safeBottomPadding - heightFromRoundTopToEnd)
 *
 * The filler sits at the tail of the content and shrinks as real content grows.
 */
function computeFocusFillerHeight(
  viewportHeight: number,
  topGap: number,
  safeBottomPadding: number,
  roundOffsetTop: number,
  realContentHeight: number
): number {
  if (viewportHeight <= 0) return 0
  const heightFromRoundToEnd = realContentHeight - roundOffsetTop
  return Math.max(0, Math.round(viewportHeight - topGap - safeBottomPadding - heightFromRoundToEnd))
}

const ROUND_FOCUS_TOP_GAP = 24

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
  const timelineContentRef = useRef<HTMLDivElement | null>(null)
  const pendingRoundScrollRef = useRef<PendingRoundScroll | null>(null)
  const activeRoundIdRef = useRef<string | null>(null)
  const suppressActiveRoundFromScrollRef = useRef(false)

  // ── Scroll mode state machine ─────────────────────────────────────
  const scrollModeRef = useRef<TimelineScrollMode>('sticky-bottom')
  const [scrollMode, setScrollMode] = useState<TimelineScrollMode>('sticky-bottom')

  const setMode = useCallback((mode: TimelineScrollMode): void => {
    if (scrollModeRef.current !== mode) {
      scrollModeRef.current = mode
      setScrollMode(mode)
    }
  }, [])

  // Round-focus target
  const focusRoundIdRef = useRef<string | null>(null)
  const [focusRoundId, setFocusRoundIdState] = useState<string | null>(null)
  const [focusRequestVersion, setFocusRequestVersion] = useState(0)

  // Fillers
  const focusFillerHeightRef = useRef(0)
  const [focusFillerHeight, setFocusFillerHeight] = useState(0)

  // Metrics
  const [timelineViewportHeight, setTimelineViewportHeight] = useState(0)
  const [realContentHeight, setRealContentHeight] = useState(0)
  const [focusRoundOffsetTop, setFocusRoundOffsetTop] = useState(0)
  const [activeRoundId, setActiveRoundIdState] = useState<string | null>(null)
  const [activeRoundOffsetTop, setActiveRoundOffsetTop] = useState(0)

  // Manual scroll lock: once user scrolls during round-focus, we don't re-enter
  const manualScrollLockedRef = useRef(false)

  const smartScroll = useSessionSmartScroll({
    sessionId,
    ready,
    contentVersion,
    mirrorVersion,
    isStreaming,
    bottomAreaRef,
    composerRef,
    // Pass a ref that smart-scroll reads for bottom-distance calculations.
    // During round-focus this is non-zero so distanceToContentEnd excludes filler.
    focusFillerHeightRef,
    // Smart-scroll checks this to skip auto-scroll during round-focus
    scrollModeRef,
    // Smart-scroll reads this to know if user manually intervened
    manualScrollLockedRef
  })

  const {
    scrollContainerRef,
    showScrollFab,
    scrollFabCount,
    scrollFabBottomOffset,
    bottomFloatingHeight,
    handleScroll,
    handleScrollPointerUp,
    handleScrollPointerCancel,
    handleScrollToBottomClick,
    scrollToOffset,
    cancelPendingScrollToBottom,
    cancelPendingRestoreScroll
  } = smartScroll

  // ── Focus round management ────────────────────────────────────────

  const setFocusRoundId = useCallback((roundId: string | null): void => {
    focusRoundIdRef.current = roundId
    setFocusRoundIdState(roundId)
  }, [])

  const setActiveRoundId = useCallback((roundId: string | null): void => {
    activeRoundIdRef.current = roundId
    setActiveRoundIdState((current) => (current === roundId ? current : roundId))
  }, [])

  // ── Manual scroll intent ──────────────────────────────────────────
  // On any manual scroll intent, transition to history mode.
  // Do NOT delete filler immediately — let it remain as layout affordance.
  // It will shrink naturally as content grows, or be replaced on next round.

  const handleScrollWheel = useCallback(() => {
    smartScroll.handleScrollWheel()
    if (scrollModeRef.current === 'round-focus') {
      manualScrollLockedRef.current = true
      setMode('history')
    }
  }, [smartScroll, setMode])

  const handleScrollPointerDown = useCallback(() => {
    smartScroll.handleScrollPointerDown()
    if (scrollModeRef.current === 'round-focus') {
      manualScrollLockedRef.current = true
      setMode('history')
    }
  }, [smartScroll, setMode])

  // ── Request round-focus scroll ────────────────────────────────────

  const requestClearScreenScroll = useCallback((roundId: string) => {
    pendingRoundScrollRef.current = { type: 'clear-screen', roundId }
    suppressActiveRoundFromScrollRef.current = true
    manualScrollLockedRef.current = false
    setFocusRoundId(roundId)
    setActiveRoundId(roundId)
    setMode('round-focus')
    cancelPendingScrollToBottom()
    cancelPendingRestoreScroll()
    setFocusRequestVersion((v) => v + 1)
  }, [cancelPendingRestoreScroll, cancelPendingScrollToBottom, setActiveRoundId, setFocusRoundId, setMode])

  const scrollToRound = useCallback(
    (roundId: string, options?: { behavior?: ScrollBehavior; topPadding?: number }) => {
      const container = scrollContainerRef.current
      if (!container) return

      const section = findRoundSection(container, roundId)
      if (!section) return

      setActiveRoundId(roundId)
      suppressActiveRoundFromScrollRef.current = true
      const targetTop = Math.max(
        getContainerRelativeTop(container, section) - (options?.topPadding ?? ROUND_FOCUS_TOP_GAP),
        0
      )
      scrollToOffset(targetTop, options?.behavior ?? 'smooth')
    },
    [scrollContainerRef, scrollToOffset, setActiveRoundId]
  )

  // ── Session switch reset ──────────────────────────────────────────

  useEffect(() => {
    pendingRoundScrollRef.current = null
    manualScrollLockedRef.current = false
    setFocusRoundId(null)
    setMode('sticky-bottom')
    setActiveRoundId(null)
  }, [sessionId, setActiveRoundId, setFocusRoundId, setMode])

  // ── Track active round from scroll position ───────────────────────

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

  // ── Metrics: viewport, content height, round offsets ──────────────

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
        const focusElement = focusRoundIdRef.current
          ? findRoundSection(contentElement, focusRoundIdRef.current)
          : null

        const vpHeight = Math.round(scrollElement.clientHeight)
        const rcHeight = Math.max(0, Math.round(contentRect.height) - spacerHeight)
        const activeOffset = activeRoundElement
          ? Math.max(0, Math.round(activeRoundElement.getBoundingClientRect().top - contentRect.top))
          : 0
        const focusOffset = focusElement
          ? Math.max(0, Math.round(focusElement.getBoundingClientRect().top - contentRect.top))
          : 0

        setTimelineViewportHeight(vpHeight)
        setRealContentHeight(rcHeight)
        setActiveRoundOffsetTop(activeOffset)
        setFocusRoundOffsetTop(focusOffset)

        // Recompute filler when in round-focus mode
        if (scrollModeRef.current === 'round-focus' && focusElement) {
          const safeBottom = getTimelineSafeBottomPadding(bottomFloatingHeight)
          const filler = computeFocusFillerHeight(
            vpHeight,
            ROUND_FOCUS_TOP_GAP,
            safeBottom,
            focusOffset,
            rcHeight
          )
          focusFillerHeightRef.current = filler
          setFocusFillerHeight(filler)
        }
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
  }, [activeRoundId, bottomFloatingHeight, focusRoundId, metricsVersion, scrollContainerRef])

  // ── Attempt pending round-focus scroll ────────────────────────────

  const attemptPendingFocusScroll = useCallback((): boolean => {
    const pendingScroll = pendingRoundScrollRef.current
    const container = scrollContainerRef.current
    if (pendingScroll?.type !== 'clear-screen' || !container) return false

    const roundElement = findRoundSection(container, pendingScroll.roundId)
    if (!roundElement) return false

    const targetTop = Math.max(
      getContainerRelativeTop(container, roundElement) - ROUND_FOCUS_TOP_GAP,
      0
    )
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
    if (targetTop > maxScrollTop) return false

    scrollToOffset(targetTop, 'smooth')
    pendingRoundScrollRef.current = null
    return true
  }, [scrollContainerRef, scrollToOffset])

  useLayoutEffect(() => {
    attemptPendingFocusScroll()
  }, [
    activeRoundId,
    attemptPendingFocusScroll,
    focusRequestVersion,
    contentVersion
  ])

  // Retry pending scroll when DOM might not have the round yet
  useEffect(() => {
    if (pendingRoundScrollRef.current?.type !== 'clear-screen') return

    let frame: number | null = null
    let retries = 0
    const maxRetries = 10
    const retry = (): void => {
      frame = null
      if (!attemptPendingFocusScroll() && retries < maxRetries) {
        retries++
        frame = requestAnimationFrame(retry)
      }
    }
    frame = requestAnimationFrame(retry)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [attemptPendingFocusScroll, focusRequestVersion])

  // ── Round-focus completion conditions ─────────────────────────────
  // Transition out of round-focus when:
  // 1. filler === 0 && !manualScrollLocked → sticky-bottom
  // 2. manualScrollIntent → history (handled in wheel/pointerDown)
  // 3. new round request → replace active round (handled in requestClearScreenScroll)

  useEffect(() => {
    if (scrollModeRef.current !== 'round-focus') return
    if (manualScrollLockedRef.current) return

    if (focusFillerHeight <= 0) {
      setMode('sticky-bottom')
    }
  }, [focusFillerHeight, setMode])

  return {
    scrollContainerRef,
    timelineContentRef,
    scrollMode,
    showScrollFab,
    scrollFabCount,
    scrollFabBottomOffset,
    bottomFloatingHeight,
    focusFillerHeight,
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
