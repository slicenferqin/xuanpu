import Ansi from 'ansi-to-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { containsAnsi } from '@/lib/ansi-utils'
import { CodeBlock } from './CodeBlock'
import type { Components } from 'react-markdown'

interface MarkdownRendererProps {
  content: string
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="crisp-strong-title text-xl font-bold mt-6 mb-3 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="crisp-strong-title text-lg font-semibold mt-5 mb-2 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="crisp-strong-title text-base font-semibold mt-4 mb-2 first:mt-0">
      {children}
    </h3>
  ),
  p: ({ children }) => <p className="mb-3.5 last:mb-0 leading-[1.72]">{children}</p>,
  ul: ({ children }) => (
    <ul className="list-disc pl-6 mb-3.5 space-y-2 marker:text-steel/70">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-6 mb-3.5 space-y-2 marker:text-steel/70">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-[1.72]">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3.5 border-l-2 border-steel/25 pl-4 leading-[1.72] italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-3">
      <table className="min-w-full border border-border text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted px-3 py-1.5 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-border px-3 py-1.5">{children}</td>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary hover:text-neon-violet underline underline-offset-2"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-border" />,
  strong: ({ children }) => <strong className="font-bold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  code: ({ className, children }) => {
    const match = /language-(\w+)/.exec(className || '')
    const content = String(children)
    const isBlock = match !== null || content.includes('\n')

    if (isBlock) {
      const code = content.replace(/\n$/, '')
      return <CodeBlock code={code} language={match?.[1] ?? 'text'} />
    }

    return (
      <code className="rounded border border-border/70 bg-agent-card-muted px-1.5 py-0.5 font-mono text-sm text-ink">
        {children}
      </code>
    )
  },
  pre: ({ children }) => <>{children}</>
}

export function MarkdownRenderer({ content }: MarkdownRendererProps): React.JSX.Element {
  if (containsAnsi(content)) {
    return (
      <div className="whitespace-pre-wrap text-sm font-mono">
        <Ansi>{content}</Ansi>
      </div>
    )
  }

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  )
}
