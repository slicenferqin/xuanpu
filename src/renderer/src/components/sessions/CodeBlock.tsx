import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import Ansi from 'ansi-to-react'
import { containsAnsi, stripAnsi } from '@/lib/ansi-utils'
import { useI18n } from '@/i18n/useI18n'

interface CodeBlockProps {
  code: string
  language?: string
}

export function CodeBlock({ code, language = 'typescript' }: CodeBlockProps): React.JSX.Element {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

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
      className="relative group my-4 rounded-lg overflow-hidden border border-border/60 bg-muted/50"
      data-testid="code-block"
    >
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-border/50 bg-muted/70">
        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{language}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="h-7 px-2 opacity-0 group-hover:opacity-100 transition-opacity"
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
      <pre className="p-4 overflow-x-auto text-sm font-mono text-foreground/90">
        <code>{containsAnsi(code) ? <Ansi>{code}</Ansi> : code}</code>
      </pre>
    </div>
  )
}
