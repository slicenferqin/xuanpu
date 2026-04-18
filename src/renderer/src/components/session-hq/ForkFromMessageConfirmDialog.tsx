import { GitFork } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { useI18n } from '@/i18n/useI18n'

interface ForkFromMessageConfirmDialogProps {
  open: boolean
  dontShowAgain: boolean
  onDontShowAgainChange: (checked: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}

export function ForkFromMessageConfirmDialog({
  open,
  dontShowAgain,
  onDontShowAgainChange,
  onCancel,
  onConfirm
}: ForkFromMessageConfirmDialogProps): React.JSX.Element {
  const { t } = useI18n()

  return (
    <AlertDialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <AlertDialogContent size="default">
        <AlertDialogHeader>
          <AlertDialogMedia>
            <GitFork className="h-7 w-7 text-muted-foreground" />
          </AlertDialogMedia>
          <AlertDialogTitle>{t('dialogs.forkFromMessage.title')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4">
              <p>{t('dialogs.forkFromMessage.description')}</p>
              <label className="flex items-center gap-3 text-left">
                <Checkbox
                  checked={dontShowAgain}
                  onCheckedChange={(checked) => onDontShowAgainChange(checked === true)}
                />
                <span className="text-foreground">{t('dialogs.forkFromMessage.dismiss')}</span>
              </label>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>
            {t('dialogs.forkFromMessage.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t('dialogs.forkFromMessage.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
