import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

interface RoundNavigatorItem {
  id: string
  index: number
  preview: string
}

interface RoundNavigatorProps {
  rounds: RoundNavigatorItem[]
  activeRoundId?: string | null
  bottomReadableInset?: number
  scrollContainerRef?: React.RefObject<HTMLElement | null>
  onRoundAnchorNavigate?: (roundId: string) => void
}

interface NavigatorMetrics {
  containerHeight: number
}

interface MarkerItem {
  item: RoundNavigatorItem
}

interface NavigatorSlot {
  item: RoundNavigatorItem
  order: number
}

const MIN_WINDOW_PREVIEW_ROWS = 9
const MAX_WINDOW_PREVIEW_ROWS = 18
const DEFAULT_CONTAINER_HEIGHT = 720
const TOP_GUARD = 88
const BOTTOM_GUARD = 44
const NAVIGATOR_GUTTER_LEFT = 'calc(90% + 34px)'
const NAVIGATOR_RAIL_WIDTH = 38
const NAVIGATOR_EXPANDED_WIDTH = 348
const DEFAULT_EXPANDED_ROW_HEIGHT = 40
const MIN_FULL_ROW_HEIGHT = 16
const EXPANDED_VERTICAL_PADDING = 6
const COLLAPSED_SLOT_HEIGHT = 20
const MIN_OVERVIEW_ROW_HEIGHT = 8
const MAX_OVERVIEW_ROW_HEIGHT = 14
const CLOSE_DELAY_MS = 140

