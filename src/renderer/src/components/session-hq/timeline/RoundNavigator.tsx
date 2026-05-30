import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'

interface RoundNavigatorItem {
  id: string
  index: number
  preview: string
}

interface RoundNavigatorProps {
  rounds: RoundNavigatorItem[]
  activeRoundId?: string | null
  scrollContainerRef?: React.RefObject<HTMLElement | null>
  onRoundAnchorNavigate?: (roundId: string) => void
}

const VISIBLE_ROWS = 10
const PREVIEW_MAX_CHARS = 10

function truncatePreview(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}

function clampIndex(index: number, max: number): number {
  return Math.max(0, Math.min(max, index))
}

function getWheelStart(focusIndex: number, roundCount: number): number {
  if (roundCount <= VISIBLE_ROWS) return 0
  const half = Math.floor(VISIBLE_ROWS / 2)
  return clampIndex(focusIndex - half, roundCount - VISIBLE_ROWS)
}

/**
 * Measure the viewport-center Y of the active round section.
 * Returns null if the element isn't found.
 */
function measureActiveRoundY(
  scrollContainer: HTMLElement | null,
  activeRoundId: string | null | undefined
): number | null {
  if (!scrollContainer || !activeRoundId) return null
  const el = scrollContainer.querySelector(`[data-round-id="${activeRoundId}"]`)
  if (!el) return null
  const containerRect = scrollContainer.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  return elRect.top - containerRect.top + elRect.height / 2
}

