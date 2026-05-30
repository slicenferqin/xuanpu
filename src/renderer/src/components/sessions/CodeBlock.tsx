import { Fragment, useEffect, useRef, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import Ansi from 'ansi-to-react'
import { containsAnsi, stripAnsi } from '@/lib/ansi-utils'
import { useI18n } from '@/i18n/useI18n'
import { cn } from '@/lib/utils'

export type CodeBlockVariant = 'reader' | 'terminal'

interface CodeBlockProps {
  code: string
  language?: string
  variant?: CodeBlockVariant
}

const SHELL_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh', 'fish', 'console', 'terminal'])

function isShellLanguage(language: string): boolean {
  return SHELL_LANGUAGES.has(language.trim().toLowerCase())
}

function renderShellRemainder(remainder: string, variant: CodeBlockVariant): React.ReactNode {
  const commentStart = remainder.search(/\s#/)

  if (commentStart === -1) {
    return remainder
  }

  const mutedVar = variant === 'reader' ? 'var(--xp-reader-code-muted)' : 'var(--code-block-muted)'
  return (
    <>
      {remainder.slice(0, commentStart)}
      <span style={{ color: mutedVar }}>{remainder.slice(commentStart)}</span>
    </>
  )
}

function renderShellLine(line: string, variant: CodeBlockVariant): React.ReactNode {
  const trimmedStart = line.trimStart()

  if (trimmedStart.length === 0) {
    return line
  }

  const leadingWhitespace = line.slice(0, line.length - trimmedStart.length)
  const mutedVar = variant === 'reader' ? 'var(--xp-reader-code-muted)' : 'var(--code-block-muted)'
  const warmVar = variant === 'reader' ? 'var(--xp-reader-code-warm)' : 'var(--code-block-warm)'
  const accentVar = variant === 'reader' ? 'var(--xp-reader-code-accent)' : 'var(--code-block-accent)'

  if (trimmedStart.startsWith('#')) {
    return (
      <>
        {leadingWhitespace}
        <span style={{ color: mutedVar }}>{trimmedStart}</span>
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
      {prompt && <span style={{ color: warmVar }}>{prompt}</span>}
      {modifiers && <span style={{ color: mutedVar }}>{modifiers}</span>}
      <span className="font-semibold" style={{ color: accentVar }}>{command}</span>
      {renderShellRemainder(remainder, variant)}
    </>
  )
}

function renderShellCode(code: string, variant: CodeBlockVariant): React.ReactNode {
  const lines = code.split('\n')

  return lines.map((line, index) => (
    <Fragment key={`${index}-${line}`}>
      {renderShellLine(line, variant)}
      {index < lines.length - 1 ? '\n' : null}
    </Fragment>
  ))
}

function renderCodeContent(code: string, language: string, variant: CodeBlockVariant): React.ReactNode {
  if (containsAnsi(code)) {
    return <Ansi>{code}</Ansi>
  }

  if (isShellLanguage(language)) {
    return renderShellCode(code, variant)
  }

  return code
}

export function CodeBlock({ code, language = 'typescript', variant = 'terminal' }: CodeBlockProps): React.JSX.Element {
  const { t } = useI18n()
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [isOverflowing, setIsOverflowing] = useState(false)
  const isReader = variant === 'reader'

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

  const bgVar = isReader ? 'var(--xp-reader-code-bg)' : 'var(--code-block-bg)'
  const headerVar = isReader ? 'var(--xp-reader-code-header)' : 'var(--code-block-header)'
  const borderVar = isReader ? 'var(--xp-reader-code-border)' : 'var(--code-block-border)'
  const textVar = isReader ? 'var(--xp-reader-code-text)' : 'var(--code-block-text)'
  const mutedVar = isReader ? 'var(--xp-reader-code-muted)' : 'var(--code-block-muted)'
  const accentVar = isReader ? 'var(--xp-reader-code-accent)' : 'var(--code-block-accent)'

  return (
    <div
      className={cn(
        'group relative my-4 overflow-hidden rounded-[10px] border',
        isReader ? 'shadow-none' : 'shadow-[0_1px_3px_0_rgb(var(--agent-shadow-rgb)_/_0.10)]'
      )}
      style={{
        backgroundColor: bgVar,
        borderColor: borderVar
      }}
      data-testid="code-block"
    >
      <div
        className="flex items-center justify-between border-b px-4 py-1.5"
        style={{ borderColor: borderVar, backgroundColor: headerVar }}
      >
        <span
          className="text-[11px] font-semibold uppercase tracking-[0.04em]"
          style={{ color: accentVar }}
        >
          {language}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="h-7 px-2 opacity-0 transition-opacity group-hover:opacity-100"
          style={{ color: mutedVar }}
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
          'overflow-x-auto p-4 font-mono leading-relaxed',
          isReader ? 'text-[13px]' : 'text-sm',
          isOverflowing && !expanded ? 'max-h-[320px] overflow-y-hidden' : 'overflow-y-auto'
        )}
        style={{ color: textVar }}
      >
        <code>{renderCodeContent(code, language, variant)}</code>
      </pre>
      {isOverflowing && !expanded && (
        <div
          className="pointer-events-none absolute bottom-0 left-0 right-0 h-16"
          style={{
            background:
              `linear-gradient(to top, ${bgVar}, color-mix(in srgb, ${bgVar} 92%, transparent), transparent)`
          }}
        />
      )}
      {isOverflowing && (
        <button
          type="button"
          className="absolute bottom-2 right-3 z-10 rounded-full border px-2.5 py-1 text-[11px] font-medium shadow-sm transition-colors"
          style={{
            borderColor: 'color-mix(in srgb, white 10%, transparent)',
            backgroundColor: headerVar,
            color: textVar
          }}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t('codeBlock.collapse') : t('codeBlock.expand')}
        </button>
      )}
    </div>
  )
}
