import { Fragment, useEffect, useRef, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import Ansi from 'ansi-to-react'
import { containsAnsi, stripAnsi } from '@/lib/ansi-utils'
import { useI18n } from '@/i18n/useI18n'
import { cn } from '@/lib/utils'

interface CodeBlockProps {
  code: string
  language?: string
}

const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh', 'fish', 'console', 'terminal'])

function isShellLanguage(language: string): boolean {
  return SHELL_LANGUAGES.has(language.trim().toLowerCase())
}

function renderShellRemainder(remainder: string): React.ReactNode {
  const commentStart = remainder.search(/\s#/)

  if (commentStart === -1) {
    return remainder
  }

  return (
    <>
      {remainder.slice(0, commentStart)}
      <span className="text-[var(--code-block-muted)]">{remainder.slice(commentStart)}</span>
    </>
  )
}

function renderShellLine(line: string): React.ReactNode {
  const trimmedStart = line.trimStart()

  if (trimmedStart.length === 0) {
    return line
  }

  const leadingWhitespace = line.slice(0, line.length - trimmedStart.length)

  if (trimmedStart.startsWith('#')) {
    return (
      <>
        {leadingWhitespace}
        <span className="text-[var(--code-block-muted)]">{trimmedStart}</span>
      </>
    )
  }

  const promptMatch = trimmedStart.match(/^([$#>%❯➜])(\s+)/)
  const prompt = promptMatch ? `${promptMatch[1]}${promptMatch[2]}` : ''
  const rest = prompt ? trimmedStart.slice(prompt.length) : trimmedStart
  const commandMatch = rest.match(
    /^((?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:sudo\s+|env\s+|command\s+|builtin\s+|time\s+)*)([./~A-Za-z0-9_:@%+-][^\s;&|()]*)/
  )

  if (!commandMatch) {
    return line
  }

  const modifiers = commandMatch[1] ?? ''
  const command = commandMatch[2] ?? ''
  const remainder = rest.slice(commandMatch[0].length)

  return (
    <>
      {leadingWhitespace}
      {prompt && <span className="text-[var(--code-block-warm)]">{prompt}</span>}
      {modifiers && <span className="text-[var(--code-block-muted)]">{modifiers}</span>}
      <span className="font-semibold text-[var(--code-block-accent)]">{command}</span>
      {renderShellRemainder(remainder)}
    </>
  )
}

function renderShellCode(code: string): React.ReactNode {
  const lines = code.split('\n')

  return lines.map((line, index) => (
    <Fragment key={`${index}-${line}`}>
      {renderShellLine(line)}
      {index < lines.length - 1 ? '\n' : null}
    </Fragment>
  ))
}

function renderCodeContent(code: string, language: string): React.ReactNode {
  if (containsAnsi(code)) {
    return <Ansi>{code}</Ansi>
  }

  if (isShellLanguage(language)) {
    return renderShellCode(code)
  }

  return code
}

export function CodeBlock({ code, language = 'typescript' }: CodeBlockProps): React.JSX.Element {
  const { t } = useI18n()
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [isOverflowing, setIsOverflowing] = useState(false)

  useEffect(() => {
    setExpanded(false)
  }, [code, language])

  useEffect(() => {
    const node = preRef.current
    if (!node) return

    const updateOverflow = (): void => {
      setIsOverflowing(node.scrollHeight > 322)
    }

    updateOverflow()

    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateOverflow)
    resizeObserver?.observe(node)
    window.addEventListener('resize', updateOverflow)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateOverflow)
    }
  }, [code, language, expanded])

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(stripAnsi(code))
      setCopied(true)
      toast.success(t('codeBlock.toasts.copied'))
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t('codeBlock.toasts.copyError'))
    }
  }

  return (
    <div
      className="group relative my-4 overflow-hidden rounded-[10px] border border-[color:var(--code-block-border)] bg-[var(--code-block-bg)] shadow-[0_1px_3px_0_rgb(var(--agent-shadow-rgb)_/_0.10)]"
      data-testid="code-block"
    >
      <div className="flex items-center justify-between border-b border-[color:var(--code-block-border)] bg-[var(--code-block-header)] px-4 py-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-tech-blue">
          {language}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="h-7 px-2 text-[var(--code-block-muted)] opacity-0 transition-opacity hover:bg-white/10 hover:text-[var(--code-block-text)] group-hover:opacity-100"
          aria-label={t('codeBlock.copyButton')}
          data-testid="copy-code-button"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      <pre
        ref={preRef}
        className={cn(
          'overflow-x-auto p-4 font-mono text-sm leading-relaxed text-[var(--code-block-text)]',
          isOverflowing && !expanded ? 'max-h-[320px] overflow-y-hidden' : 'overflow-y-auto'
        )}
      >
        <code>{renderCodeContent(code, language)}</code>
      </pre>
      {isOverflowing && !expanded && (
        <div
          className="pointer-events-none absolute bottom-0 left-0 right-0 h-16"
          style={{
            background:
              'linear-gradient(to top, var(--code-block-bg), color-mix(in srgb, var(--code-block-bg) 92%, transparent), transparent)'
          }}
        />
      )}
      {isOverflowing && (
        <button
          type="button"
          className="absolute bottom-2 right-3 z-10 rounded-full border border-white/10 bg-[var(--code-block-header)] px-2.5 py-1 text-[11px] font-medium text-[var(--code-block-text)] shadow-sm transition-colors hover:border-tech-blue/55 hover:bg-white/10 hover:text-[var(--code-block-text)]"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t('codeBlock.collapse') : t('codeBlock.expand')}
        </button>
      )}
    </div>
  )
}
