import React, { useMemo, useState, useCallback } from 'react'
import { cn } from '@/lib/utils'

interface RoundNavigatorItem {
  id: string
  index: number
  preview: string
}

interface RoundNavigatorProps {
  rounds: RoundNavigatorItem[]
  activeRoundId?: string | null
  onRoundAnchorNavigate?: (roundId: string) => void
}

const VISIBLE_ROWS = 10
const PREVIEW_MAX_CHARS = 10
const NEIGHBOR_RADIUS = 3

function truncatePreview(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}

function clampIndex(index: number, max: number): number {
  return Math.max(0, Math.min(max, index))
}

function getNeighborhood(
  rounds: RoundNavigatorItem[],
  centerIndex: number,
  radius: number
): RoundNavigatorItem[] {
  const start = Math.max(0, centerIndex - radius)
  const end = Math.min(rounds.length, centerIndex + radius + 1)
  return rounds.slice(start, end)
}

/**
 * Compute wheel window start so that:
 * - focus is near center when possible
 * - window always fills VISIBLE_ROWS when rounds.length >= VISIBLE_ROWS
 * - window clamps to [0, rounds.length - VISIBLE_ROWS] at edges
 */
function getWheelStart(focusIndex: number, roundCount: number): number {
  if (roundCount <= VISIBLE_ROWS) return 0
  const half = Math.floor(VISIBLE_ROWS / 2)
  const rawStart = focusIndex - half
  return clampIndex(rawStart, roundCount - VISIBLE_ROWS)
}

export function RoundNavigator({
  rounds,
  activeRoundId,
  onRoundAnchorNavigate
}: RoundNavigatorProps): React.JSX.Element | null {
  const [isHovered, setIsHovered] = useState(false)
  const [focusIndex, setFocusIndex] = useState(rounds.length - 1)

  // Resolve active index: explicit match or fallback to latest
  const activeIndex = useMemo(() => {
    if (activeRoundId) {
      const idx = rounds.findIndex((r) => r.id === activeRoundId)
      if (idx >= 0) return idx
    }
    return Math.max(0, rounds.length - 1)
  }, [activeRoundId, rounds])

  // Whether the resolved active is the "latest fallback"
  const isLatestFallback = !activeRoundId || !rounds.some((r) => r.id === activeRoundId)

  // Sync focus to active when not hovering
  React.useEffect(() => {
    if (!isHovered) {
      setFocusIndex(activeIndex)
    }
  }, [activeIndex, isHovered])

  const neighborhood = useMemo(
    () => getNeighborhood(rounds, isHovered ? focusIndex : activeIndex, NEIGHBOR_RADIUS),
    [rounds, activeIndex, focusIndex, isHovered]
  )

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

  // Wheel: preventDefault stops scroll, stopPropagation prevents timeline scroll
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

  // The rail is always 24px wide (stable layout). Wheel is absolute overlay.
  return (
    <aside
      className="sticky top-1/2 z-20 hidden w-6 shrink-0 -translate-y-1/2 self-start lg:block"
      data-testid="round-navigator"
      onMouseEnter={() => setIsHovered(true)}
      onFocus={() => setIsHovered(true)}
      onMouseLeave={handleMouseLeave}
      onWheel={isHovered ? handleWheel : undefined}
      onKeyDown={isHovered ? handleKeyDown : undefined}
      tabIndex={0}
      role="navigation"
      aria-label="Round navigator"
    >
      {/* Ghost markers — always visible, always 24px */}
      <div className="relative flex flex-col items-center gap-1.5 py-2">
        {neighborhood.map((item) => {
          const isActive = item.index === activeIndex && !isLatestFallback
          const distance = Math.abs(item.index - activeIndex)
          const opacity = isActive ? 1 : Math.max(0.2, 0.6 - distance * 0.15)

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => handleClick(item.id)}
              className={cn(
                'rounded-full transition-all duration-150',
                isActive ? 'h-[7px] w-[7px]' : 'h-[4px] w-[4px]'
              )}
              style={{
                backgroundColor: isActive
                  ? 'var(--foreground)'
                  : 'color-mix(in srgb, var(--muted-foreground) 35%, transparent)',
                opacity,
                boxShadow: isActive
                  ? '0 0 6px color-mix(in srgb, var(--foreground) 8%, transparent)'
                  : 'none'
              }}
              title={item.preview}
              aria-current={isActive ? 'step' : undefined}
            />
          )
        })}
      </div>

      {/* Wheel overlay — absolute positioned, doesn't affect layout */}
      {isHovered && (
        <div
          className="absolute left-full top-1/2 ml-2 -translate-y-1/2"
          style={{ animation: 'round-navigator-expand 160ms ease-out' }}
        >
          <div
            className="rounded-xl border py-1.5 backdrop-blur-sm"
            style={{
              backgroundColor: 'color-mix(in srgb, var(--agent-card) 88%, transparent)',
              borderColor: 'color-mix(in srgb, var(--border) 86%, transparent)',
              boxShadow: '0 2px 8px rgb(var(--agent-shadow-rgb) / 0.10)'
            }}
            role="listbox"
            aria-label="Round list"
          >
            {wheelItems.map((item) => {
              const isActive = item.index === activeIndex && !isLatestFallback
              const isFocused = item.index === focusIndex
              const distance = Math.abs(item.index - focusIndex)
              const opacity = Math.max(0.4, 1 - distance * 0.15)

              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => handleClick(item.id)}
                  onMouseEnter={() => setFocusIndex(item.index)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1 text-left transition-colors',
                    (isFocused || isActive) && 'rounded-md'
                  )}
                  style={{
                    opacity,
                    backgroundColor: isActive
                      ? 'color-mix(in srgb, var(--agent-hover) 45%, transparent)'
                      : isFocused
                        ? 'color-mix(in srgb, var(--agent-hover) 25%, transparent)'
                        : 'transparent',
                    borderLeft: isActive
                      ? '2px solid color-mix(in srgb, var(--foreground) 60%, transparent)'
                      : '2px solid transparent'
                  }}
                >
                  <span
                    className="w-5 shrink-0 text-right text-[10px] tabular-nums"
                    style={{ color: 'var(--muted-foreground)' }}
                  >
                    {item.index + 1}
                  </span>
                  <span
                    className="truncate text-[11px]"
                    style={{
                      color: isActive ? 'var(--foreground)' : 'var(--muted-foreground)'
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
    </aside>
  )
}
