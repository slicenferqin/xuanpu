import { useState, useCallback } from 'react'
import { Figma, Ticket, AlertCircle, Plus, Check } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { parseAttachmentUrl } from '@/lib/attachment-utils'
import type { AttachmentInfo } from '@/lib/attachment-utils'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n/useI18n'

interface AddAttachmentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  worktreeId: string
  onAttachmentAdded: () => void
}

export function AddAttachmentDialog({
  open,
  onOpenChange,
  worktreeId,
  onAttachmentAdded
}: AddAttachmentDialogProps): React.JSX.Element {
  const { t } = useI18n()
  const [url, setUrl] = useState('')
  const [detected, setDetected] = useState<AttachmentInfo | null>(null)
  const [isAdding, setIsAdding] = useState(false)

  const handleUrlChange = useCallback((value: string): void => {
    setUrl(value)
    if (value.trim()) {
      setDetected(parseAttachmentUrl(value.trim()))
    } else {
      setDetected(null)
    }
  }, [])

  const handleAdd = useCallback(async (): Promise<void> => {
    if (!detected) return
    setIsAdding(true)
    try {
      const result = await window.db.worktree.addAttachment(worktreeId, {
        type: detected.type,
        url: url.trim(),
        label: detected.label
      })
      if (result.success) {
        toast.success(
          t('dialogs.addAttachment.toasts.added', {
            type: t(
              detected.type === 'jira'
                ? 'dialogs.addAttachment.detected.jira'
                : 'dialogs.addAttachment.detected.figma'
            ),
            label: detected.label
          })
        )
        onAttachmentAdded()
        onOpenChange(false)
        setUrl('')
        setDetected(null)
      } else {
        toast.error(result.error || t('dialogs.addAttachment.toasts.addError'))
      }
    } finally {
      setIsAdding(false)
    }
  }, [detected, url, worktreeId, onAttachmentAdded, onOpenChange, t])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.key === 'Enter' && detected && !isAdding) {
        handleAdd()
      }
    },
    [detected, isAdding, handleAdd]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('dialogs.addAttachment.title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            placeholder={t('dialogs.addAttachment.placeholder')}
            value={url}
            onChange={(e) => handleUrlChange(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          {url.trim() && (
            <div className="flex items-center gap-2 text-sm">
              {detected ? (
                <>
                  <Check className="h-4 w-4 text-green-500" />
                  {detected.type === 'jira' ? (
                    <Ticket className="h-4 w-4 text-blue-500" />
                  ) : (
                    <Figma className="h-4 w-4 text-purple-500" />
                  )}
                  <span className="text-muted-foreground">
                    {t(
                      detected.type === 'jira'
                        ? 'dialogs.addAttachment.detected.jira'
                        : 'dialogs.addAttachment.detected.figma'
                    )}
                    : <span className="text-foreground font-medium">{detected.label}</span>
                  </span>
                </>
              ) : (
                <>
                  <AlertCircle className="h-4 w-4 text-destructive" />
                  <span className="text-destructive">
                    {t('dialogs.addAttachment.unsupportedUrl')}
                  </span>
                </>
              )}
            </div>
          )}
          <div className="flex justify-end">
            <Button size="sm" disabled={!detected || isAdding} onClick={handleAdd}>
              <Plus className="h-4 w-4 mr-1" />
              {t('dialogs.addAttachment.confirm')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
