import { useEffect, useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useSessions, type HubSessionListItem } from '../stores/useSessions'
import { usePullToRefresh } from '../hooks/usePullToRefresh'
import { formatRelativeTime } from '../lib/time'
import {
  PullIndicator,
  SkeletonRows,
  EmptyState,
  ErrorBanner
} from './Devices'

interface Group {
  projectId: string
  projectName: string
  worktreeName: string | null
  worktreeId: string | null
  sessions: HubSessionListItem[]
}

function groupSessions(sessions: HubSessionListItem[]): Group[] {
  const map = new Map<string, Group>()
  for (const s of sessions) {
    const key = `${s.project.id}:${s.worktree?.id ?? '-'}`
    let g = map.get(key)
    if (!g) {
      g = {
        projectId: s.project.id,
        projectName: s.project.name,
        worktreeId: s.worktree?.id ?? null,
        worktreeName: s.worktree?.name ?? null,
        sessions: []
      }
      map.set(key, g)
    }
    g.sessions.push(s)
  }
  return Array.from(map.values())
}

export function Sessions(): React.JSX.Element {
  const { deviceId } = useParams<{ deviceId: string }>()
  const {
    byDevice,
    loadingSessionsFor,
    sessionsErrorFor,
    refreshSessions
  } = useSessions()

  const sessions = deviceId ? byDevice[deviceId] : undefined
  const loading = loadingSessionsFor === deviceId
  const error = deviceId ? sessionsErrorFor[deviceId] : null

  const groups = useMemo(() => (sessions ? groupSessions(sessions) : []), [sessions])
  const { ref, pulling, refreshing } = usePullToRefresh(async () => {
    if (deviceId) await refreshSessions(deviceId)
  })

  useEffect(() => {
    if (deviceId) refreshSessions(deviceId)
  }, [deviceId, refreshSessions])

  return (
    <div
      ref={ref}
      className="min-h-dvh safe-pad-top safe-pad-bottom overflow-y-auto"
    >
      <header className="flex items-center gap-3 px-4 py-3 border-b border-zinc-900 sticky top-0 bg-zinc-950/95 backdrop-blur z-10">
        <Link
          to="/devices"
          className="text-zinc-400 text-xl leading-none active:text-zinc-200"
          aria-label="返回"
        >
          ←
        </Link>
        <h1 className="text-lg font-semibold">会话</h1>
      </header>

      <PullIndicator pulling={pulling} refreshing={refreshing || loading} />

      <div className="p-4 space-y-4">
        {loading && !sessions && <SkeletonRows />}

        {error && <ErrorBanner message={error} onRetry={() => refreshSessions(deviceId!)} />}

        {!loading && !error && groups.length === 0 && (
          <EmptyState
            title="没有活跃会话"
            hint="在桌面端打开一个 Claude Code 会话。"
          />
        )}

        {groups.map((g) => (
          <GroupSection key={`${g.projectId}:${g.worktreeId}`} group={g} deviceId={deviceId!} />
        ))}
      </div>
    </div>
  )
}

function GroupSection({
  group,
  deviceId
}: {
  group: Group
  deviceId: string
}): React.JSX.Element {
  return (
    <section>
      <h2 className="text-xs text-zinc-500 uppercase tracking-wider font-medium px-1 mb-2">
        {group.projectName}
        {group.worktreeName && ` · ${group.worktreeName}`}
      </h2>
      <ul className="space-y-2">
        {group.sessions.map((s) => (
          <li key={s.hiveSessionId}>
            <Link
              to={`/session/${encodeURIComponent(deviceId)}/${encodeURIComponent(s.hiveSessionId)}`}
              className="block p-3 rounded-xl bg-zinc-900 border border-zinc-800 active:bg-zinc-800 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium truncate flex-1 min-w-0">
                  {s.name ?? `会话 ${s.hiveSessionId.slice(0, 8)}`}
                </span>
                {s.runtimeStatus === 'busy' && (
                  <span
                    className="h-2 w-2 rounded-full bg-red-500 shrink-0 shadow-[0_0_6px_rgba(239,68,68,0.7)]"
                    title="运行中"
                  />
                )}
                {s.runtimeStatus === 'error' && (
                  <span
                    className="h-2 w-2 rounded-full bg-amber-500 shrink-0"
                    title="出错"
                  />
                )}
              </div>
              <p className="text-xs text-zinc-500 mt-1">
                {formatRelativeTime(s.updatedAt)}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