export function RoundNavigator({
  rounds,
  activeRoundId,
  scrollContainerRef,
  onRoundAnchorNavigate
}: RoundNavigatorProps): React.JSX.Element | null {
  const [isHovered, setIsHovered] = useState(false)
  const [focusIndex, setFocusIndex] = useState(rounds.length - 1)
  const [activeRoundY, setActiveRoundY] = useState<number | null>(null)
  const railRef = useRef<HTMLDivElement>(null)

  const activeIndex = useMemo(() => {
    if (activeRoundId) {
      const idx = rounds.findIndex((r) => r.id === activeRoundId)
      if (idx >= 0) return idx
    }
    return Math.max(0, rounds.length - 1)
  }, [activeRoundId, rounds])

  const isLatestFallback = !activeRoundId || !rounds.some((r) => r.id === activeRoundId)

  // Sync focus to active when not hovering
  useEffect(() => {
    if (!isHovered) setFocusIndex(activeIndex)
  }, [activeIndex, isHovered])

  // Measure active round Y for connector line
  useEffect(() => {
    const container = scrollContainerRef?.current
    if (!container) return

    const update = (): void => {
      setActiveRoundY(measureActiveRoundY(container, activeRoundId))
    }
    update()

    container.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      container.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [scrollContainerRef, activeRoundId])

  const wheelItems = useMemo(() => {
    const start = getWheelStart(focusIndex, rounds.length)
    return rounds.slice(start, start + VISIBLE_ROWS)
  }, [rounds, focusIndex])

  const handleClick = useCallback(
    (roundId: string) => {
      onRoundAnchorNavigate?.(roundId)
    },
    [onRoundAnchorNavigate]
  )

  const handleWheel = useCallback(
    (event: React.WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const delta = event.deltaY > 0 ? 1 : -1
      setFocusIndex((prev) => clampIndex(prev + delta, rounds.length - 1))
    },
    [rounds.length]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsHovered(false)
        setFocusIndex(activeIndex)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setFocusIndex((prev) => clampIndex(prev - 1, rounds.length - 1))
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setFocusIndex((prev) => clampIndex(prev + 1, rounds.length - 1))
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const item = rounds[focusIndex]
        if (item) handleClick(item.id)
      }
    },
    [activeIndex, rounds, focusIndex, handleClick]
  )

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false)
    setFocusIndex(activeIndex)
  }, [activeIndex])

  if (rounds.length <= 1) return null

  // Connector line Y: from active round center to rail center
  const connectorY = activeRoundY ?? null

  return (
    <>
      {/* Navigator — sticky in flex row, right of content */}
      <div
        ref={railRef}
        className="sticky top-1/2 z-20 hidden w-6 shrink-0 -translate-y-1/2 self-start lg:block"
        data-testid="round-navigator"
        onMouseEnter={() => setIsHovered(true)}
        onFocus={() => setIsHovered(true)}
        onMouseLeave={handleMouseLeave}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="navigation"
        aria-label="Round navigator"
      >
        {/* Connector line from active round to rail */}
        {connectorY !== null && (
          <div
            aria-hidden="true"
            className={cn(
              'absolute right-6 h-px transition-opacity duration-200',
              isHovered ? 'opacity-60' : 'opacity-0'
            )}
            style={{
              top: `${connectorY}px`,
              width: '32px',
              background: 'linear-gradient(to left, color-mix(in srgb, var(--foreground) 20%, transparent), transparent)'
            }}
          />
        )}

        {/* Hairline + markers column */}
        <div className="relative flex h-full flex-col items-end">
          {/* 1px vertical hairline — always visible, very faint */}
          <div
            aria-hidden="true"
            className="absolute right-[11px] top-4 bottom-4 w-px"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--muted-foreground) 12%, transparent)'
            }}
          />

          {/* Active knob — always visible */}
          <div
            className="absolute right-[7px]"
            style={{
              top: connectorY != null ? `${connectorY}px` : '50%',
              transform: 'translateY(-50%)'
            }}
          >
            <button
              type="button"
              onClick={() => {
                const item = rounds[activeIndex]
                if (item) handleClick(item.id)
              }}
              className="block h-[9px] w-[9px] rounded-full transition-all duration-150"
              style={{
                backgroundColor: isLatestFallback
                  ? 'color-mix(in srgb, var(--muted-foreground) 40%, transparent)'
                  : 'var(--foreground)',
                boxShadow: isLatestFallback
                  ? 'none'
                  : '0 0 8px color-mix(in srgb, var(--foreground) 10%, transparent)'
              }}
              title={rounds[activeIndex]?.preview}
              aria-current="step"
            />
          </div>

          {/* Neighbor dots — only on hover/focus, fade in */}
          {isHovered && (
            <div
              className="absolute right-[7px] flex flex-col items-center gap-1"
              style={{
                top: connectorY != null ? `${connectorY}px` : '50%',
                transform: 'translateY(-50%)',
                animation: 'round-navigator-neighbor-fade 120ms ease-out'
              }}
            >
              {rounds
                .filter((r) => Math.abs(r.index - activeIndex) <= 3 && r.index !== activeIndex)
                .map((item) => {
                  const distance = Math.abs(item.index - activeIndex)
                  const opacity = Math.max(0.15, 0.5 - distance * 0.12)

                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleClick(item.id)}
                      className="block rounded-full transition-all duration-100"
                      style={{
                        width: `${Math.max(3, 5 - distance)}px`,
                        height: `${Math.max(3, 5 - distance)}px`,
                        backgroundColor: 'color-mix(in srgb, var(--muted-foreground) 30%, transparent)',
                        opacity
                      }}
                      title={item.preview}
                    />
                  )
                })}
            </div>
          )}

          {/* Wheel overlay — expands leftward toward content */}
          {isHovered && (
            <div
              className="absolute right-full top-1/2 mr-3 -translate-y-1/2"
              style={{
                transformOrigin: 'right center',
                animation: 'round-navigator-wheel-open 160ms ease-out'
              }}
            >
              <div
                className="rounded-xl border py-1.5"
                style={{
                  backgroundColor: 'color-mix(in srgb, var(--agent-card) 92%, transparent)',
                  borderColor: 'color-mix(in srgb, var(--border) 80%, transparent)',
                  boxShadow: '0 4px 24px rgb(var(--agent-shadow-rgb) / 0.14), 0 1px 4px rgb(var(--agent-shadow-rgb) / 0.06)',
                  backdropFilter: 'blur(16px) saturate(1.05)'
                }}
                role="listbox"
                aria-label="Round list"
              >
                {wheelItems.map((item) => {
                  const isActive = item.index === activeIndex && !isLatestFallback
                  const isFocused = item.index === focusIndex
                  const distance = Math.abs(item.index - focusIndex)
                  const opacity = Math.max(0.35, 1 - distance * 0.12)

                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => handleClick(item.id)}
                      onMouseEnter={() => setFocusIndex(item.index)}
                      className={cn(
                        'flex w-full items-center gap-2.5 px-3 py-[5px] text-left transition-colors duration-80',
                        (isFocused || isActive) && 'rounded-md'
                      )}
                      style={{
                        opacity,
                        backgroundColor: isActive
                          ? 'color-mix(in srgb, var(--agent-hover) 50%, transparent)'
                          : isFocused
                            ? 'color-mix(in srgb, var(--agent-hover) 30%, transparent)'
                            : 'transparent'
                      }}
                    >
                      {/* Active indicator: left capsule */}
                      <span
                        className="w-[3px] shrink-0 rounded-full transition-all duration-100"
                        style={{
                          height: isActive ? '14px' : '0px',
                          backgroundColor: 'var(--foreground)',
                          opacity: isActive ? 0.7 : 0
                        }}
                      />
                      <span
                        className="w-4 shrink-0 text-right text-[9px] tabular-nums"
                        style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}
                      >
                        {item.index + 1}
                      </span>
                      <span
                        className="truncate text-[11px] leading-tight"
                        style={{
                          color: isActive || isFocused
                            ? 'var(--foreground)'
                            : 'var(--muted-foreground)',
                          fontWeight: isActive ? 500 : 400
                        }}
                      >
                        {truncatePreview(item.preview, PREVIEW_MAX_CHARS)}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
