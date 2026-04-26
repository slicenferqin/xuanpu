/**
 * CommandApprovalCard: pre-execution approval gate for shell commands surfaced
 * via `command_approval/request`. Three options match the desktop flow:
 * approve_once / approve_always / reject.
 */

import type { SessionStream } from '../hooks/useSessionStream'

export function CommandApprovalCard({
  stream
}: {
  stream: SessionStream
}): React.JSX.Element | null {
  const req = stream.state.commandApproval
  if (!req) return null

  return (
    <div className="rounded-xl border border-amber-900/60 bg-amber-950/20 px-3.5 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs uppercase tracking-wider text-amber-400">command</span>
        <span className="text-xs text-zinc-500">需审批</span>
      </div>

      <pre className="text-xs font-mono text-zinc-100 bg-zinc-950 rounded-md px-3 py-2 mb-2 whitespace-pre-wrap break-all max-h-40 overflow-auto">
        {req.command || '(no command)'}
      </pre>
      {req.cwd && (
        <p className="text-xs text-zinc-500 mb-1 break-all">cwd: {req.cwd}</p>
      )}
      {req.reason && (
        <p className="text-xs text-zinc-400 mb-2">{req.reason}</p>
      )}

      <div className="grid grid-cols-3 gap-2">
        <button
          onClick={() => stream.respondCommandApproval('approve_once')}
          className="px-3 py-2 rounded-lg bg-amber-600 active:bg-amber-700 text-xs font-medium text-white"
        >
          仅本次
        </button>
        <button
          onClick={() => stream.respondCommandApproval('approve_always')}
          className="px-3 py-2 rounded-lg bg-emerald-600 active:bg-emerald-700 text-xs font-medium text-white"
        >
          总是允许
        </button>
        <button
          onClick={() => stream.respondCommandApproval('reject')}
          className="px-3 py-2 rounded-lg border border-zinc-700 active:bg-zinc-800 text-xs text-zinc-300"
        >
          拒绝
        </button>
      </div>
    </div>
  )
}
