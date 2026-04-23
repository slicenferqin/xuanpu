import type { SessionStream } from '../hooks/useSessionStream'

export function PermissionCard({
  stream
}: {
  stream: SessionStream
}): React.JSX.Element | null {
  const req = stream.state.permission
  if (!req) return null
  return (
    <div className="p-4 rounded-xl bg-amber-950/30 border border-amber-900/50 space-y-3">
      <div>
        <p className="text-xs uppercase tracking-wider text-amber-400 font-medium">
          权限请求
        </p>
        <p className="font-mono text-sm mt-1">{req.toolName}</p>
        {req.description && (
          <p className="text-xs text-zinc-400 mt-1">{req.description}</p>
        )}
      </div>
      {req.input !== undefined && (
        <pre className="p-2 text-xs font-mono bg-zinc-950/60 border border-zinc-800 rounded max-h-48 overflow-auto whitespace-pre-wrap break-words">
          {JSON.stringify(req.input, null, 2)}
        </pre>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => stream.respondPermission('once')}
          className="flex-1 py-2 rounded-lg bg-zinc-100 text-zinc-900 text-sm font-medium active:bg-zinc-200"
        >
          允许一次
        </button>
        <button
          onClick={() => stream.respondPermission('always')}
          className="flex-1 py-2 rounded-lg bg-zinc-800 text-zinc-100 text-sm active:bg-zinc-700"
        >
          总是允许
        </button>
        <button
          onClick={() => stream.respondPermission('reject')}
          className="flex-1 py-2 rounded-lg bg-red-950/60 text-red-200 text-sm active:bg-red-950"
        >
          拒绝
        </button>
      </div>
    </div>
  )
}
