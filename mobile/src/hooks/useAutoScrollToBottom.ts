/**
 * useAutoScrollToBottom: keep a scroll container pinned to the bottom when
 * new content arrives, unless the user has manually scrolled up.
 *
 *   const { scrollRef, atBottom, jumpToBottom } = useAutoScrollToBottom()
 *   <div ref={scrollRef}>...</div>
 *
 * Call `bump()` whenever new content is appended (we can't watch DOM size
 * cheaply enough for every character in a streaming transcript).
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export interface AutoScroll {
  scrollRef: (el: HTMLDivElement | null) => void
  atBottom: boolean
  /** Programmatically pop back to bottom. */
  jumpToBottom: () => void
  /** Called by caller when new content has been added. */
  bump: () => void
}

const BOTTOM_TOLERANCE = 40

export function useAutoScrollToBottom(): AutoScroll {
  const elRef = useRef<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = useState(true)

  const check = useCallback((): boolean => {
    const el = elRef.current
    if (!el) return true
    const delta = el.scrollHeight - el.scrollTop - el.clientHeight
    return delta <= BOTTOM_TOLERANCE
  }, [])

  const jumpToBottom = useCallback((): void => {
    const el = elRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setAtBottom(true)
  }, [])

  const bump = useCallback((): void => {
    if (atBottom) jumpToBottom()
  }, [atBottom, jumpToBottom])

  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const onScroll = (): void => {
      setAtBottom(check())
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [check])

  const scrollRef = useCallback(
    (el: HTMLDivElement | null) => {
      elRef.current = el
      if (el) setAtBottom(check())
    },
    [check]
  )

  return { scrollRef, atBottom, jumpToBottom, bump }
}
