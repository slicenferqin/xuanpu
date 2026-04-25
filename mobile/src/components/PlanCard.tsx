/**
 * PlanCard: surfaces a `plan/request` frame and lets the user approve/reject
 * the plan via the WS bridge. Mirrors desktop's `PlanReadyImplementFab` flow
 * but renders the full plan text inline instead of a floating fab.
 */

import { useState } from 'react'
import type { SessionStream } from '../hooks/useSessionStream'
import { MiniMarkdown } from './MiniMarkdown'

export function PlanCard({ stream }: { stream: SessionStream }): React.JSX.Element | null {
  const [feedback, setFeedback] = useState('')
  const [showReject, setShowReject] = useState(false)
  const plan = stream.state.plan
  if (!plan) return null

  return (
    <div className="rounded-xl border border-emerald-900/60 bg-emerald-950/20 px-3.5 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs uppercase tracking-wider text-emerald-400">plan</span>
        <span className="text-xs text-zinc-500">已就绪</span>
      </div>

      <div className="text-sm leading-relaxed mb-3 max-h-72 overflow-auto">
        <MiniMarkdown text={plan.planText || '(空 plan)'} />
      </div>

      {!showReject ? (
        <div className="flex gap-2">
          <button
            onClick={() => stream.respondPlan('approve')}
            className="flex-1 px-3 py-2 rounded-lg bg-emerald-600 active:bg-emerald-700 text-sm font-medium text-white"
          >
            批准并执行
          </button>
          <button
            onClick={() => setShowReject(true)}
            className="px-3 py-2 rounded-lg border border-zinc-700 active:bg-zinc-800 text-sm text-zinc-300"
          >
            拒绝
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="给 agent 留点反馈（可选）"
            rows={3}
            className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm"
          />
          <div className="flex gap-2">
            <button
              onClick={() => {
                stream.respondPlan('reject', feedback || undefined)
                setShowReject(false)
                setFeedback('')
              }}
              className="flex-1 px-3 py-2 rounded-lg bg-red-600 active:bg-red-700 text-sm font-medium text-white"
            >
              确认拒绝
            </button>
            <button
              onClick={() => setShowReject(false)}
              className="px-3 py-2 rounded-lg border border-zinc-700 active:bg-zinc-800 text-sm text-zinc-300"
            >
              返回
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
