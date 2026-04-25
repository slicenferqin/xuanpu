/**
 * Featherweight markdown-ish renderer — handles fenced code blocks, inline
 * `code`, **bold**, and preserves newlines. Avoids pulling in
 * react-markdown to keep the mobile bundle lean.
 *
 * Output is plain React nodes; no dangerouslySetInnerHTML.
 */

import React from 'react'

const FENCE_RE = /```([\w+-]*)\n([\s\S]*?)```/g

interface Block {
  kind: 'code' | 'text'
  lang?: string
  body: string
}

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let last = 0
  for (const m of text.matchAll(FENCE_RE)) {
    if (m.index! > last) {
      blocks.push({ kind: 'text', body: text.slice(last, m.index!) })
    }
    blocks.push({ kind: 'code', lang: m[1] || undefined, body: m[2]! })
    last = m.index! + m[0].length
  }
  if (last < text.length) blocks.push({ kind: 'text', body: text.slice(last) })
  return blocks
}

const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*)/g

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index! > last) out.push(text.slice(last, m.index!))
    const token = m[1]!
    if (token.startsWith('`')) {
      out.push(
        <code
          key={`${keyPrefix}-${i++}`}
          className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-200 text-[0.95em] font-mono"
        >
          {token.slice(1, -1)}
        </code>
      )
    } else {
      out.push(
        <strong key={`${keyPrefix}-${i++}`} className="font-semibold">
          {token.slice(2, -2)}
        </strong>
      )
    }
    last = m.index! + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function MiniMarkdown({ text }: { text: string }): React.JSX.Element {
  const blocks = splitBlocks(text)
  return (
    <div className="space-y-2">
      {blocks.map((b, i) =>
        b.kind === 'code' ? (
          <pre
            key={i}
            className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 overflow-x-auto"
          >
            <code className="text-xs font-mono text-zinc-200 whitespace-pre">
              {b.body}
            </code>
          </pre>
        ) : (
          <p key={i} className="whitespace-pre-wrap leading-relaxed">
            {renderInline(b.body, `b${i}`)}
          </p>
        )
      )}
    </div>
  )
}
