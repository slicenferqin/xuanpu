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

const VISIBLE_MARKERS = 7
const VISIBLE_ROWS = 10
const PREVIEW_MAX_CHARS = 10

function truncatePreview(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= max) return trimmed || '未命名'
  return trimmed.slice(0, max) + '…'
}

function getNeighborhood(
  rounds: RoundNavigatorItem[],
  activeIndex: number,
  radius: number
): RoundNavigatorItem[] {
  const start = Math.max(0, activeIndex - radius)
  const end = Math.min(rounds.length, activeIndex + radius + 1)
  return rounds.slice(start, end)
}

export function RoundNavigator({
  rounds,
  activeRoundId,
  onRoundAnchorNavigate
}: RoundNavigatorProps): React.JSX.Element | null {
  const [isHovered, setIsHovered] = useState(false)
  const [focusIndex, setFocusIndex] = useState(() => {
    if (!activeRoundId) return rounds.length - 1
    const idx = rounds.findIndex((r) => r.id === activeRoundId)
    return idx >= 0 ? idx : rounds.length - 1
  })

  const activeIndex = useMemo(() => {
    if (!activeRoundId) return rounds.length - 1
    const idx = rounds.findIndex((r) => r.id === activeRoundId)
    return idx >= 0 ? idx : rounds.length - 1
  }, [activeRoundId, rounds])

  React.useEffect(() => {
    if (!isHovered) {
      setFocusIndex(activeIndex)
    }
  }, [activeIndex, isHovered])

  const neighborhood = useMemo(
    () => getNeighborhood(rounds, isHovered ? focusIndex : activeIndex, 3),
    [rounds, activeIndex, focusIndex, isHovered]
  )

  const wheelItems = useMemo(() => {
    const center = focusIndex
    const start = Math.max(0, center - Math.floor(VISIBLE_ROWS / 2))
    const end = Math.min(rounds.length, start + VISIBLE_ROWS)
    return rounds.slice(start, end)
  }, [rounds, focusIndex])

  const handleClick = useCallback(
    (roundId: string) => {
      onRoundAnchorNavigate?.(roundId)
    },
    [onRoundAnchorNavigate]
  )

  const handleWheel = useCallback(
    (event: React.WheelEvent) => {
      if (!isHovered) return
      event.preventDefault()
      const delta = event.deltaY > 0 ? 1 : -1
      setFocusIndex((prev) =>
        Math.max(0, Math.min(rounds.length - 1, prev + delta))
      )
    },
    [isHovered, rounds.length]
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
        setFocusIndex((prev) => Math.max(0, prev - 1))
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setFocusIndex((prev) => Math.min(rounds.length - 1, prev + 1))
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const item = rounds[focusIndex]
        if (item) handleClick(item.id)
      }
    },
    [activeIndex, rounds, focusIndex, handleClick]
  )

  if (rounds.length <= 1) return null

  if (isHovered) {
    return (
      <aside
        className="sticky top-1/2 -mt-6 hidden w-[176px] shrink-0 -translate-y-1/2 self-start lg:block"
        data-testid="round-navigator"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => {
          setIsHovered(false)
          setFocusIndex(activeIndex)
        }}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="listbox"
        aria-label="Round navigator"
      >
        <div
          className="rounded-xl border py-1.5 backdrop-blur-sm"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--agent-card) 88%, transparent)',
            borderColor:
              'color-mix(in srgb, var(--border) 86%, transparent)',
            boxShadow:
              '0 2px 8px rgb(var(--agent-shadow-rgb) / 0.10)',
            animation: 'round-navigator-expand 160ms ease-out'
          }}
        >
          {wheelItems.map((item) => {
            const isActive = item.id === activeRoundId
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
                  isFocused && !isActive && 'rounded-md',
                  isActive && 'rounded-md'
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
                    color: isActive
                      ? 'var(--foreground)'
                      : 'var(--muted-foreground)'
                  }}
                >
                  {truncatePreview(item.preview, PREVIEW_MAX_CHARS)}
                </span>
              </button>
            )
          })}
        </div>
      </aside>
    )
  }

  return (
    <aside
      className="sticky top-1/2 -mt-6 hidden w-6 shrink-0 -translate-y-1/2 self-start lg:block"
      data-testid="round-navigator"
      onMouseEnter={() => setIsHovered(true)}
      onFocus={() => setIsHovered(true)}
      tabIndex={0}
      role="navigation"
      aria-label="Round navigator"
    >
      <div className="relative flex flex-col items-center gap-1.5 py-2">
        {neighborhood.map((item) => {
          const isActive = item.id === activeRoundId
          const distance = Math.abs(item.index - activeIndex)
          const opacity = isActive
            ? 1
            : Math.max(0.2, 0.6 - distance * 0.15)

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
    </aside>
  )
}
