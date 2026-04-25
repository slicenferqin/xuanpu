/**
 * MessageBubble: renders a HubMessage with role-specific styling.
 *
 *   user      → right-aligned neutral bubble
 *   assistant → left-aligned transparent, with MiniMarkdown + ToolUse chips.
 *               Within an assistant turn we render tool/diff/unknown parts
 *               FIRST and text parts AFTER, regardless of arrival order, so
 *               the conversation reads "what the agent did → what it concluded"
 *               instead of "thinking → tool → conclusion" interleaved.
 *   system    → centered faint text
 *
 * ToolUse and Unknown parts are collapsed by default (just show name + a
 * one-line preview) and open to a pretty-printed payload on tap.
 */

import { useState } from 'react'
import type { HubMessage, HubPart } from '../types/hub'
import { MiniMarkdown } from './MiniMarkdown'
import { ToolCard } from './ToolCards'

export function MessageBubble({ message }: { message: HubMessage }): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-3 py-2 rounded-2xl bg-zinc-100 text-zinc-900">
          {message.parts.map((p, i) => (
            <PartView key={i} part={p} role="user" />
          ))}
        </div>
      </div>
    )
  }
  if (message.role === 'system') {
    return (
      <div className="text-center text-xs text-zinc-500 py-1">
        {message.parts.map((p, i) => (
          <PartView key={i} part={p} role="system" />
        ))}
      </div>
    )
  }
  // Assistant: split parts into tool/action group vs text group, render
  // actions on top. We keep the original index in `key` so React doesn't
  // re-mount tool cards (and lose their open/closed local state) when a
  // streaming text delta arrives later in the same bubble.
  const actionParts: Array<{ part: HubPart; idx: number }> = []
  const textParts: Array<{ part: HubPart; idx: number }> = []
  message.parts.forEach((part, idx) => {
    if (part.type === 'text') textParts.push({ part, idx })
    else actionParts.push({ part, idx })
  })

  return (
    <div className="space-y-2">
      {actionParts.map(({ part, idx }) => (
        <PartView key={idx} part={part} role="assistant" />
      ))}
      {textParts.map(({ part, idx }) => (
        <PartView key={idx} part={part} role="assistant" />
      ))}
    </div>
  )
}

function PartView({
  part,
  role
}: {
  part: HubPart
  role: 'user' | 'assistant' | 'system'
}): React.JSX.Element {
  switch (part.type) {
    case 'text':
      return role === 'user' ? (
        <p className="whitespace-pre-wrap leading-relaxed">{part.text}</p>
      ) : (
        <MiniMarkdown text={part.text} />
      )
    case 'tool_use':
      return (
        <ToolCard
          name={part.name}
          input={part.input}
          output={part.output}
          pending={!!part.pending}
          isError={part.isError}
        />
      )
    case 'tool_result':
      return <ToolResultChip output={part.output} isError={!!part.isError} />
    case 'diff':
      return <DiffChip filePath={part.filePath} patch={part.patch} />
    case 'unknown':
      return <UnknownChip raw={part.raw} />
  }
}

function ToolResultChip({
  output,
  isError
}: {
  output?: unknown
  isError: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <button
      onClick={() => setOpen((v) => !v)}
      className={
        'w-full text-left px-3 py-2 rounded-lg border active:bg-zinc-800 ' +
        (isError
          ? 'bg-red-950/30 border-red-900/60'
          : 'bg-zinc-900 border-zinc-800')
      }
    >
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-zinc-500">
          {isError ? 'error' : 'result'}
        </span>
      </div>
      {open && output !== undefined && (
        <pre className="mt-2 text-xs font-mono text-zinc-300 whitespace-pre-wrap break-words">
          {safeStringify(output)}
        </pre>
      )}
    </button>
  )
}

function DiffChip({
  filePath,
  patch
}: {
  filePath: string
  patch: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <button
      onClick={() => setOpen((v) => !v)}
      className="w-full text-left px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 active:bg-zinc-800"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-zinc-500">diff</span>
        <span className="text-sm font-mono truncate">{filePath}</span>
      </div>
      {open && (
        <pre className="mt-2 text-xs font-mono text-zinc-300 whitespace-pre overflow-x-auto">
          {patch}
        </pre>
      )}
    </button>
  )
}

function UnknownChip({ raw }: { raw: unknown }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const preview = previewOf(raw)
  return (
    <button
      onClick={() => setOpen((v) => !v)}
      className="w-full text-left px-3 py-2 rounded-lg bg-zinc-900/60 border border-zinc-900 text-zinc-400 active:bg-zinc-800"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-zinc-600">agent activity</span>
        {preview && <span className="text-xs truncate">{preview}</span>}
      </div>
      {open && (
        <pre className="mt-2 text-xs font-mono text-zinc-400 whitespace-pre-wrap break-words">
          {safeStringify(raw)}
        </pre>
      )}
    </button>
  )
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function previewOf(v: unknown): string {
  if (v && typeof v === 'object' && 'type' in v && typeof (v as { type: unknown }).type === 'string') {
    return (v as { type: string }).type
  }
  return ''
}
