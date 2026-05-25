import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  getSessionViewState,
  updateSessionViewState,
  type SessionViewState
} from '@/lib/session-view-registry'

const BOTTOM_AREA_COMPENSATE_THRESHOLD = 96
const DEFAULT_SCROLL_FAB_OFFSET = 16
const MIN_NEAR_BOTTOM_THRESHOLD = 80

interface UseSessionSmartScrollOptions {
  sessionId: string
  ready: boolean
  contentVersion: number
  mirrorVersion: number
  isStreaming: boolean
  bottomAreaRef?: React.RefObject<HTMLElement | null>
  composerRef?: React.RefObject<HTMLElement | null>
  clearScreenActive?: boolean
}

interface UseSessionSmartScrollResult {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  showScrollFab: boolean
  scrollFabCount: number
  scrollFabBottomOffset: number
  bottomFloatingHeight: number
  clearScreenBottomInset: number
  handleScroll: () => void
  handleScrollWheel: () => void
  handleScrollPointerDown: () => void
  handleScrollPointerUp: () => void
  handleScrollPointerCancel: () => void
  handleScrollToBottomClick: () => void
  scrollToOffset: (top: number, behavior?: ScrollBehavior) => void
}

function getDistanceFromBottom(element: HTMLDivElement, bottomInset = 0): number {
  return element.scrollHeight - bottomInset - element.scrollTop - element.clientHeight
}

