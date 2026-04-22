import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useSessions } from '../stores/useSessions'
import { useAuth } from '../stores/useAuth'
import { usePullToRefresh } from '../hooks/usePullToRefresh'
import { formatRelativeTime } from '../lib/time'

export function Devices(): React.JSX.Element {
  const { devices, loadingDevices, devicesError, refreshDevices } = useSessions()
  const { logout, username } = useAuth()
  const { ref, pulling, refreshing } = usePullToRefresh(refreshDevices)

  useEffect(() => {
    refreshDevices()
  }, [refreshDevices])

  return (
    <div
      ref={ref}
      className="min-h-dvh safe-pad-top safe-pad-bottom overflow-y-auto"
    >
      <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-900 sticky top-0 bg-zinc-950/95 backdrop-blur z-10">
        <h1 className="text-lg font-semibold">设备</h1>
        <button
          onClick={() => logout()}
          className="text-sm text-zinc-400 hover:text-zinc-200 active:text-zinc-100"
        >
          {username ? `${username} · 登出` : '登出'}
        </button>
      </header>

      <PullIndicator pulling={pulling} refreshing={refreshing || loadingDevices} />

      <div className="p-4 space-y-3">
        {loadingDevices && devices.length === 0 && <SkeletonRows />}

        {devicesError && (
          <ErrorBanner message={devicesError} onRetry={refreshDevices} />
        )}

        {!loadingDevices && !devicesError && devices.length === 0 && (
          <EmptyState
            title="没有设备"
            hint="请确认桌面端 Hub 已开启。"
          />
        )}

        {devices.map((d) => (
          <Link
            key={d.id}
            to={`/sessions/${encodeURIComponent(d.id)}`}
            className="block p-4 rounded-xl bg-zinc-900 border border-zinc-800 active:bg-zinc-800 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span
                className={
                  d.online
                    ? 'h-2.5 w-2.5 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]'
                    : 'h-2.5 w-2.5 rounded-full bg-zinc-600'
                }
              />
              <span className="font-medium">{d.name}</span>
              <span className="ml-auto text-zinc-500 text-sm">›</span>
            </div>
            <p className="text-xs text-zinc-500 mt-1 ml-4.5">
              {d.hostname}
              {!d.online && d.lastSeen
                ? ` · 最后在线 ${formatRelativeTime(d.lastSeen)}`
                : ''}
            </p>
          </Link>
        ))}
      </div>
    </div>
  )
}

// ─── shared bits ──────────────────────────────────────────────────────────

function PullIndicator({
  pulling,
  refreshing
}: {
  pulling: number
  refreshing: boolean
}): React.JSX.Element | null {
  if (!refreshing && pulling === 0) return null
  return (
    <div className="flex items-center justify-center py-2 text-xs text-zinc-500">
      {refreshing ? (
        <span>刷新中…</span>
      ) : (
        <span style={{ opacity: pulling }}>下拉刷新…</span>
      )}
    </div>
  )
}

function SkeletonRows(): React.JSX.Element {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-16 rounded-xl bg-zinc-900 border border-zinc-800 animate-pulse"
        />
      ))}
    </>
  )
}

function EmptyState({
  title,
  hint
}: {
  title: string
  hint: string
}): React.JSX.Element {
  return (
    <div className="text-center py-12 text-zinc-500">
      <p className="font-medium">{title}</p>
      <p className="text-sm mt-1">{hint}</p>
    </div>
  )
}

function ErrorBanner({
  message,
  onRetry
}: {
  message: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div className="p-4 rounded-xl bg-red-950/40 border border-red-900/60">
      <p className="text-sm text-red-300">加载失败</p>
      <p className="text-xs text-red-400/80 mt-1 break-words">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 px-3 py-1.5 rounded bg-red-900/50 text-sm text-red-100"
      >
        重试
      </button>
    </div>
  )
}

export { PullIndicator, SkeletonRows, EmptyState, ErrorBanner }
