/**
 * PinnedFactsCard — v1.4.1.
 *
 * Per-worktree textarea for user-authored permanent facts. Content is upserted
 * into `field_pinned_facts` and rendered into the Field Context on every prompt.
 *
 * Save behavior:
 *   - Auto-save 800ms after the user stops typing.
 *   - Explicit "Save" button as a fallback (and for keyboard finishers).
 *   - Cmd/Ctrl+S also saves.
 *   - Application enforces a 2000-char cap (mirrors PINNED_FACTS_MAX_CHARS in
 *     src/main/field/pinned-facts-repository.ts). Going over the cap disables
 *     save and shows an inline error; the textarea itself is not truncated so
 *     the user can edit back under cap.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Pin, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n/useI18n'

const PINNED_FACTS_MAX_CHARS = 2000
const AUTOSAVE_DEBOUNCE_MS = 800

interface PinnedFactsCardProps {
  worktreeId: string
}

export function PinnedFactsCard({ worktreeId }: PinnedFactsCardProps): React.JSX.Element {
  const { t } = useI18n()
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hasUnsavedChanges = content !== savedContent
  const isOverLimit = content.length > PINNED_FACTS_MAX_CHARS

  // Load on mount / worktree switch
  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    void (async () => {
      try {
        const record = await window.fieldOps.getPinnedFacts(worktreeId)
        if (cancelled) return
        const md = record?.contentMd ?? ''
        setContent(md)
        setSavedContent(md)
      } catch {
        if (!cancelled) toast.error(t('pinnedFacts.toasts.loadError'))
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [worktreeId, t])

  const handleSave = useCallback(async () => {
    if (isOverLimit) return
    if (!hasUnsavedChanges) return
    setIsSaving(true)
    try {
      const record = await window.fieldOps.updatePinnedFacts({
        worktreeId,
        contentMd: content
      })
      setSavedContent(record.contentMd)
    } catch {
      toast.error(t('pinnedFacts.toasts.saveError'))
    } finally {
      setIsSaving(false)
    }
  }, [worktreeId, content, hasUnsavedChanges, isOverLimit, t])

  // Autosave (debounced)
  useEffect(() => {
    if (isLoading) return
    if (!hasUnsavedChanges) return
    if (isOverLimit) return
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
    autosaveTimer.current = setTimeout(() => {
      void handleSave()
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
    }
  }, [content, isLoading, hasUnsavedChanges, isOverLimit, handleSave])

  // Cmd/Ctrl+S
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && hasUnsavedChanges && !isOverLimit) {
        e.preventDefault()
        void handleSave()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hasUnsavedChanges, isOverLimit, handleSave])

  const charCountLabel = t('pinnedFacts.charCount', {
    count: String(content.length),
    max: String(PINNED_FACTS_MAX_CHARS)
  })

  let statusLabel: string | null = null
  if (isSaving) statusLabel = t('pinnedFacts.saving')
  else if (hasUnsavedChanges) statusLabel = t('pinnedFacts.unsaved')
  else if (savedContent.length > 0) statusLabel = t('pinnedFacts.saved')

  return (
    <div className="flex flex-col border border-border rounded-md bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
        <Pin className="h-4 w-4 text-amber-400 flex-shrink-0" />
        <span className="text-sm font-bold">{t('pinnedFacts.title')}</span>
        {hasUnsavedChanges && !isSaving && (
          <span
            className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0"
            title={t('pinnedFacts.unsaved')}
          />
        )}
        <div className="flex-1" />
        {statusLabel && (
          <span className="text-xs text-muted-foreground" data-testid="pinned-facts-status">
            {statusLabel}
          </span>
        )}
      </div>

      {/* Description */}
      <p className="px-3 pt-2 text-xs text-muted-foreground">{t('pinnedFacts.description')}</p>

      {/* Textarea */}
      <div className="px-3 py-2">
        {isLoading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t('pinnedFacts.placeholder')}
            className="w-full min-h-32 resize-y bg-transparent font-mono text-sm p-2 border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
            spellCheck={false}
          />
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-3 px-3 py-2 border-t border-border bg-muted/20">
        <span
          className={`text-xs ${
            isOverLimit ? 'text-destructive font-medium' : 'text-muted-foreground'
          }`}
        >
          {charCountLabel}
        </span>
        {isOverLimit && (
          <span className="text-xs text-destructive">
            {t('pinnedFacts.overLimit', { max: String(PINNED_FACTS_MAX_CHARS) })}
          </span>
        )}
        <div className="flex-1" />
        <Button
          size="sm"
          onClick={handleSave}
          disabled={isSaving || !hasUnsavedChanges || isOverLimit || isLoading}
          className="gap-1.5"
        >
          {isSaving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {t('pinnedFacts.save')}
        </Button>
      </div>
    </div>
  )
}
