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
      <div className="flex items-end gap-2 p-2">
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={connected ? '输入消息…' : '连接中…'}
          disabled={!connected}
          rows={1}
          className="flex-1 resize-none px-3 py-2 rounded-2xl bg-zinc-900 border border-zinc-800 text-sm leading-relaxed focus:outline-none focus:border-zinc-600 disabled:opacity-60"
        />
        {busy ? (
          <button
            onClick={() => stream.interrupt()}
            className="h-10 px-4 rounded-full bg-red-900/60 text-red-100 text-sm shrink-0 active:bg-red-900"
            title="中断"
          >
            中断
          </button>
        ) : (
          <button
            onClick={onSend}
            disabled={!canSend}
            className="h-10 px-4 rounded-full bg-zinc-100 text-zinc-900 text-sm font-medium shrink-0 disabled:opacity-40"
          >
            发送
          </button>
        )}
      </div>
    </div>
  )
}
