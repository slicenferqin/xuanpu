import { useEffect, useRef, useState } from 'react'
import type { SessionStream } from '../hooks/useSessionStream'

export function PromptComposer({
  stream
}: {
  stream: SessionStream
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const busy = stream.state.status === 'busy'
  const connected = stream.state.connection === 'open'

  // Auto-size textarea (1..6 lines).
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }, [draft])

  const canSend = connected && !busy && draft.trim().length > 0

  const onSend = (): void => {
    if (!canSend) return
    stream.prompt(draft.trim())
    setDraft('')
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Desktop browsers: Enter to send, Shift+Enter for newline.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onSend()
    }
  }

  return (
    <div className="border-t border-zinc-900 bg-zinc-950/95 backdrop-blur safe-pad-bottom">
      <div className="p-2">
        <div className="rounded-3xl border border-zinc-800/80 bg-zinc-900/80 shadow-[0_-8px_24px_rgba(0,0,0,0.22)]">
          <div className="px-3 pt-3 pb-2">
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={connected ? '输入消息…' : '连接中…'}
              disabled={!connected}
              rows={1}
              className="min-h-[44px] max-h-[32svh] w-full resize-none rounded-2xl border border-zinc-800 bg-zinc-950 px-3.5 py-3 text-[15px] leading-6 text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-600 disabled:opacity-60"
            />
          </div>

          <div className="flex flex-col gap-2.5 px-3 pb-3 min-[380px]:flex-row min-[380px]:items-center min-[380px]:justify-between">
            <div className="min-w-0 text-[11px] leading-4 text-zinc-500">
              {busy ? '正在生成回复，可随时中断' : connected ? 'Shift + Enter 换行' : '等待连接恢复'}
            </div>

            {busy ? (
              <button
                onClick={() => stream.interrupt()}
                className="inline-flex h-11 w-full min-w-[88px] items-center justify-center rounded-full bg-red-900/70 px-4 text-sm font-medium text-red-100 shadow-sm transition active:scale-[0.98] active:bg-red-900 shrink-0 min-[380px]:w-auto"
                title="中断"
              >
                中断
              </button>
            ) : (
              <button
                onClick={onSend}
                disabled={!canSend}
                className="inline-flex h-11 w-full min-w-[88px] items-center justify-center rounded-full bg-zinc-100 px-4 text-sm font-semibold text-zinc-900 shadow-sm transition active:scale-[0.98] active:bg-zinc-200 disabled:opacity-40 disabled:active:scale-100 shrink-0 min-[380px]:w-auto"
              >
                发送
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
