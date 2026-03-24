import { Globe, ExternalLink } from 'lucide-react'
import { useI18n } from '@/i18n/useI18n'
import type { ToolViewProps } from './types'

function formatResponseSize(
  content: string,
  t: (key: string, params?: Record<string, string | number | boolean>) => string
): string {
  const byteCount = new TextEncoder().encode(content).length

  if (byteCount < 1024) {
    return t(
      byteCount === 1 ? 'toolViews.webFetch.bytesSingular' : 'toolViews.webFetch.bytesPlural',
      { count: byteCount }
    )
  }

  if (byteCount < 1024 * 1024) {
    return t('toolViews.webFetch.kb', { value: (byteCount / 1024).toFixed(1) })
  }

  return t('toolViews.webFetch.mb', { value: (byteCount / (1024 * 1024)).toFixed(1) })
}

export function WebFetchToolView({ input, output, error }: ToolViewProps): React.JSX.Element {
  const { t } = useI18n()
  const url = (input.url || '') as string
  const prompt = (input.prompt || '') as string
  const responseSize = output ? formatResponseSize(output, t) : null

  return (
    <div className="text-xs" data-testid="webfetch-tool-view">
      {/* URL display */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-1">
        <Globe className="h-4 w-4 text-blue-400 shrink-0" />
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300 hover:underline truncate font-mono transition-colors"
          title={url}
        >
          {url}
        </a>
        <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
      </div>

      {/* Prompt */}
      {prompt && (
        <div className="px-3 pb-2 text-muted-foreground/70 truncate" title={prompt}>
          {prompt}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-3 pb-2">
          <div className="text-red-400 font-mono whitespace-pre-wrap break-all bg-red-500/10 rounded p-2">
            {error}
          </div>
        </div>
      )}

      {/* Output */}
      {output && !error && <div className="border-t border-border mx-3" />}
      {output && !error && (
        <>
          {responseSize && (
            <div
              className="px-3 pt-2 text-[10px] uppercase tracking-wide text-muted-foreground/70"
              data-testid="webfetch-response-size"
            >
              {responseSize}
            </div>
          )}
          <pre className="px-3 py-2 text-muted-foreground font-mono whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto">
            {output}
          </pre>
        </>
      )}
    </div>
  )
}
