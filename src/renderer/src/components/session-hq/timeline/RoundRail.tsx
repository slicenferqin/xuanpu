import React, { useMemo } from 'react'
import { cn } from '@/lib/utils'

interface RoundRailRound {
  id: string
  preview: string
}

interface RoundRailProps {
  rounds: RoundRailRound[]
  activeRoundId?: string | null
  scrollContainerRef: React.RefObject<HTMLElement | null>
  onRoundAnchorNavigate?: (roundId: string) => void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Peak spacing expansion multiplier at the hovered dot.
 * 3x means the center dot and its immediate neighbors spread to three times
 * their natural spacing, while dots at the far end compress to compensate.
 */
const FISHEYE_MAX_EXPANSION = 3.0

function computeFisheyeLayout(
  roundCount: number,
  railHeight: number,
  hoverY: number | null
): { topPercents: number[]; expansions: number[] } {
  if (roundCount <= 0) return { topPercents: [], expansions: [] }
  if (roundCount === 1) return { topPercents: [50], expansions: [1] }

  const naturalSpacing = railHeight / (roundCount - 1)
  const influenceRadius = clamp(railHeight * 0.28, 64, 140)

  const expansions = Array.from({ length: roundCount }, (_, index) => {
    if (hoverY === null) return 1
    const naturalY = (index / (roundCount - 1)) * railHeight
    const distance = Math.abs(naturalY - hoverY)
    if (distance >= influenceRadius) return 1

    const bell = 0.5 * (1 + Math.cos((Math.PI * distance) / influenceRadius))
    return 1 + bell * (FISHEYE_MAX_EXPANSION - 1)
  })

  if (hoverY === null) {
    const topPercents = Array.from(
      { length: roundCount },
      (_, index) => (index / (roundCount - 1)) * 100
    )
    return { topPercents, expansions }
  }

  const expandedY: number[] = new Array(roundCount).fill(0)
  for (let index = 1; index < roundCount; index++) {
    const avgExpansion = (expansions[index - 1] + expansions[index]) / 2
    expandedY[index] = expandedY[index - 1] + naturalSpacing * avgExpansion
  }
  const totalExpanded = expandedY[roundCount - 1] || 1
  const topPercents = expandedY.map((y) => (y / totalExpanded) * 100)

  return { topPercents, expansions }
}

function getRailDotStyle({
  topPercent,
  expansion,
  active,
  hovering
}: {
  topPercent: number
  expansion: number
  active: boolean
  hovering: boolean
}): React.CSSProperties {
  const t = clamp((expansion - 1) / (FISHEYE_MAX_EXPANSION - 1), 0, 1)
  const width = 4 + t * 18
  const height = 4 + t * 8

  let opacity: number
  if (active) {
    opacity = clamp(0.75 + t * 0.25, 0.75, 1)
  } else if (hovering) {
    opacity = clamp(0.35 + t * 0.5, 0.35, 0.85)
  } else {
    opacity = 0
  }

  return {
    top: `${topPercent}%`,
    width: `${width}px`,
    height: `${height}px`,
    opacity,
    transform: 'translate(-50%, -50%)',
    zIndex: Math.round(10 + t * 30)
  }
}

function getRoundRailIndexFromY(y: number, railHeight: number, roundCount: number): number {
  if (roundCount <= 1) return 0
  return clamp(Math.round((y / railHeight) * (roundCount - 1)), 0, roundCount - 1)
}

export function RoundRail({
  rounds,
  activeRoundId,
  scrollContainerRef,
  onRoundAnchorNavigate
}: RoundRailProps): React.JSX.Element | null {
  const [hoverY, setHoverY] = React.useState<number | null>(null)
  const [railHeight, setRailHeight] = React.useState(336)

  const fisheyeLayout = useMemo(
    () => computeFisheyeLayout(rounds.length, railHeight, hoverY),
    [rounds.length, railHeight, hoverY]
  )

  React.useLayoutEffect(() => {
    const element = scrollContainerRef.current
    if (!element) return

    const updateRailHeight = (): void => {
      const nextHeight = Math.round(element.clientHeight)
      if (nextHeight > 0) {
        setRailHeight(nextHeight)
      }
    }

    updateRailHeight()

    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(updateRailHeight)
    observer.observe(element)
    return () => observer.disconnect()
  }, [scrollContainerRef])

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect()
      if (rect.height <= 0) return
      if (!Number.isFinite(event.clientY)) return
      setRailHeight(rect.height)
      setHoverY(clamp(event.clientY - rect.top, 0, rect.height))
    },
    []
  )

  const handlePointerLeave = React.useCallback(() => {
    setHoverY(null)
  }, [])

  const handleRailClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!onRoundAnchorNavigate || rounds.length === 0) return
      const rect = event.currentTarget.getBoundingClientRect()
      if (rect.height <= 0) return
      const y = clamp(event.clientY - rect.top, 0, rect.height)
      const roundIndex = getRoundRailIndexFromY(y, rect.height, rounds.length)
      onRoundAnchorNavigate(rounds[roundIndex].id)
    },
    [onRoundAnchorNavigate, rounds]
  )

  if (rounds.length <= 1) return null

  return (
    <aside
      className="sticky top-0 -mt-6 hidden w-8 shrink-0 self-start lg:block"
      data-testid="timeline-round-anchor-rail"
    >
      <div
        className="group relative cursor-pointer overflow-visible"
        data-testid="timeline-round-anchor-rail-items"
        style={{ height: `${railHeight}px` }}
        onPointerMove={handlePointerMove}
        onMouseMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onMouseLeave={handlePointerLeave}
        onClick={handleRailClick}
      >
        <div
          aria-hidden="true"
          className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 border-l border-dashed border-border/30 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        />
        {rounds.map((round, roundIndex) => {
          const isActive =
            activeRoundId === round.id || (!activeRoundId && roundIndex === rounds.length - 1)
          const dotStyle = getRailDotStyle({
            topPercent:
              fisheyeLayout.topPercents[roundIndex] ??
              (roundIndex / Math.max(rounds.length - 1, 1)) * 100,
            expansion: fisheyeLayout.expansions[roundIndex] ?? 1,
            active: isActive,
            hovering: hoverY !== null
          })

          return (
            <button
              key={`rail-${round.id}`}
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onRoundAnchorNavigate?.(round.id)
              }}
              className={cn(
                'absolute left-1/2 rounded-full transition-[width,height,opacity,background-color,box-shadow] duration-150 ease-out',
                isActive
                  ? 'bg-primary/90 shadow-[0_0_8px_rgba(59,130,246,0.55),0_0_3px_rgba(59,130,246,0.25)]'
                  : 'bg-muted-foreground/35 hover:bg-primary/55'
              )}
              style={dotStyle}
              title={round.preview}
              aria-current={isActive ? 'step' : undefined}
              aria-label={`跳转到第 ${roundIndex + 1} 轮：${round.preview}`}
              data-testid="timeline-round-anchor-button"
            />
          )
        })}
      </div>
    </aside>
  )
}