function truncatePreview(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function clampIndex(index: number, max: number): number {
  return clamp(index, 0, max)
}

function getPreviewWindowItems(
  rounds: RoundNavigatorItem[],
  focusIndex: number,
  fullPreviewCapacity: number,
  windowLimit: number
): RoundNavigatorItem[] {
  if (rounds.length === 0) return []
  if (rounds.length <= fullPreviewCapacity) return rounds

  const visibleCount = Math.min(windowLimit, rounds.length)
  const safeFocusIndex = clampIndex(focusIndex, rounds.length - 1)
  const half = Math.floor(visibleCount / 2)
  const start = clampIndex(safeFocusIndex - half, rounds.length - visibleCount)

  return rounds.slice(start, start + visibleCount)
}

function getMarkerItems(
  rounds: RoundNavigatorItem[],
  activeIndex: number,
  markerCapacity: number
): MarkerItem[] {
  if (rounds.length === 0) return []

  const selected = new Map<number, RoundNavigatorItem>()
  const add = (index: number): void => {
    const item = rounds[index]
    if (item) selected.set(index, item)
  }

  if (rounds.length <= markerCapacity) {
    rounds.forEach((item) => selected.set(item.index, item))
  } else {
    const step = Math.ceil(rounds.length / markerCapacity)
    for (let index = 0; index < rounds.length; index += step) {
      add(index)
    }
    add(0)
    add(rounds.length - 1)
    add(activeIndex)
  }

  return Array.from(selected.values())
    .sort((left, right) => left.index - right.index)
    .map((item) => ({ item }))
}

function getAnchoredStackTop(
  railHeight: number,
  stackHeight: number,
  rowHeight: number,
  focusRowIndex: number
): number {
  const focusedRowTop = railHeight / 2 - EXPANDED_VERTICAL_PADDING - rowHeight / 2
  const idealTop = focusedRowTop - focusRowIndex * rowHeight
  return clamp(idealTop, 0, Math.max(0, railHeight - stackHeight))
}

function measureNavigatorMetrics(scrollContainer: HTMLElement | null): NavigatorMetrics {
  if (!scrollContainer) {
    return { containerHeight: DEFAULT_CONTAINER_HEIGHT }
  }

  const containerRect = scrollContainer.getBoundingClientRect()
  const containerHeight =
    scrollContainer.clientHeight ||
    containerRect.height ||
    window.innerHeight ||
    DEFAULT_CONTAINER_HEIGHT

  return { containerHeight }
}

export function RoundNavigator({
  rounds,
  activeRoundId,
  bottomReadableInset = 72,
  scrollContainerRef,
  onRoundAnchorNavigate
}: RoundNavigatorProps): React.JSX.Element | null {
  const [isOpen, setIsOpen] = useState(false)
  const [focusIndex, setFocusIndex] = useState(rounds.length - 1)
  const [metrics, setMetrics] = useState<NavigatorMetrics>({
    containerHeight: DEFAULT_CONTAINER_HEIGHT
  })
  const closeTimerRef = useRef<number | null>(null)

  const activeIndex = useMemo(() => {
    if (activeRoundId) {
      const idx = rounds.findIndex((round) => round.id === activeRoundId)
      if (idx >= 0) return idx
    }
    return Math.max(0, rounds.length - 1)
  }, [activeRoundId, rounds])

  useEffect(() => {
    setFocusIndex((current) => (isOpen ? clampIndex(current, rounds.length - 1) : activeIndex))
  }, [activeIndex, isOpen, rounds.length])

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const container = scrollContainerRef?.current

    const update = (): void => {
      setMetrics(measureNavigatorMetrics(container ?? null))
    }

    update()

    if (!container) return

    let frameId: number | null = null
    const scheduleUpdate = (): void => {
      if (frameId !== null) return
      frameId = window.requestAnimationFrame(() => {
        frameId = null
        update()
      })
    }

    container.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', scheduleUpdate)

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(scheduleUpdate)
      resizeObserver.observe(container)
    }

    return () => {
      container.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
      resizeObserver?.disconnect()
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId)
      }
    }
  }, [scrollContainerRef, rounds.length])

  const railHeight = useMemo(
    () => Math.max(180, metrics.containerHeight - bottomReadableInset - TOP_GUARD - BOTTOM_GUARD),
    [bottomReadableInset, metrics.containerHeight]
  )

  const fullPreviewCapacity = Math.max(
    MIN_WINDOW_PREVIEW_ROWS,
    Math.floor((railHeight - EXPANDED_VERTICAL_PADDING * 2) / MIN_FULL_ROW_HEIGHT)
  )
  const windowPreviewLimit = clamp(
    Math.floor(fullPreviewCapacity * 0.34),
    MIN_WINDOW_PREVIEW_ROWS,
    MAX_WINDOW_PREVIEW_ROWS
  )
  const markerItems = useMemo(
    () => getMarkerItems(rounds, activeIndex, fullPreviewCapacity),
    [activeIndex, fullPreviewCapacity, rounds]
  )
  const previewItems = useMemo(
    () => getPreviewWindowItems(rounds, focusIndex, fullPreviewCapacity, windowPreviewLimit),
    [focusIndex, fullPreviewCapacity, rounds, windowPreviewLimit]
  )
  const showFullPreview = rounds.length <= fullPreviewCapacity

  const expandedRowHeight = showFullPreview
    ? clamp(
        Math.floor((railHeight - EXPANDED_VERTICAL_PADDING * 2) / Math.max(previewItems.length, 1)),
        MIN_FULL_ROW_HEIGHT,
        DEFAULT_EXPANDED_ROW_HEIGHT
      )
    : DEFAULT_EXPANDED_ROW_HEIGHT
  const expandedHeight = Math.min(
    railHeight,
    previewItems.length * expandedRowHeight + EXPANDED_VERTICAL_PADDING * 2
  )
  const focusedPreviewIndex = Math.max(
    0,
    previewItems.findIndex((item) => item.index === focusIndex)
  )
  const expandedTop = getAnchoredStackTop(
    railHeight,
    expandedHeight,
    expandedRowHeight,
    showFullPreview ? 0 : focusedPreviewIndex
  )
  const overviewRowHeight = clamp(
    Math.floor((railHeight - EXPANDED_VERTICAL_PADDING * 2) / Math.max(markerItems.length, 1)),
    MIN_OVERVIEW_ROW_HEIGHT,
    MAX_OVERVIEW_ROW_HEIGHT
  )
  const overviewHeight = Math.min(
    railHeight,
    markerItems.length > 0
      ? (markerItems.length - 1) * overviewRowHeight +
          COLLAPSED_SLOT_HEIGHT +
          EXPANDED_VERTICAL_PADDING * 2
      : 0
  )
  const overviewTop = getAnchoredStackTop(railHeight, overviewHeight, overviewRowHeight, 0)
  const surfaceTop = isOpen || showFullPreview ? expandedTop : overviewTop
  const surfaceHeight = isOpen || showFullPreview ? expandedHeight : overviewHeight
  const slotRowHeight = isOpen || showFullPreview ? expandedRowHeight : overviewRowHeight

  const visibleSlots = useMemo<NavigatorSlot[]>(() => {
    if (isOpen || showFullPreview) {
      return previewItems.map((item, order) => ({
        item,
        order
      }))
    }

    return markerItems.map(({ item }, order) => ({
      item,
      order
    }))
  }, [isOpen, markerItems, previewItems, showFullPreview])

  const openPreview = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    setIsOpen(true)
  }, [])

  const closePreview = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
    }
    closeTimerRef.current = window.setTimeout(() => {
      setIsOpen(false)
      setFocusIndex(activeIndex)
      closeTimerRef.current = null
    }, CLOSE_DELAY_MS)
  }, [activeIndex])

  const handleNavigate = useCallback(
    (roundId: string) => {
      onRoundAnchorNavigate?.(roundId)
    },
    [onRoundAnchorNavigate]
  )

  const handleWheel = useCallback((event: React.WheelEvent) => {
    event.stopPropagation()
  }, [])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (closeTimerRef.current !== null) {
          window.clearTimeout(closeTimerRef.current)
          closeTimerRef.current = null
        }
        setIsOpen(false)
        setFocusIndex(activeIndex)
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setFocusIndex((prev) => clampIndex(prev - 1, rounds.length - 1))
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setFocusIndex((prev) => clampIndex(prev + 1, rounds.length - 1))
        return
      }

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const item = rounds[focusIndex]
        if (item) handleNavigate(item.id)
      }
    },
    [activeIndex, focusIndex, handleNavigate, rounds]
  )

  if (rounds.length <= 1) return null

  return (
    <div
      className="pointer-events-none sticky top-0 z-30 h-0"
      data-testid="round-navigator-layer"
      aria-hidden={rounds.length <= 1}
    >
      <div
        className="absolute pointer-events-none outline-none"
        data-testid="round-navigator"
        data-state={isOpen ? 'open' : 'closed'}
        role="navigation"
        aria-label="Round navigator"
        tabIndex={0}
        onFocus={openPreview}
        onBlur={(event) => {
          const nextTarget = event.relatedTarget
          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
          closePreview()
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        style={{
          top: `${TOP_GUARD}px`,
          left: NAVIGATOR_GUTTER_LEFT,
          height: `${railHeight}px`,
          width: isOpen ? `${NAVIGATOR_EXPANDED_WIDTH}px` : `${NAVIGATOR_RAIL_WIDTH}px`,
          transform: isOpen
            ? `translateX(-${NAVIGATOR_EXPANDED_WIDTH - NAVIGATOR_RAIL_WIDTH}px)`
            : 'translateX(0)',
          transformOrigin: 'right center',
          overflow: 'visible',
          transition:
            'width 180ms cubic-bezier(0.16, 1, 0.3, 1), transform 180ms cubic-bezier(0.16, 1, 0.3, 1)',
          willChange: isOpen ? 'width, transform' : undefined
        }}
      >
        <div
          className={cn(
            'absolute right-0 overflow-hidden',
            isOpen ? 'pointer-events-auto' : 'pointer-events-none'
          )}
          data-testid="round-navigator-track"
          role={isOpen ? 'listbox' : undefined}
          aria-label={isOpen ? 'Round list' : undefined}
          onMouseLeave={closePreview}
          onWheel={handleWheel}
          style={{
            top: `${surfaceTop}px`,
            height: `${surfaceHeight}px`,
            width: isOpen ? `${NAVIGATOR_EXPANDED_WIDTH}px` : `${NAVIGATOR_RAIL_WIDTH}px`,
            background: isOpen
              ? 'linear-gradient(180deg, color-mix(in srgb, var(--agent-canvas) 58%, transparent), color-mix(in srgb, var(--agent-canvas) 48%, transparent))'
              : 'transparent',
            backdropFilter: isOpen ? 'blur(36px) saturate(1.2)' : 'none',
            WebkitBackdropFilter: isOpen ? 'blur(36px) saturate(1.2)' : 'none',
            borderRadius: isOpen ? '10px 2px 2px 10px' : '0',
            boxShadow: isOpen
              ? 'inset 1px 0 0 color-mix(in srgb, var(--border) 36%, transparent), inset 0 1px 0 rgb(255 255 255 / 0.46), inset 0 -1px 0 color-mix(in srgb, var(--border) 24%, transparent), -18px 0 46px rgb(var(--agent-shadow-rgb) / 0.04), 0 24px 60px rgb(var(--agent-shadow-rgb) / 0.07)'
              : 'none',
            transition:
              'top 180ms cubic-bezier(0.16, 1, 0.3, 1), height 180ms cubic-bezier(0.16, 1, 0.3, 1), width 180ms cubic-bezier(0.16, 1, 0.3, 1), background 160ms ease-out, box-shadow 160ms ease-out, backdrop-filter 160ms ease-out',
            willChange: isOpen ? 'top, height, width, backdrop-filter' : undefined
          }}
        >
          {isOpen && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'radial-gradient(120% 90% at 74% 74%, color-mix(in srgb, var(--neon-mint-soft) 40%, transparent), transparent 58%), linear-gradient(90deg, color-mix(in srgb, var(--background) 20%, transparent), color-mix(in srgb, var(--agent-canvas) 44%, transparent))'
              }}
            />
          )}
          {visibleSlots.map(({ item, order }) => {
            const isActive = item.index === activeIndex
            const isFocused = item.index === focusIndex
            const slotTop =
              isOpen || showFullPreview
                ? EXPANDED_VERTICAL_PADDING + order * slotRowHeight
                : EXPANDED_VERTICAL_PADDING +
                  order * slotRowHeight +
                  slotRowHeight / 2 -
                  COLLAPSED_SLOT_HEIGHT / 2

            return (
              <button
                key={item.id}
                type="button"
                role={isOpen ? 'option' : undefined}
                aria-selected={isOpen ? isActive : undefined}
                aria-current={isActive ? 'step' : undefined}
                className={cn(
                  'absolute right-0 flex items-center text-left outline-none transition-[background-color,opacity] duration-100',
                  isOpen ? 'gap-3 rounded-none pl-4 pr-1.5' : 'justify-end rounded-full px-0'
                )}
                data-testid="round-navigator-marker"
                data-round-index={item.index}
                title={isOpen ? undefined : item.preview}
                onClick={(event) => {
                  event.stopPropagation()
                  handleNavigate(item.id)
                }}
                onMouseEnter={() => {
                  openPreview()
                  setFocusIndex(item.index)
                }}
                style={{
                  top: `${slotTop}px`,
                  height:
                    isOpen || showFullPreview
                      ? `${expandedRowHeight}px`
                      : `${COLLAPSED_SLOT_HEIGHT}px`,
                  width: isOpen ? '100%' : `${NAVIGATOR_RAIL_WIDTH}px`,
                  pointerEvents: 'auto',
                  opacity: isOpen
                    ? isActive
                      ? 1
                      : isFocused
                        ? 0.96
                        : 0.76
                    : isActive
                      ? 0.98
                      : 0.58,
                  background: isOpen
                    ? isActive
                      ? 'color-mix(in srgb, var(--neon-mint-soft) 36%, transparent)'
                      : isFocused
                        ? 'color-mix(in srgb, var(--agent-hover) 24%, transparent)'
                        : 'transparent'
                    : 'transparent'
                }}
              >
                {isOpen && (
                  <span
                    className="min-w-0 flex-1 truncate text-[12.5px] transition-colors duration-100"
                    data-testid="round-navigator-option-label"
                    style={{
                      lineHeight: `${Math.min(20, Math.max(14, expandedRowHeight - 2))}px`,
                      color: isFocused
                        ? 'color-mix(in srgb, var(--neon-mint) 82%, var(--foreground))'
                        : isActive
                          ? 'var(--foreground)'
                          : 'var(--muted-foreground)',
                      fontWeight: isFocused ? 600 : isActive ? 560 : 450
                    }}
                  >
                    {truncatePreview(item.preview, 22)}
                  </span>
                )}
                <span
                  aria-hidden="true"
                  data-testid={
                    isOpen ? 'round-navigator-option-line' : 'round-navigator-marker-line'
                  }
                  className={cn(
                    'shrink-0 rounded-full transition-[width,height,background-color] duration-150',
                    isOpen ? '' : 'mr-[7px]'
                  )}
                  style={{
                    width: isOpen
                      ? isActive
                        ? '20px'
                        : isFocused
                          ? '16px'
                          : '12px'
                      : isActive
                        ? '24px'
                        : isFocused
                          ? '20px'
                          : '13px',
                    height: isActive ? '3px' : '2px',
                    background: isActive
                      ? isOpen
                        ? 'color-mix(in srgb, var(--neon-mint) 74%, var(--foreground))'
                        : 'linear-gradient(to left, color-mix(in srgb, var(--neon-mint) 72%, var(--foreground)), color-mix(in srgb, var(--neon-mint) 30%, transparent))'
                      : isFocused
                        ? 'color-mix(in srgb, var(--muted-foreground) 52%, transparent)'
                        : 'color-mix(in srgb, var(--muted-foreground) 32%, transparent)'
                  }}
                />
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
