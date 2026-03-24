import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { useI18n } from '@/i18n/useI18n'

interface GitInitDialogProps {
  open: boolean
  path: string
  onCancel: () => void
  onConfirm: () => void
}

export function GitInitDialog({ open, path, onCancel, onConfirm }: GitInitDialogProps) {
  const { t } = useI18n()
  return (
    <AlertDialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('dialogs.gitInit.title')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>{t('dialogs.gitInit.selectedFolder')}</p>
              <p className="font-mono text-xs bg-muted rounded px-2 py-1 break-all">{path}</p>
              <p>{t('dialogs.gitInit.question')}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{t('dialogs.gitInit.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t('dialogs.gitInit.confirm')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
