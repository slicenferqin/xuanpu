import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useSessionStream } from '../hooks/useSessionStream'
import { useAutoScrollToBottom } from '../hooks/useAutoScrollToBottom'
import { useSessions } from '../stores/useSessions'
import { MessageBubble } from '../components/MessageBubble'
import { PermissionCard } from '../components/PermissionCard'
import { QuestionCard } from '../components/QuestionCard'
import { PlanCard } from '../components/PlanCard'
import { CommandApprovalCard } from '../components/CommandApprovalCard'
import { NoticeStrip } from '../components/NoticeStrip'
import { PromptComposer } from '../components/PromptComposer'
import { ErrorBoundary } from '../components/ErrorBoundary'

export function SessionDetail(): React.JSX.Element {
  const { deviceId, hiveId } = useParams<{ deviceId: string; hiveId: string }>()
  if (!deviceId || !hiveId) {
    return <div className="p-4 text-zinc-400">无效的会话链接</div>
  }
  return <SessionDetailInner deviceId={deviceId} hiveId={hiveId} />
}

function SessionDetailInner({
  deviceId,
  hiveId
}: {
  deviceId: string
  hiveId: string
}): React.JSX.Element {
  const stream = useSessionStream(deviceId, hiveId)
  const { scrollRef, atBottom, jumpToBottom, bump } = useAutoScrollToBottom()
  const { messages, connection, status, permission, question, plan, commandApproval, notices, error } = stream.state
  const sessionMeta = useSessions((s) =>
    s.byDevice[deviceId]?.find((it) => it.hiveSessionId === hiveId)
  )
  const refreshSessions = useSessions((s) => s.refreshSessions)
  const hasSessionName = Boolean(sessionMeta?.name?.trim())

  // Refresh metadata when we don't have this session yet or only have the raw
  // id, so the mobile header can upgrade to the latest session name.
  useEffect(() => {
    if (!sessionMeta || !hasSessionName) refreshSessions(deviceId)
  }, [deviceId, hasSessionName, refreshSessions, sessionMeta])

  const headerTitle = sessionMeta?.name?.trim() || hiveId

  // Bump auto-scroll whenever the message list or running state changes.
  useEffect(() => {
    bump()
  }, [messages.length, status, bump])

  return (
    <div className="flex flex-col h-dvh safe-pad-top">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-zinc-900 bg-zinc-950/95 backdrop-blur shrink-0">
        <Link
          to={`/sessions/${deviceId}`}
          className="text-zinc-400 text-xl leading-none active:text-zinc-200"
          aria-label="返回"
        >
          ←
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold truncate" title={headerTitle}>
            {headerTitle}
          </h1>
          <ConnectionLine
            connection={connection}
            status={status}
          />
        </div>
      </header>

      {connection !== 'open' && (
        <div
          className={
            'px-4 py-1.5 text-xs text-center ' +
            (connection === 'connecting'
              ? 'bg-amber-950/40 text-amber-300'
              : 'bg-red-950/40 text-red-300')
          }
        >
          {connection === 'connecting' ? '正在连接…' : '已断开，尝试重连中'}
        </div>
      )}

      <NoticeStrip
        notices={notices}
        onDismiss={stream.dismissNotice}
        onClearAll={stream.clearAllNotices}
      />

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 py-4 space-y-3"
        data-testid="message-stream"
      >
        {messages.length === 0 && connection === 'open' && (
          <p className="text-sm text-zinc-500 text-center py-12">
            还没有消息，发送一条试试。
          </p>
        )}
        {messages.map((m) => (
          <ErrorBoundary key={m.id}>
            <MessageBubble message={m} />
          </ErrorBoundary>
        ))}

        {plan && (
          <ErrorBoundary>
            <PlanCard stream={stream} />
          </ErrorBoundary>
        )}
        {commandApproval && (
          <ErrorBoundary>
            <CommandApprovalCard stream={stream} />
          </ErrorBoundary>
        )}
        {permission && (
          <ErrorBoundary>
            <PermissionCard stream={stream} />
          </ErrorBoundary>
        )}
        {question && (
          <ErrorBoundary>
            <QuestionCard stream={stream} />
          </ErrorBoundary>
        )}

        {error && error.code !== 'INTERNAL' && (
          <div className="p-3 rounded-lg bg-red-950/40 border border-red-900/50">
            <p className="text-xs font-medium text-red-300">{error.code}</p>
            {error.message && (
              <p className="text-xs text-red-400/80 mt-1">{error.message}</p>
            )}
          </div>
        )}
      </div>

      {!atBottom && (
        <button
          onClick={jumpToBottom}
          className="absolute right-4 bottom-36 px-3 py-1.5 rounded-full bg-zinc-800 text-xs text-zinc-200 shadow-lg active:bg-zinc-700"
        >
          ↓ 新消息
        </button>
      )}

      <PromptComposer stream={stream} />
    </div>
  )
}

function ConnectionLine({
  connection,
  status
}: {
  connection: 'connecting' | 'open' | 'closed'
  status: 'idle' | 'busy' | 'retry' | 'error'
}): React.JSX.Element {
  let text = '离线'
  let cls = 'text-zinc-500'
  if (connection === 'open') {
    if (status === 'busy') {
      text = '● 运行中'
      cls = 'text-red-400'
    } else if (status === 'error') {
      text = '● 出错'
      cls = 'text-amber-400'
    } else {
      text = '● 在线'
      cls = 'text-green-400'
    }
  } else if (connection === 'connecting') {
    text = '○ 连接中…'
    cls = 'text-amber-400'
  }
  return <p className={'text-xs ' + cls}>{text}</p>
}
