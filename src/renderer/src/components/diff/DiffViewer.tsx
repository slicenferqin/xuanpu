import { useEffect, useRef } from 'react'
import { Diff2HtmlUI } from 'diff2html/lib-esm/ui/js/diff2html-ui-slim'
import type { Diff2HtmlUIConfig } from 'diff2html/lib-esm/ui/js/diff2html-ui-base'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'

export type DiffViewMode = 'unified' | 'split'

interface DiffViewerProps {
  diff: string
  viewMode?: DiffViewMode
  className?: string
}

export function DiffViewer({
  diff,
  viewMode = 'unified',
  className
}: DiffViewerProps): React.JSX.Element {
  const { t } = useI18n()
  const targetRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const target = targetRef.current
    if (!target) return

    if (!diff) {
      target.innerHTML = `<div class="d2h-empty">${t('diffUi.viewer.noChanges')}</div>`
      return
    }

    const config: Diff2HtmlUIConfig = {
      drawFileList: false,
      matching: 'lines',
      outputFormat: viewMode === 'split' ? 'side-by-side' : 'line-by-line',
      renderNothingWhenEmpty: false,
      highlight: true,
      synchronisedScroll: true,
      fileListToggle: false,
      fileContentToggle: false,
      stickyFileHeaders: false
    }

    try {
      const ui = new Diff2HtmlUI(target, diff, config)
      ui.draw()
    } catch (error) {
      console.error('Failed to parse diff:', error)
      target.innerHTML = `<div class="d2h-error">${t('diffUi.viewer.parseError')}</div>`
    }

    return () => {
      target.innerHTML = ''
    }
  }, [diff, viewMode, t])

  return (
    <div
      ref={targetRef}
      className={cn('diff-viewer', className)}
      data-testid="diff-viewer"
      role="region"
      aria-label={t('diffUi.viewer.ariaLabel')}
    />
  )
}
