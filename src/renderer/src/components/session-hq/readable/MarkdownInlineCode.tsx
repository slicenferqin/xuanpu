import React from 'react'
import { cn } from '@/lib/utils'
import { classifyInlineCode, type InlineCodeKind } from './markdown-inline-code-classifier'

interface MarkdownInlineCodeProps {
  children: React.ReactNode
  className?: string
}

const KIND_CLASSES: Record<InlineCodeKind, string> = {
  symbol:
    'font-mono text-[0.88em] text-xp-md-inline-code-text bg-xp-md-inline-code-bg rounded px-1 py-0.5',
  command:
    'font-mono text-[0.88em] text-xp-md-command-text bg-xp-md-command-bg rounded px-1 py-0.5',
  path: 'font-mono text-[0.88em] text-xp-md-path-text bg-xp-md-inline-code-bg/60 rounded px-1 py-0.5',
  id: 'font-mono text-[0.85em] text-xp-md-id-text bg-xp-md-inline-code-bg/40 rounded px-0.5 py-0.5',
  metric:
    'font-mono text-[0.88em] text-xp-md-metric-value bg-xp-md-inline-code-bg/50 rounded px-1 py-0.5',
  phrase: 'text-inherit bg-xp-md-inline-code-bg/40 rounded px-1 py-0.5',
  unknown:
    'font-mono text-[0.88em] text-xp-md-inline-code-text bg-xp-md-inline-code-bg rounded px-1 py-0.5 border border-xp-md-inline-code-border/50'
}

export function MarkdownInlineCode({
  children,
  className
}: MarkdownInlineCodeProps): React.JSX.Element {
  const content = String(children)
  const kind = classifyInlineCode(content)

  return <code className={cn(KIND_CLASSES[kind], className)}>{children}</code>
}
