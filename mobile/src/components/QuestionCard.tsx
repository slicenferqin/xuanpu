import { useState } from 'react'
import type { SessionStream } from '../hooks/useSessionStream'

export function QuestionCard({
  stream
}: {
  stream: SessionStream
}): React.JSX.Element | null {
  const req = stream.state.question
  const [draft, setDraft] = useState('')
  if (!req) return null

  const submit = (answer: string): void => {
    if (!answer.trim()) return
    stream.respondQuestion([[answer]])
    setDraft('')
  }

  return (
    <div className="p-4 rounded-xl bg-blue-950/30 border border-blue-900/50 space-y-3">
      <div>
        <p className="text-xs uppercase tracking-wider text-blue-400 font-medium">
          问题
        </p>
        <p className="text-sm mt-1 whitespace-pre-wrap">{req.question}</p>
      </div>
      {req.options && req.options.length > 0 ? (
        <div className="grid gap-2">
          {req.options.map((opt) => (
            <button
              key={opt}
              onClick={() => submit(opt)}
              className="px-3 py-2 rounded-lg bg-zinc-800 text-sm text-left active:bg-zinc-700"
            >
              {opt}
            </button>
          ))}
          <button
            onClick={() => stream.respondQuestion([])}
            className="px-3 py-2 rounded-lg bg-zinc-900 text-sm text-zinc-400 active:bg-zinc-800"
          >
            拒绝
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="你的回答"
            className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm"
          />
          <div className="flex gap-2">
            <button
              onClick={() => submit(draft)}
              disabled={!draft.trim()}
              className="flex-1 py-2 rounded-lg bg-zinc-100 text-zinc-900 text-sm font-medium disabled:opacity-50"
            >
              回答
            </button>
            <button
              onClick={() => stream.respondQuestion([])}
              className="flex-1 py-2 rounded-lg bg-zinc-900 text-sm text-zinc-400 active:bg-zinc-800"
            >
              拒绝
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