function getBottomScrollTop(element: HTMLDivElement, bottomInset = 0): number {
  return Math.max(0, element.scrollHeight - element.clientHeight - bottomInset)
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
  clearScreenActive = false
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
  // 用 ref 跟踪 isStreaming，避免 ResizeObserver 的 effect 因为流式状态切换
  // 反复 disconnect / re-observe（composer + dock + scroller 三处 observer）。
  const isStreamingRef = useRef(isStreaming)
  const [dockHeight, setDockHeight] = useState(0)
  const [composerHeight, setComposerHeight] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [viewState, setViewState] = useState<SessionViewState>(() =>
    getSessionViewState(sessionId, mirrorVersion)
  )
  const viewStateRef = useRef(viewState)
  // v2 修复：此前 clearScreenActive=true 时会注入"视口高度 - 96px"的底部
  // 空白（最少 240px），等价于把整屏推到视图外。流式输出落进这片空白后
  // 就消失在 composer 下面，FAB 也不会亮起来。详见
  // docs/session-hq-design.md §8.2 / §9.1。
  //
  // 现在保留 clearScreenActive 这个 prop 以维持 API 兼容（SessionShell 内
  // 部仍在 setState），但不再把它翻译成底部 padding。如果将来要重新实现
  // "Clear Screen"，应通过 transcript 视觉分隔（灰色分割线 / 渐隐遮罩），
  // 而不是注入物理空白。
  void clearScreenActive
  void viewportHeight
  const clearScreenBottomInset = 0

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
        options?.forceStickyBottom ??
        getDistanceFromBottom(element, clearScreenBottomInset) < getNearBottomThreshold()
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
    [clearScreenBottomInset, mirrorVersion, writeViewState]
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
      scrollElementTo(element, getBottomScrollTop(element, clearScreenBottomInset), behavior)

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
    [
      clearScreenBottomInset,
      isStreaming,
      markProgrammaticScroll,
      mirrorVersion,
      persistCurrentAnchor
    ]
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

    const distanceFromBottom = getDistanceFromBottom(element, clearScreenBottomInset)
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
  }, [clearScreenBottomInset, mirrorVersion, writeViewState])

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

  // v2 流式硬贴底 + 闲时自动跟随。
  //
  // 流式输出阶段（isStreaming=true）：只要用户没有显式锁定（manualScrollLocked
  // 为 false），就忽略缓存的 stickyBottom 标记（可能因为渲染节流而落后一帧），
  // 改用实际距离判断。阈值放宽到 3× 平时阈值——这样即便用户因为新内容跳动
  // 而短暂偏离 1-2 行，也能继续被"拽"到底部，杜绝"输出跑到 composer 下面"。
  //
  // 非流式阶段：恢复旧行为，只有 viewState.stickyBottom=true 时才追随，
  // 避免用户翻历史时被强制拽回。
  //
  // 与 clearScreenActive 解耦：v1 这里有 clearScreenActive 的早退，会导致
  // 流式输出期间一旦 clearScreenActive=true 就完全停止跟随。新的设计是
  // 流式状态优先级高于一切 transcript 装饰。详见 §9.2。
  useEffect(() => {
    if (!ready || !hasRestoredInitialAnchorRef.current) return

    const element = scrollContainerRef.current
    if (!element) return

    if (isStreaming) {
      if (viewStateRef.current.manualScrollLocked) return
      const distance = getDistanceFromBottom(element, 0)
      const streamingThreshold = getNearBottomThreshold() * 3
      if (distance < streamingThreshold) {
        scrollToBottom('instant')
      }
      return
    }

    if (!viewStateRef.current.stickyBottom) return
    scrollToBottom()
  }, [contentVersion, isStreaming, mirrorVersion, ready, scrollToBottom])

  // Use useLayoutEffect for the initial sync measurement so the first paint
  // already has the correct padding-bottom — otherwise the first frame leaves
  // the last transcript node hidden behind the ComposerBar.
  useLayoutEffect(() => {
    const dockElement = bottomAreaRef?.current
    const composerElement = composerRef?.current
    const scrollElement = scrollContainerRef.current
    setViewportHeight(scrollElement?.clientHeight ?? 0)
    setDockHeight(dockElement?.getBoundingClientRect().height ?? 0)
    setComposerHeight(composerElement?.getBoundingClientRect().height ?? 0)
  }, [bottomAreaRef, composerRef])

  useEffect(() => {
    const dockElement = bottomAreaRef?.current
    const composerElement = composerRef?.current
    const scrollElement = scrollContainerRef.current
    setViewportHeight(scrollElement?.clientHeight ?? 0)
    setDockHeight(dockElement?.getBoundingClientRect().height ?? 0)
    setComposerHeight(composerElement?.getBoundingClientRect().height ?? 0)

    if (typeof ResizeObserver === 'undefined') return

    const observers: ResizeObserver[] = []
    const handleResize = () => {
      const scrollElement = scrollContainerRef.current
      if (!scrollElement) return
      if (clearScreenActive) return

      const distanceFromBottom = getDistanceFromBottom(scrollElement, clearScreenBottomInset)
      // 流式期间：composer 增高会让 row-1（transcript scroller）缩小，已存在的
      // 内容会从底部滑出视口，看起来像"输出跑到 composer 下面"。这时只要用户
      // 没显式锁定滚动，就一律把最后一行拽回底部——与 streaming auto-follow
      // effect (L373-391) 的判断口径保持一致，避免两条 path 阈值不一致导致
      // 漏补偿。非流式期间维持原来的 96px 阈值，避免翻历史时被强制拽回。
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
      [scrollElement, setViewportHeight],
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
    clearScreenActive,
    clearScreenBottomInset,
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
    }
  }, [persistCurrentAnchor, resetInteractionState])

  const scrollFabCount = Math.max(0, mirrorVersion - viewState.lastSeenVersion)
  const showScrollFab = !viewState.stickyBottom && scrollFabCount > 0

  const scrollFabBottomOffset = useMemo(() => {
    const bottomChromeHeight = dockHeight + composerHeight
    return bottomChromeHeight > 0 ? bottomChromeHeight + 32 : DEFAULT_SCROLL_FAB_OFFSET
  }, [composerHeight, dockHeight])

  return {
    scrollContainerRef,
    showScrollFab,
    scrollFabCount,
    scrollFabBottomOffset,
    clearScreenBottomInset,
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
    handleScrollToBottomClick,
    scrollToOffset
  }
}
