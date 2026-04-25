/**
 * usePullToRefresh: attach to the scroll container root. When the user drags
 * down past `threshold` while already at scrollTop=0, calls `onRefresh`.
 *
 * Passive touch listeners; no preventDefault — we rely on iOS rubber-banding
 * for the visual. Translation is surfaced via `pulling` (0..1) so callers
 * can render a spinner / arrow.
 */

import { useEffect, useRef, useState } from 'react'

export interface PullToRefresh {
  ref: (el: HTMLElement | null) => void
  pulling: number
  refreshing: boolean
}

export function usePullToRefresh(
  onRefresh: () => void | Promise<void>,
  options: { threshold?: number } = {}
): PullToRefresh {
  const threshold = options.threshold ?? 80
  const [pulling, setPulling] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const elRef = useRef<HTMLElement | null>(null)
  const startY = useRef<number | null>(null)

  useEffect(() => {
    const el = elRef.current
    if (!el) return

    const onTouchStart = (e: TouchEvent): void => {
      if (el.scrollTop > 0) {
        startY.current = null
        return
      }
      startY.current = e.touches[0]!.clientY
    }
    const onTouchMove = (e: TouchEvent): void => {
      if (startY.current === null) return
      const dy = e.touches[0]!.clientY - startY.current
      if (dy <= 0) {
        setPulling(0)
        return
      }
      setPulling(Math.min(1, dy / threshold))
    }
    const onTouchEnd = (): void => {
      if (startY.current === null) return
      const p = pulling
      startY.current = null
      setPulling(0)
      if (p >= 1 && !refreshing) {
        setRefreshing(true)
        Promise.resolve(onRefresh()).finally(() => {
          setRefreshing(false)
        })
      }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [pulling, refreshing, threshold, onRefresh])

  return {
    ref: (el) => {
      elRef.current = el
    },
    pulling,
    refreshing
  }
}
