/**
 * BashCard — Renders a terminal command execution action.
 */

import React, { useState } from 'react'
import { ActionCard } from './ActionCard'
import { Check, X, Loader2, Sparkles, FileText } from 'lucide-react'
import type { ToolUseInfo } from '@shared/lib/timeline-types'
import { extractCommandText } from '@/lib/tool-input-utils'
import {
  formatBytes,
  parseTokenSaverFooter,
  type ParsedTokenSaverFooter
} from '@/lib/token-saver-footer'
import { useI18n } from '@/i18n/useI18n'

interface BashCardProps {
  toolUse: ToolUseInfo
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

function TokenSaverBadge({ parsed }: { parsed: ParsedTokenSaverFooter }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-700 dark:text-emerald-200"
      data-testid="token-saver-badge"
    >
      <Sparkles className="h-3.5 w-3.5 text-emerald-500" />
      <span className="font-semibold">
        {t('toolViews.tokenSaver.savedBadge', {
          percent: parsed.savedPercent,
          before: formatBytes(parsed.beforeBytes),
          after: formatBytes(parsed.afterBytes)
        })}
      </span>
      <span className="text-emerald-700/70 dark:text-emerald-300/70">
        {t('toolViews.tokenSaver.viaRules', { rules: parsed.rules.join(', ') })}
      </span>
    </div>
  )
}

function OriginalOutputButton({ archivePath }: { archivePath: string }): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = async (): Promise<void> => {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : t('toolViews.tokenSaver.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mt-2 border-t border-border/50 pt-2">
      <button
        type="button"
        onClick={() => void toggle()}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 transition-colors hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
        data-testid="token-saver-show-original"
      >
        <FileText className="h-3.5 w-3.5" />
        {open ? t('toolViews.tokenSaver.hideOriginal') : t('toolViews.tokenSaver.showOriginal')}
      </button>
      {open && (
        <div className="mt-2">
          {loading && (
            <div className="text-xs text-muted-foreground">
              {t('toolViews.tokenSaver.loadingOriginal')}
            </div>
          )}
          {error && <div className="text-xs text-red-500">{error}</div>}
          {content !== null && (
            <pre className="mt-1 max-h-80 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-zinc-950/80 p-2 font-mono text-[11px] text-zinc-300">
              {content}
            </pre>
          )}
          <div className="mt-1 break-all text-[10px] text-muted-foreground">
            {t('toolViews.tokenSaver.archivedAt', { path: archivePath })}
          </div>
        </div>
      )}
    </div>
  )
}

export function BashCard({ toolUse }: BashCardProps): React.JSX.Element {
  const { t } = useI18n()
  const command = extractCommandText(toolUse.input) || toolUse.name
  const description =
    typeof toolUse.input?.description === 'string' ? toolUse.input.description.trim() : ''
  const isSuccess = toolUse.status === 'success'
  const isError = toolUse.status === 'error'
  const isRunning = toolUse.status === 'running' || toolUse.status === 'pending'
  const parsed = parseTokenSaverFooter(toolUse.output)
  const renderedOutput = parsed ? parsed.body : toolUse.output
  const cleanOutput = renderedOutput ? stripAnsi(renderedOutput) : ''
  const hasBody = Boolean(description || parsed || cleanOutput || toolUse.error)

  return (
    <ActionCard
      headerLeft={
        <div className="flex items-center gap-2 font-mono text-xs min-w-0">
          <span className="text-celadon font-semibold shrink-0">$_</span>
          <span className="truncate text-foreground">{command}</span>
        </div>
      }
      headerRight={
        <div className="flex items-center gap-1.5">
          {isSuccess && <Check className="h-3.5 w-3.5 text-celadon" />}
          {isError && <X className="h-3.5 w-3.5 text-red-500" />}
          {isRunning && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          <span>
            {isRunning
              ? t('sessionHq.cards.bash.running')
              : isError
                ? t('sessionHq.cards.bash.error')
                : t('sessionHq.cards.bash.exitZero')}
          </span>
          {parsed && (
            <span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
              {t('sessionHq.cards.bash.tokenSaverCompact', { percent: parsed.savedPercent })}
            </span>
          )}
        </div>
      }
      defaultExpanded={isError || !!parsed}
    >
      {hasBody && (
        <>
          {description && (
            <div className="mb-2 font-mono text-[11px] text-muted-foreground"># {description}</div>
          )}
          {parsed && <TokenSaverBadge parsed={parsed} />}
          {cleanOutput && (
            <pre className="max-h-[220px] overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
              {cleanOutput.length > 2000
                ? `${cleanOutput.slice(0, 2000)}\n${t('sessionHq.cards.bash.truncated')}`
                : cleanOutput}
            </pre>
          )}
          {toolUse.error && (
            <pre className="max-h-[220px] overflow-y-auto whitespace-pre-wrap break-all font-mono text-xs text-red-400">
              {toolUse.error}
            </pre>
          )}
          {parsed?.archivePath && <OriginalOutputButton archivePath={parsed.archivePath} />}
        </>
      )}
    </ActionCard>
  )
}
