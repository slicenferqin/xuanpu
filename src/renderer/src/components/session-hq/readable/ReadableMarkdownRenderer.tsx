import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Ansi from 'ansi-to-react'
import { containsAnsi } from '@/lib/ansi-utils'
import { CodeBlock } from '@/components/sessions/CodeBlock'
import { MarkdownInlineCode } from './MarkdownInlineCode'
import type { Components } from 'react-markdown'

interface ReadableMarkdownRendererProps {
  content: string
  wide?: boolean
}

const readableComponents: Components = {
  h1: ({ children }) => (
    <h1 className="crisp-strong-title text-xl font-bold mt-7 mb-3 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="crisp-strong-title text-lg font-semibold mt-6 mb-2.5 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="crisp-strong-title text-base font-semibold mt-5 mb-2 first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="crisp-strong-title text-sm font-semibold mt-4 mb-1.5 first:mt-0">{children}</h4>
  ),
  p: ({ children }) => <p className="mb-[0.9em] last:mb-0 leading-[1.74]">{children}</p>,
  ul: ({ children }) => (
    <ul className="list-disc pl-6 mb-[0.65em] space-y-[0.45em] marker:text-xp-reader-muted">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-6 mb-[0.65em] space-y-[0.45em] marker:text-xp-reader-muted">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-[1.74]">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-[0.9em] border-l-2 border-xp-reader-border pl-4 leading-[1.74] text-xp-reader-secondary">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="xp-wide-block overflow-x-auto my-4">
      <table className="min-w-full border border-xp-reader-border text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-xp-reader-border bg-xp-reader-surface-muted px-3 py-1.5 text-left font-semibold text-xp-reader-text">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-xp-reader-border px-3 py-1.5 text-xp-reader-text">{children}</td>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xp-reader-link hover:underline underline-offset-2"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-5 border-xp-reader-border" />,
  strong: ({ children }) => (
    <strong className="font-semibold text-xp-reader-text">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ className, children }) => {
    const match = /language-(\w+)/.exec(className || '')
    const content = String(children)
    const isBlock = match !== null || content.includes('\n')

    if (isBlock) {
      const code = content.replace(/\n$/, '')
      return (
        <div className="xp-wide-block my-4">
          <CodeBlock code={code} language={match?.[1] ?? 'text'} variant="reader" />
        </div>
      )
    }

    return <MarkdownInlineCode>{children}</MarkdownInlineCode>
  },
  pre: ({ children }) => <>{children}</>
}

export function ReadableMarkdownRenderer({
  content,
  wide = false
}: ReadableMarkdownRendererProps): React.JSX.Element {
  if (containsAnsi(content)) {
    return (
      <div className="whitespace-pre-wrap text-sm font-mono">
        <Ansi>{content}</Ansi>
      </div>
    )
  }

  return (
    <div className={wide ? 'xp-wide-block' : undefined}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={readableComponents}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
