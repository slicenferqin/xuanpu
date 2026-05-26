/**
 * useBudgetState — M3 Context Budget polling hook.
 *
 * Polls window.budgetOps.getBudgetState() for the active xuanpu-agent session.
 * Returns BudgetState or null if not available.
 */
import { useState, useEffect, useRef } from 'react'

export interface BudgetState {
  profile: string
  estimatedTokens: number
  maxTokens: number
  fillRatio: number
  lastShrinkAt: number
  emergencyShrunk: boolean
  shrinkCount: number
  totalBeforeBytes: number
  totalAfterBytes: number
  sectionStats: { included: number; omitted: number }
}

const POLL_INTERVAL_MS = 3000

export function useBudgetState(sessionId: string | null): BudgetState | null {
  const [state, setState] = useState<BudgetState | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!sessionId || !window.budgetOps) {
      setState(null)
      return
    }

    const poll = () => {
      window.budgetOps
        .getBudgetState(sessionId)
        .then((data) => {
          if (data) {
            setState(data as BudgetState)
          } else {
            setState(null)
          }
        })
        .catch(() => {
          setState(null)
        })
    }

    poll() // immediate first fetch
    timerRef.current = setInterval(poll, POLL_INTERVAL_MS)

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [sessionId])

  return state
}
