/**
 * PlanCard — Renders an execution plan that requires user approval.
 * Uses MarkdownRenderer for rich content, collapses after approval/rejection.
 */

import React, { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n/useI18n'
import { ActionCard } from './ActionCard'
import { MarkdownRenderer } from '../../sessions/MarkdownRenderer'

interface PlanCardProps {
  content: string
  onApprove?: () => void
  onReject?: () => void
  /** Whether the plan is pending approval */
  isPending?: boolean
}

export function PlanCard({
  content,
  onApprove,
  onReject,
  isPending = false
}: PlanCardProps): React.JSX.Element {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const hasCopyableContent = content.trim().length > 0

  useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timeout)
  }, [copied])

  const handleCopy = async (event: React.MouseEvent<HTMLButtonElement>): Promise<void> => {
    event.stopPropagation()
    if (!hasCopyableContent) return

    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      toast.success(t('planCard.toasts.copied'))
    } catch {
      toast.error(t('planCard.toasts.copyError'))
    }
  }

  return (
    <ActionCard
      key={isPending ? 'pending' : 'resolved'}
      accentClass="border-purple-500"
      headerClass="bg-purple-500/10 text-purple-600 dark:text-purple-400 border-b-purple-500/20"
      headerLeft={<span className="font-semibold">{t('sessionHq.cards.plan.title')}</span>}
      headerRight={
        <div className="flex items-center gap-2">
          <span>
            {isPending
              ? t('sessionHq.cards.plan.requiresApproval')
              : t('sessionHq.cards.plan.approved')}
          </span>
          {hasCopyableContent && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 rounded-full p-0 text-muted-foreground hover:text-foreground"
              aria-label={t('planCard.copyMarkdown')}
              title={t('planCard.copyMarkdown')}
              data-testid="plan-card-copy-button"
              onClick={handleCopy}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
        </div>
      }
      defaultExpanded={isPending}
      collapsible
    >
      <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed">
        <MarkdownRenderer content={content} />
      </div>

      {isPending && (onApprove || onReject) && (
        <div className="flex justify-end gap-2 pt-3 mt-3 border-t border-border">
          {onReject && (
            <button
              onClick={onReject}
              className="px-4 py-1.5 rounded-md border border-border text-sm font-medium hover:bg-muted transition-colors"
            >
              {t('sessionHq.cards.plan.rejectModify')}
            </button>
          )}
          {onApprove && (
            <button
              onClick={onApprove}
              className="px-4 py-1.5 rounded-md bg-blue-500 text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              {t('sessionHq.cards.plan.approveStart')}
            </button>
          )}
        </div>
      )}
    </ActionCard>
  )
}
