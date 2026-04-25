/**
 * ToolCards: per-tool render variants for `tool_use` parts.
 *
 * Mobile mirrors the desktop's per-tool views (`src/renderer/.../tools/*`) at
 * a much lower fidelity — just enough so the user can tell at a glance what
 * the agent is doing without expanding raw JSON.
 *
 * Picking is by `tool.name`. Unknown tools fall back to a generic chip that
 * matches the prior behavior, so adding new claude tools never breaks the UI.
 */

import { useState } from 'react'

interface ToolCardProps {
  name: string
  input?: unknown
  output?: unknown
  pending: boolean
  isError?: boolean
}

export function ToolCard(props: ToolCardProps): React.JSX.Element {
  const Variant = pickVariant(props.name)
  // Render via JSX, NOT direct call — calling `Variant(props)` makes any
  // useState inside the variant share the parent ToolCard's hooks slot, and
  // since pickVariant returns different components for different tools,
  // alternating tools across messages corrupts hook order and crashes the
  // tree (manifests as a blank screen on mobile).
  return <Variant {...props} />
}

function pickVariant(
  name: string
): (p: ToolCardProps) => React.JSX.Element {
  switch (name) {
    case 'Bash':
      return BashCard
    case 'Read':
      return ReadCard
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return FileWriteCard
    case 'Grep':
    case 'Glob':
      return SearchCard
    case 'TodoWrite':
      return TodoCard
    case 'WebFetch':
    case 'WebSearch':
      return WebCard
    case 'Task':
      return TaskCard
    default:
      return GenericCard
  }
}

// ─── Specialised variants ──────────────────────────────────────────────────

function BashCard(p: ToolCardProps): React.JSX.Element {
  const cmd = stringField(p.input, 'command') ?? ''
  const desc = stringField(p.input, 'description')
  const out = renderOutput(p.output)
  return (
    <Card icon="$" label="bash" pending={p.pending} isError={p.isError}>
      {desc && <p className="text-xs text-zinc-400 mb-1">{desc}</p>}
      <pre className="text-xs font-mono text-zinc-200 whitespace-pre-wrap break-all">
        {cmd || '(no command)'}
      </pre>
      {out && (
        <pre className="mt-2 text-xs font-mono text-zinc-400 whitespace-pre-wrap break-words max-h-64 overflow-auto">
          {out}
        </pre>
      )}
    </Card>
  )
}

function ReadCard(p: ToolCardProps): React.JSX.Element {
  const file = stringField(p.input, 'file_path') ?? stringField(p.input, 'filePath') ?? ''
  const offset = numberField(p.input, 'offset')
  const limit = numberField(p.input, 'limit')
  const range = offset && limit ? ` :${offset}-${offset + limit}` : ''
  return (
    <Card icon="◧" label="read" pending={p.pending} isError={p.isError}>
      <p className="text-sm font-mono break-all">{file}{range}</p>
    </Card>
  )
}

function FileWriteCard(p: ToolCardProps): React.JSX.Element {
  const file = stringField(p.input, 'file_path') ?? stringField(p.input, 'filePath') ?? ''
  const oldStr = stringField(p.input, 'old_string')
  const newStr = stringField(p.input, 'new_string')
  const content = stringField(p.input, 'content')
  return (
    <Card icon="✎" label={p.name.toLowerCase()} pending={p.pending} isError={p.isError}>
      <p className="text-sm font-mono break-all mb-1">{file}</p>
      {oldStr !== undefined && newStr !== undefined ? (
        <DiffPreview oldStr={oldStr} newStr={newStr} />
      ) : content !== undefined ? (
        <pre className="text-xs font-mono text-emerald-300 whitespace-pre-wrap max-h-48 overflow-auto">
          {content.slice(0, 800)}
          {content.length > 800 && '\n…'}
        </pre>
      ) : null}
    </Card>
  )
}

function SearchCard(p: ToolCardProps): React.JSX.Element {
  const pattern = stringField(p.input, 'pattern') ?? ''
  const path = stringField(p.input, 'path')
  const matches = countMatches(p.output)
  return (
    <Card icon="⌕" label={p.name.toLowerCase()} pending={p.pending} isError={p.isError}>
      <p className="text-sm font-mono break-all">{pattern}</p>
      {path && <p className="text-xs text-zinc-500 mt-0.5 break-all">in {path}</p>}
      {matches !== null && (
        <p className="text-xs text-zinc-400 mt-1">{matches} 个结果</p>
      )}
    </Card>
  )
}

