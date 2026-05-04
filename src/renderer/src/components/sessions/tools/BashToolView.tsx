import { useState } from 'react'
import { Terminal, ChevronDown, Sparkles, FileText } from 'lucide-react'
import { extractCommandText } from '@/lib/tool-input-utils'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'
import {
  parseTokenSaverFooter,
  formatBytes,
  type ParsedTokenSaverFooter
} from '@/lib/token-saver-footer'
import type { ToolViewProps } from './types'

const MAX_PREVIEW_LINES = 20

/** Strip basic ANSI escape codes from text */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

interface SavingsBadgeProps {
  parsed: ParsedTokenSaverFooter
}

function SavingsBadge({ parsed }: SavingsBadgeProps): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 bg-emerald-950/40 border-b border-emerald-900/30 text-[11px] text-emerald-200"
      data-testid="token-saver-badge"
    >
      <Sparkles className="h-3 w-3 text-emerald-400" />
      <span className="font-medium">
        {t('toolViews.tokenSaver.savedBadge', {
          percent: parsed.savedPercent,
          before: formatBytes(parsed.beforeBytes),
          after: formatBytes(parsed.afterBytes)
        })}
      </span>
      <span className="text-emerald-500/70">
        {t('toolViews.tokenSaver.viaRules', { rules: parsed.rules.join(', ') })}
      </span>
    </div>
  )
}

interface OriginalViewerProps {
  archivePath: string
}

function OriginalViewer({ archivePath }: OriginalViewerProps): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onToggle = async (): Promise<void> => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (content !== null) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.fileOps.readArchive(archivePath)
      if (result.success && result.content !== undefined) {
        setContent(result.content)
      } else {
        setError(result.error ?? t('toolViews.tokenSaver.loadFailed'))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('toolViews.tokenSaver.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mt-2 border-t border-zinc-800 pt-2">
      <button
        type="button"
        onClick={() => void onToggle()}
        className="flex items-center gap-1.5 text-blue-400 hover:text-blue-300 text-xs font-medium transition-colors"
        data-testid="token-saver-show-original"
      >
        <FileText className="h-3 w-3" />
        {open
          ? t('toolViews.tokenSaver.hideOriginal')
          : t('toolViews.tokenSaver.showOriginal')}
      </button>
      {open && (
        <div className="mt-2">
          {loading && (
            <div className="text-xs text-zinc-500">
              {t('toolViews.tokenSaver.loadingOriginal')}
            </div>
          )}
          {error && (
            <div className="text-xs text-red-400">{error}</div>
          )}
          {content !== null && (
            <pre className="mt-1 text-[11px] text-zinc-400 whitespace-pre-wrap break-all max-h-80 overflow-y-auto bg-zinc-900/50 rounded p-2">
              {content}
            </pre>
          )}
          <div className="mt-1 text-[10px] text-zinc-600 break-all">
            {t('toolViews.tokenSaver.archivedAt', { path: archivePath })}
          </div>
        </div>
      )}
    </div>
  )
}

export function BashToolView({ input, output, error }: ToolViewProps): React.JSX.Element {
  const { t } = useI18n()
  const [showAll, setShowAll] = useState(false)

  const command = extractCommandText(input)
  const description = (input.description || '') as string

  // Token Saver: when output came through mcp__xuanpu__bash it ends with our
  // synthetic footer. Parse it to surface savings + archive path. Falls back
  // gracefully to plain rendering for unsaved output (e.g. when the toggle is
  // off, or the run is too small to compress).
  const parsed = parseTokenSaverFooter(output)
  const renderedOutput = parsed ? parsed.body : output ?? ''

  const cleanOutput = renderedOutput ? stripAnsi(renderedOutput) : ''
  const lines = cleanOutput ? cleanOutput.split('\n') : []
  const needsTruncation = lines.length > MAX_PREVIEW_LINES
  const displayedOutput = showAll
    ? cleanOutput
    : lines.slice(0, MAX_PREVIEW_LINES).join('\n')

  return (
    <div data-testid="bash-tool-view">
      <div className="bg-zinc-900 rounded-t-md px-3 py-2 font-mono text-xs">
        {description && <div className="text-zinc-500 mb-1 text-[10px]"># {description}</div>}
        <div className="flex items-start gap-1.5">
          <Terminal className="h-3.5 w-3.5 text-zinc-500 mt-0.5 shrink-0" />
          <span className="text-green-400 select-none shrink-0">$</span>
          <span className="text-zinc-200 whitespace-pre-wrap break-all">{command}</span>
        </div>
      </div>

      {parsed && <SavingsBadge parsed={parsed} />}

      {(cleanOutput || error) && (
        <div
          className={cn(
            'bg-zinc-950 px-3 py-2 font-mono text-xs border-t border-zinc-800',
            'rounded-b-md'
          )}
        >
          {error && <div className="text-red-400 whitespace-pre-wrap break-all mb-1">{error}</div>}
          {cleanOutput && (
            <>
              <pre className="text-zinc-400 whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
                {displayedOutput}
              </pre>
              {needsTruncation && (
                <button
                  onClick={() => setShowAll(!showAll)}
                  className="flex items-center gap-1 mt-2 text-blue-400 hover:text-blue-300 text-xs font-medium transition-colors"
                  data-testid="show-all-button"
                >
                  <ChevronDown
                    className={cn(
                      'h-3 w-3 transition-transform duration-150',
                      showAll && 'rotate-180'
                    )}
                  />
                  {showAll
                    ? t('toolViews.common.showLess')
                    : t('toolViews.common.showAllLines', { count: lines.length })}
                </button>
              )}
              {parsed && parsed.archivePath && (
                <OriginalViewer archivePath={parsed.archivePath} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
