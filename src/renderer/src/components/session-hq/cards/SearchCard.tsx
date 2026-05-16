/**
 * SearchCard — Renders a grep/glob/search action.
 */

import React from 'react'
import { ActionCard } from './ActionCard'
import type { ToolUseInfo } from '@shared/lib/timeline-types'
import { useI18n } from '@/i18n/useI18n'

interface SearchCardProps {
  toolUse: ToolUseInfo
}

export function SearchCard({ toolUse }: SearchCardProps): React.JSX.Element {
  const { t } = useI18n()
  const pattern = (toolUse.input?.pattern as string) ?? (toolUse.input?.query as string) ?? ''
  const path = (toolUse.input?.path as string) ?? ''
  const resultCount = toolUse.output
    ? toolUse.output.split('\n').filter((l) => l.trim()).length
    : undefined

  return (
    <ActionCard
      headerLeft={
        <div className="flex items-center gap-2">
          <span className="font-semibold text-foreground">{t('sessionHq.cards.search.title')}</span>
          <span className="font-mono text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full border border-border">
            {toolUse.name}
          </span>
        </div>
      }
      headerRight={
        resultCount
          ? t('sessionHq.cards.search.resultCount', {
              count: resultCount,
              label:
                resultCount === 1
                  ? t('sessionHq.cards.search.resultSingular')
                  : t('sessionHq.cards.search.resultPlural')
            })
          : undefined
      }
    >
      <div className="font-mono text-xs">
        <span className="text-blue-500">{t('sessionHq.cards.search.query')}</span>{' '}
        <span className="text-foreground">{pattern}</span>
        {path && (
          <>
            {' '}
            <span className="text-muted-foreground">{t('toolViews.grep.in')}</span>{' '}
            <span className="text-foreground">{path}</span>
          </>
        )}
      </div>
    </ActionCard>
  )
}
