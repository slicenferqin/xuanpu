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

interface UnsavedChangesDialogProps {
  open: boolean
  fileName: string
  onSave: () => void
  onDontSave: () => void
  onCancel: () => void
}

export function UnsavedChangesDialog({
  open,
  fileName,
  onSave,
  onDontSave,
  onCancel
}: UnsavedChangesDialogProps): React.JSX.Element {
  const { t } = useI18n()

  return (
    <AlertDialog open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('fileViewer.unsavedChanges.title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('fileViewer.unsavedChanges.description', { fileName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction variant="destructive" onClick={onDontSave}>
            {t('fileViewer.unsavedChanges.dontSave')}
          </AlertDialogAction>
          <AlertDialogCancel onClick={onCancel}>
            {t('fileViewer.unsavedChanges.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction onClick={onSave}>
            {t('fileViewer.unsavedChanges.save')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