function TodoCard(p: ToolCardProps): React.JSX.Element {
  const todos = arrayField(p.input, 'todos')
  return (
    <Card icon="✓" label="todos" pending={p.pending} isError={p.isError}>
      {todos && todos.length > 0 ? (
        <ul className="space-y-1">
          {todos.map((todo, i) => {
            const status = stringField(todo, 'status') ?? 'pending'
            const content = stringField(todo, 'content') ?? ''
            const mark =
              status === 'completed' ? '✓' : status === 'in_progress' ? '◐' : '○'
            const cls =
              status === 'completed'
                ? 'text-zinc-500 line-through'
                : status === 'in_progress'
                  ? 'text-amber-300'
                  : 'text-zinc-200'
            return (
              <li key={i} className={'text-sm flex gap-2 ' + cls}>
                <span className="font-mono">{mark}</span>
                <span className="flex-1 break-words">{content}</span>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500">(empty)</p>
      )}
    </Card>
  )
}

function WebCard(p: ToolCardProps): React.JSX.Element {
  const url = stringField(p.input, 'url') ?? stringField(p.input, 'query') ?? ''
  return (
    <Card icon="◎" label={p.name.toLowerCase()} pending={p.pending} isError={p.isError}>
      <p className="text-sm break-all">{url}</p>
    </Card>
  )
}

function TaskCard(p: ToolCardProps): React.JSX.Element {
  const desc = stringField(p.input, 'description') ?? ''
  const subagent = stringField(p.input, 'subagent_type')
  return (
    <Card icon="⊕" label="task" pending={p.pending} isError={p.isError}>
      <p className="text-sm">{desc}</p>
      {subagent && (
        <p className="text-xs text-zinc-500 mt-0.5">→ {subagent}</p>
      )}
    </Card>
  )
}

function GenericCard(p: ToolCardProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <button
      onClick={() => setOpen((v) => !v)}
      className={
        'w-full text-left px-3 py-2 rounded-lg border active:bg-zinc-800 ' +
        (p.isError
          ? 'bg-red-950/30 border-red-900/60'
          : 'bg-zinc-900 border-zinc-800')
      }
    >
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-zinc-500">tool</span>
        <span className="text-sm font-mono">{p.name}</span>
        {p.pending && <span className="ml-auto text-xs text-amber-400">运行中…</span>}
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          {p.input !== undefined && (
            <pre className="text-xs font-mono text-zinc-300 whitespace-pre-wrap break-words">
              {safeStringify(p.input)}
            </pre>
          )}
          {p.output !== undefined && (
            <pre className="text-xs font-mono text-zinc-400 whitespace-pre-wrap break-words border-t border-zinc-800 pt-2">
              {safeStringify(p.output)}
            </pre>
          )}
        </div>
      )}
    </button>
  )
}

// ─── Card chrome + helpers ─────────────────────────────────────────────────

function Card({
  icon,
  label,
  pending,
  isError,
  children
}: {
  icon: string
  label: string
  pending: boolean
  isError?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={
        'px-3 py-2 rounded-lg border ' +
        (isError
          ? 'bg-red-950/30 border-red-900/60'
          : 'bg-zinc-900 border-zinc-800')
      }
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-mono text-zinc-500 w-4 text-center">{icon}</span>
        <span className="text-xs uppercase tracking-wider text-zinc-500">{label}</span>
        {pending && <span className="ml-auto text-xs text-amber-400">运行中…</span>}
        {!pending && isError && (
          <span className="ml-auto text-xs text-red-400">失败</span>
        )}
      </div>
      <div>{children}</div>
    </div>
  )
}

function DiffPreview({
  oldStr,
  newStr
}: {
  oldStr: string
  newStr: string
}): React.JSX.Element {
  return (
    <div className="text-xs font-mono space-y-0.5 max-h-48 overflow-auto">
      {oldStr.split('\n').slice(0, 8).map((line, i) => (
        <div key={'o' + i} className="text-red-300/80">- {line}</div>
      ))}
      {newStr.split('\n').slice(0, 8).map((line, i) => (
        <div key={'n' + i} className="text-emerald-300/80">+ {line}</div>
      ))}
      {(oldStr.split('\n').length > 8 || newStr.split('\n').length > 8) && (
        <div className="text-zinc-500">…</div>
      )}
    </div>
  )
}

function stringField(v: unknown, key: string): string | undefined {
  if (v && typeof v === 'object' && key in v) {
    const x = (v as Record<string, unknown>)[key]
    if (typeof x === 'string') return x
  }
  return undefined
}

function numberField(v: unknown, key: string): number | undefined {
  if (v && typeof v === 'object' && key in v) {
    const x = (v as Record<string, unknown>)[key]
    if (typeof x === 'number') return x
  }
  return undefined
}

function arrayField(v: unknown, key: string): unknown[] | undefined {
  if (v && typeof v === 'object' && key in v) {
    const x = (v as Record<string, unknown>)[key]
    if (Array.isArray(x)) return x
  }
  return undefined
}

function renderOutput(out: unknown): string | null {
  if (out === undefined || out === null) return null
  if (typeof out === 'string') return out.length > 1500 ? out.slice(0, 1500) + '\n…' : out
  return safeStringify(out)
}

function countMatches(out: unknown): number | null {
  if (typeof out === 'string') {
    if (out.length === 0) return 0
    return out.split('\n').filter(Boolean).length
  }
  if (Array.isArray(out)) return out.length
  return null
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
